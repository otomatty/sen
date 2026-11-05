// スプレッドシート反映の実行。
// 保存のたびではなく、Durable Object のアラームでまとめてから書き出す。
// 反映どうしは Promise のチェーンで直列にし、同時に 2 つ走らせない。

import { isValidYmd, todayYmd } from "../../shared/dates";
import type { SheetSyncStatus, StateType } from "../../shared/types";
import { all, ensureMigrated, first } from "../db";
import type { Env, WorkspaceRow } from "../env";
import { markdownToPlainLines } from "../../shared/markdown";
import { loadStartedOn } from "../progress";
import { sheetsConfig, spreadsheetUrl } from "./config";
import { batchUpdate, getAccessToken, getSheets, parseServiceAccountKey, SheetsError } from "./google";
import { buildReport, buildSheetRequests, type ReportInput } from "./report";

const STORAGE_KEY = "sheets";
/** 1 回目のやり直しは 2 分後、2 回目は 10 分後。3 回目は入れない */
const RETRY_AFTER_MS = [2 * 60_000, 10 * 60_000];

const STATE_TYPES: readonly StateType[] = ["backlog", "unstarted", "started", "completed", "canceled"];

interface StoredSheets {
  lastAttemptAt: number | null;
  lastSuccessAt: number | null;
  lastError: string | null;
  retries: number;
  origin: string | null;
}

interface IssueRow {
  id: string;
  team_id: string;
  number: number;
  title: string;
  description: string | null;
  state_id: string;
  priority: number | null;
  assignee_id: string | null;
  project_id: string;
  label_ids: string | null;
  due_date: string | null;
  completed_at: number | null;
}

/**
 * 対象ワークスペースのプロジェクトと課題を、報告用の形に揃える。
 * 着手日は loadStartedOn（履歴を含むいちばん早い時刻。日本時間の日付。無ければ null）。
 */
export async function loadReportInput(db: D1Database, ws: WorkspaceRow, origin: string | null, now: number): Promise<ReportInput> {
  const [projects, issues, states, teams, users, labels, startedOnByIssue] = await Promise.all([
    all<{ id: string; name: string }>(
      db,
      "SELECT id, name FROM projects WHERE workspace_id = ? AND archived_at IS NULL ORDER BY sort_order, created_at",
      ws.id,
    ),
    all<IssueRow>(
      db,
      `SELECT id, team_id, number, title, description, state_id, priority, assignee_id, project_id, label_ids, due_date, completed_at
       FROM issues WHERE workspace_id = ? AND archived_at IS NULL AND project_id IS NOT NULL`,
      ws.id,
    ),
    all<{ id: string; name: string; type: string }>(db, "SELECT id, name, type FROM workflow_states WHERE workspace_id = ?", ws.id),
    all<{ id: string; key: string }>(db, "SELECT id, key FROM teams WHERE workspace_id = ?", ws.id),
    all<{ id: string; name: string }>(
      db,
      "SELECT u.id AS id, u.name AS name FROM users u JOIN members m ON m.user_id = u.id WHERE m.workspace_id = ?",
      ws.id,
    ),
    all<{ id: string; name: string }>(db, "SELECT id, name FROM labels WHERE workspace_id = ?", ws.id),
    loadStartedOn(db, ws.id),
  ]);

  const stateById = new Map(states.map((state) => [state.id, state]));
  const teamKey = new Map(teams.map((team) => [team.id, team.key]));
  const userName = new Map(users.map((user) => [user.id, user.name]));
  const labelName = new Map(labels.map((label) => [label.id, label.name]));

  return {
    workspaceName: ws.name,
    urlKey: ws.url_key,
    origin,
    today: todayYmd(540, now),
    now,
    projects,
    issues: issues.map((issue) => {
      const state = stateById.get(issue.state_id);
      const key = teamKey.get(issue.team_id);
      const completedMs = finite(issue.completed_at);
      return {
        id: issue.id,
        identifier: key ? `${key}-${issue.number}` : String(issue.number),
        title: issue.title,
        descriptionText: markdownToPlainLines(issue.description ?? ""),
        projectId: issue.project_id,
        stateName: state?.name ?? "",
        stateType: asStateType(state?.type),
        priority: finite(issue.priority) ?? 0,
        assigneeName: issue.assignee_id ? (userName.get(issue.assignee_id) ?? null) : null,
        labelNames: jsonIds(issue.label_ids).flatMap((id) => {
          const name = labelName.get(id);
          return name ? [name] : [];
        }),
        dueDate: isValidYmd(issue.due_date) ? issue.due_date : null,
        startedOn: startedOnByIssue[issue.id] ?? null,
        completedOn: completedMs == null ? null : todayYmd(540, completedMs),
      };
    }),
  };
}

/**
 * ワークスペースの Durable Object から使う。状態は storage の "sheets" に置く。
 * /sheets/schedule・/sheets/run・/sheets/status 以外は null を返し、呼び出し側が続きを処理する。
 */
export class SheetSyncRunner {
  /** 反映を 1 本につなぐ。前が失敗しても次は走る */
  private tail: Promise<void> = Promise.resolve();

  constructor(
    private storage: DurableObjectStorage,
    private env: Env,
  ) {}

  async handle(request: Request): Promise<Response | null> {
    const path = new URL(request.url).pathname;
    if (path === "/sheets/schedule" && request.method === "POST") {
      const origin = await readOrigin(request);
      await this.enqueue(() => this.schedule(origin));
      return Response.json({ ok: true });
    }
    if (path === "/sheets/run" && request.method === "POST") {
      const origin = await readOrigin(request);
      const status = await this.enqueue(() => this.runNow(origin));
      return Response.json(status);
    }
    if (path === "/sheets/status" && request.method === "GET") {
      return Response.json(await this.snapshot());
    }
    return null;
  }

  /** アラームが鳴ったら反映する。失敗したら短い間隔で入れ直す（2 回まで） */
  async alarm(): Promise<void> {
    await this.enqueue(() => this.execute(true));
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(fn, fn);
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** 保存のあと。近いアラームはそのまま、遅いときだけ前倒しする。新しい保存なのでやり直し回数は 0 に戻す */
  private async schedule(origin: string | null): Promise<void> {
    const state = await this.load();
    const cfg = sheetsConfig(this.env);
    await this.save({ ...state, origin: origin ?? state.origin, retries: 0 });
    if (!cfg) return;
    const target = Date.now() + cfg.delayMs;
    const pending = await this.storage.getAlarm();
    if (pending === null || pending > target) await this.storage.setAlarm(target);
  }

  /**
   * 今すぐ反映。成功したときだけ予約中のアラームを消す。
   * 失敗したときは予約を残す。鳴れば、そこから今までどおりのやり直し（2 分後・10 分後）に進む。
   */
  private async runNow(origin: string | null): Promise<SheetSyncStatus> {
    const state = await this.load();
    await this.save({ ...state, origin: origin ?? state.origin });
    const ok = await this.execute(false);
    if (ok) await this.storage.deleteAlarm();
    return this.snapshot();
  }

  /**
   * @param fromAlarm アラーム経由のときだけ、失敗時に 2 分後・10 分後のやり直しを入れる。
   * 今すぐ反映と毎日の Cron は /sheets/run なので、ここでは入れ直さない。
   * @returns 反映できたとき true。連携が無効で何もしなかったときと、失敗したときは false。
   */
  private async execute(fromAlarm: boolean): Promise<boolean> {
    const cfg = sheetsConfig(this.env);
    if (!cfg) return false;
    const now = Date.now();
    try {
      await ensureMigrated(this.env.DB);
      const ws = await first<WorkspaceRow>(this.env.DB, "SELECT * FROM workspaces WHERE url_key = ?", cfg.workspaceKey);
      if (!ws) throw new SheetsError("SHEETS_WORKSPACE のワークスペースが見つかりません");
      const state = await this.load();
      const origin = state.origin || configuredOrigin(this.env);
      const report = buildReport(await loadReportInput(this.env.DB, ws, origin, now));
      const key = parseServiceAccountKey(this.env.GOOGLE_SERVICE_ACCOUNT_KEY ?? "");
      const token = await getAccessToken(key, cfg.tokenUrl, now);
      const existing = await getSheets(cfg.sheetsApiBase, cfg.spreadsheetId, token, key.clientEmail);
      await batchUpdate(
        cfg.sheetsApiBase,
        cfg.spreadsheetId,
        token,
        buildSheetRequests(report, existing),
        key.clientEmail,
      );
      const latest = await this.load();
      await this.save({ ...latest, lastAttemptAt: now, lastSuccessAt: now, lastError: null, retries: 0 });
      return true;
    } catch (e) {
      const message = e instanceof SheetsError ? e.message : "反映に失敗しました";
      // 鍵やトークンはメッセージに含めない。SheetsError 以外は名前だけ（中身に秘密が混ざるのを避ける）
      console.error("sheets sync failed", e instanceof SheetsError ? message : e instanceof Error ? e.name : "error");
      const latest = await this.load();
      const delay = fromAlarm ? RETRY_AFTER_MS[latest.retries] : undefined;
      await this.save({
        ...latest,
        lastAttemptAt: now,
        lastError: message,
        retries: delay !== undefined ? latest.retries + 1 : latest.retries,
      });
      if (delay !== undefined) {
        const retryAt = Date.now() + delay;
        const pending = await this.storage.getAlarm();
        if (pending === null || pending > retryAt) await this.storage.setAlarm(retryAt);
      }
      return false;
    }
  }

  private async snapshot(): Promise<SheetSyncStatus> {
    const cfg = sheetsConfig(this.env);
    const state = await this.load();
    const alarm = await this.storage.getAlarm();
    const status: SheetSyncStatus = {
      enabled: cfg !== null,
      lastAttemptAt: state.lastAttemptAt,
      lastSuccessAt: state.lastSuccessAt,
      lastError: state.lastError,
      pending: alarm !== null,
    };
    if (cfg) status.spreadsheetUrl = spreadsheetUrl(cfg.spreadsheetId);
    return status;
  }

  private async load(): Promise<StoredSheets> {
    const raw = await this.storage.get<Partial<StoredSheets>>(STORAGE_KEY);
    return {
      lastAttemptAt: raw?.lastAttemptAt ?? null,
      lastSuccessAt: raw?.lastSuccessAt ?? null,
      lastError: raw?.lastError ?? null,
      retries: typeof raw?.retries === "number" ? raw.retries : 0,
      origin: raw?.origin ?? null,
    };
  }

  private async save(state: StoredSheets): Promise<void> {
    await this.storage.put(STORAGE_KEY, state);
  }
}

function configuredOrigin(env: Env): string | null {
  const raw = env.BETTER_AUTH_URL?.trim().replace(/\/+$/, "") ?? "";
  return raw || null;
}

async function readOrigin(request: Request): Promise<string | null> {
  try {
    const body = (await request.json()) as { origin?: unknown };
    if (typeof body?.origin !== "string") return null;
    const origin = body.origin.trim().replace(/\/+$/, "");
    return origin || null;
  } catch {
    return null;
  }
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asStateType(value: string | undefined): StateType {
  return STATE_TYPES.find((type) => type === value) ?? "unstarted";
}

function jsonIds(raw: string | null): string[] {
  try {
    const parsed = JSON.parse(raw ?? "[]") as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((id): id is string => typeof id === "string");
  } catch {
    return [];
  }
}