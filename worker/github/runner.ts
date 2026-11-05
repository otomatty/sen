// GitHub 連携の順番待ち。Durable Object のストレージに置き、アラームで 1 件ずつ処理する。
// 受け付けは drain() を待たない。処理が GitHub と通信して長くなっても、Webhook は 10 秒以内に返せる。
// db と同期の実装は、処理するときだけ読む。順番待ちのテストがこのファイルを読み込んでも、移行 SQL まで進まない。

import type { Env } from "../env";
import { GitHubError, getUser, type GhLabel } from "./api";
import { githubConfig } from "./config";
import type { GitHubCommentEvent, GitHubIncoming, GitHubPullEvent } from "./events";

/** 1 回目の失敗のあと 30 秒、その次は 2 分・10 分・1 時間・6 時間。それでも失敗したら諦める */
const RETRY_MS = [30_000, 2 * 60_000, 10 * 60_000, 60 * 60_000, 6 * 60 * 60_000];
const USER_CACHE_MS = 60_000;
const META_KEY = "gh:meta";

export interface GitHubProcessorContext {
  env: Env;
  workspaceId: string;
  /** 1 回の drain() のあいだ、リポジトリのラベル一覧を覚えておく */
  labelCache: Map<string, GhLabel[]>;
  enqueueComment: (commentId: string) => Promise<void>;
  /** 完了・キャンセルにした課題を、Sen 側の変更として突き合わせに戻す */
  enqueueIssue: (issueId: string) => Promise<void>;
  scheduleSheets?: () => Promise<void>;
}

export interface GitHubProcessorJob {
  key: string;
  payload?: unknown;
}

/**
 * 出来事の種類ごとの処理。
 * issue: Sen で変わった課題。githubIssue: GitHub で変わった Issue。
 * comment: Sen で追加されたコメント。githubComment: GitHub で追加されたコメント。
 * pull: プルリクエストの紐づけと、ステータスの自動の移動。
 */
export const processors: Record<"issue" | "githubIssue" | "comment" | "githubComment" | "pull", (ctx: GitHubProcessorContext, job: GitHubProcessorJob) => Promise<void>> = {
  issue: async (ctx, job) => {
    const { reconcileIssue } = await import("./sync");
    await reconcileIssue(ctx, { issueId: job.key.slice("gh:dirty:issue:".length) });
  },
  githubIssue: async (ctx, job) => {
    const { reconcileIssue } = await import("./sync");
    const [repoId, number] = job.key.slice("gh:dirty:gh:".length).split(":");
    await reconcileIssue(ctx, { repoId: Number(repoId), number: Number(number) });
  },
  comment: async (ctx, job) => {
    const { pushComment } = await import("./sync");
    await pushComment(ctx, job.key.slice("gh:dirty:comment:".length));
  },
  githubComment: async (ctx, job) => {
    const { pullComment } = await import("./sync");
    await pullComment(ctx, job.payload as GitHubCommentEvent);
  },
  pull: async (ctx, job) => {
    const { syncPull } = await import("./pull-sync");
    await syncPull(ctx, job.payload as GitHubPullEvent);
  },
};

interface QueueItem {
  /** 印を付け直すたびに変わる。処理を始めたときと違えば、その印は消さない・書き換えない */
  token: string;
  attempts: number;
  nextAt: number;
  payload?: unknown;
}

interface GhMeta {
  workspaceId: string | null;
  login: string | null;
  error: string | null;
  rateLimitReset: number | null;
  userCheckedAt: number | null;
  nextAt: number | null;
}

interface DueJob {
  key: string;
  item: QueueItem;
}

/**
 * /github/mark・/github/event・/github/status・/github/note 以外は null。
 * 受け付けと status は drain() の鎖に並べない。drain() が GitHub 待ちで数十秒になっても、
 * Webhook の受け口が Durable Object の応答を待ったまま 10 秒を超えないように、
 * ストレージへの書き込みと次の時刻の計算だけですぐ返す。アラームの drain() 同士は直列のまま。
 * 処理中に同じキーへ新しい印が書かれることがあるので、印ごとに token を変える。
 * 処理を終えたとき（消すときも、失敗してやり直しを書くときも）は、ストレージの今の token が
 * 処理を始めたときと同じときだけ変える。違えば新しい印を残し、試行回数は 0 のまま次に処理する。
 * 次の時刻は受け付けと drain() のどちらからでも計算し、同時でもいちばん早い時刻にアラームを合わせる。
 */
export class GitHubSyncRunner {
  /** アラームの drain() だけを直列にする。受け付けはここへ並べない */
  private tail: Promise<void> = Promise.resolve();
  /** 印の出し入れと nextAt。同時に計算しても、遅い方の古い結果で早い時刻を上書きしない */
  private state: Promise<void> = Promise.resolve();

  /** 1 回の drain() で使い回すラベル一覧 */
  private labels = new Map<string, GhLabel[]>();
  /** 課題ごとの処理。drain() の全体は待たせず、同じ課題だけ重ならないようにする */
  private locks = new Map<string, Promise<void>>();

  constructor(
    private storage: DurableObjectStorage,
    private env: Env,
    private signal: () => Promise<void>,
    /** 同じ Durable Object のシート予約。自分へ fetch しない */
    private localSheets?: (origin: string) => Promise<void>,
  ) {}

  async handle(request: Request): Promise<Response | null> {
    const path = new URL(request.url).pathname;
    if (!path.startsWith("/github/")) return null;
    if (path === "/github/status" && request.method === "GET") {
      return Response.json(await this.refreshUser());
    }
    if (path === "/github/note" && request.method === "POST") {
      const body = await readJson<{ error?: unknown; rateLimitReset?: unknown }>(request);
      await this.note(body);
      return Response.json({ ok: true });
    }
    if (path === "/github/mark" && request.method === "POST") {
      const body = await readJson<{ workspaceId?: unknown; issues?: unknown; comments?: unknown }>(request);
      await this.mark(body);
      return Response.json({ ok: true });
    }
    if (path === "/github/event" && request.method === "POST") {
      const body = await readJson<{ workspaceId?: unknown; incoming?: unknown }>(request);
      await this.enqueueEvent(body);
      return Response.json({ ok: true });
    }
    if (path === "/github/issue" && request.method === "POST") return this.handleIssue(request);
    if (path === "/github/reconcile" && request.method === "POST") return this.handleReconcile(request);
    return null;
  }

  /** 自分の時刻が来ていれば、期限の来た印を 1 件ずつ処理する */
  async alarm(): Promise<void> {
    await this.enqueue(() => this.drain());
  }

  async nextAt(): Promise<number | null> {
    return (await this.loadMeta()).nextAt;
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(fn, fn);
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async mark(body: { workspaceId?: unknown; issues?: unknown; comments?: unknown }): Promise<void> {
    const workspaceId = typeof body.workspaceId === "string" ? body.workspaceId : "";
    if (!workspaceId) return;
    await this.rememberWorkspace(workspaceId);
    const cfg = githubConfig(this.env);
    const when = Date.now() + (cfg?.delayMs ?? 3_000);
    for (const id of stringList(body.issues)) await this.putItem(`gh:dirty:issue:${id}`, when);
    for (const id of stringList(body.comments)) await this.putItem(`gh:dirty:comment:${id}`, when);
    await this.recomputeNext();
  }

  private async enqueueEvent(body: { workspaceId?: unknown; incoming?: unknown }): Promise<void> {
    const workspaceId = typeof body.workspaceId === "string" ? body.workspaceId : "";
    const incoming = body.incoming as GitHubIncoming | undefined;
    if (!workspaceId || !incoming || typeof incoming !== "object") return;
    await this.rememberWorkspace(workspaceId);
    const now = Date.now();
    if (incoming.type === "issue" && Number.isSafeInteger(incoming.repoId) && Number.isSafeInteger(incoming.number)) {
      await this.putItem(`gh:dirty:gh:${incoming.repoId}:${incoming.number}`, now);
    } else if (incoming.type === "comment" && Number.isSafeInteger(incoming.githubCommentId)) {
      await this.putItem(`gh:event:comment:${incoming.githubCommentId}`, now, incoming.payload);
    } else if (incoming.type === "pull" && Number.isSafeInteger(incoming.repoId) && Number.isSafeInteger(incoming.number)) {
      await this.putItem(`gh:event:pull:${incoming.repoId}:${incoming.number}`, now, incoming.payload);
    }
    await this.recomputeNext();
  }

  private async note(body: { error?: unknown; rateLimitReset?: unknown }): Promise<void> {
    const error = typeof body.error === "string" ? body.error : null;
    const rateLimitReset = typeof body.rateLimitReset === "number" && Number.isFinite(body.rateLimitReset) ? body.rateLimitReset : null;
    await this.lock(async () => {
      const meta = await this.loadMeta();
      await this.saveMeta({
        ...meta,
        error,
        rateLimitReset,
        login: error === "GitHub のトークンが無効です" ? null : meta.login,
        userCheckedAt: error ? Date.now() : meta.userCheckedAt,
      });
    });
    await this.recomputeNext();
  }

  private async refreshUser(): Promise<{ login: string | null; error: string | null }> {
    const meta = await this.loadMeta();
    if (meta.userCheckedAt != null && Date.now() - meta.userCheckedAt < USER_CACHE_MS) {
      return { login: meta.login, error: meta.error };
    }
    const cfg = githubConfig(this.env);
    if (!cfg) return { login: null, error: null };
    try {
      const user = await getUser(cfg);
      const login = typeof user.login === "string" && user.login ? user.login : null;
      await this.lock(async () => {
        const latest = await this.loadMeta();
        await this.saveMeta({ ...latest, login, error: null, rateLimitReset: null, userCheckedAt: Date.now() });
      });
      return { login, error: null };
    } catch (e) {
      const gh = e instanceof GitHubError ? e : null;
      const message = gh ? gh.message : "GitHub に接続できませんでした";
      console.error("github user failed", gh ? gh.status : e instanceof Error ? e.name : "error");
      const login = await this.lock(async () => {
        const latest = await this.loadMeta();
        const nextLogin = gh?.status === 401 ? null : latest.login;
        await this.saveMeta({
          ...latest,
          login: nextLogin,
          error: message,
          rateLimitReset: gh?.rateLimitReset ?? null,
          userCheckedAt: Date.now(),
        });
        return nextLogin;
      });
      await this.recomputeNext();
      return { login, error: message };
    }
  }

  private async drain(): Promise<void> {
    this.labels = new Map();
    for (let n = 0; n < 50; n++) {
      const current = await this.loadMeta();
      if (current.rateLimitReset != null && current.rateLimitReset > Date.now() + 1500) break;
      const due = await this.listDue();
      if (!due.length) break;
      await this.processOne(due[0]);
    }
    await this.recomputeNext();
  }

  private async processOne(job: DueJob): Promise<void> {
    const kind = kindOf(job.key);
    const meta = await this.loadMeta();
    const workspaceId = meta.workspaceId ?? "";
    try {
      const keys = await this.lockKeys(workspaceId, job);
      await this.withLocks(keys, async () => {
        if (!kind) return;
        await processors[kind](this.processorCtx(workspaceId), { key: job.key, payload: job.item.payload });
      });
      await this.ifCurrent(job, () => this.storage.delete(job.key));
    } catch (e) {
      const gh = e instanceof GitHubError ? e : null;
      const message = gh ? gh.message : "GitHub との同期に失敗しました";
      console.error("github sync failed", gh ? gh.status : e instanceof Error ? e.name : "error");
      if (gh && (gh.status === 401 || gh.status === 429 || gh.rateLimitReset != null)) {
        await this.lock(async () => {
          const latest = await this.loadMeta();
          await this.saveMeta({
            ...latest,
            error: message,
            login: gh.status === 401 ? null : latest.login,
            rateLimitReset: gh.rateLimitReset,
            userCheckedAt: gh.status === 401 ? Date.now() : latest.userCheckedAt,
          });
        });
      }
      const delay = RETRY_MS[job.item.attempts];
      if (delay === undefined) {
        if (!(await this.isCurrent(job))) return;
        await this.giveUp(job, message);
        await this.ifCurrent(job, () => this.storage.delete(job.key));
        return;
      }
      let nextAt = Date.now() + delay;
      if (gh?.rateLimitReset != null && gh.rateLimitReset > nextAt) nextAt = gh.rateLimitReset;
      await this.ifCurrent(job, () => this.storage.put<QueueItem>(job.key, { ...job.item, attempts: job.item.attempts + 1, nextAt }));
    }
  }

  private async giveUp(job: DueJob, message: string): Promise<void> {
    const meta = await this.loadMeta();
    const workspaceId = meta.workspaceId;
    if (!workspaceId || !this.env.DB) return;
    const cfg = githubConfig(this.env);
    const reason = (cfg && message.includes(cfg.token) ? "GitHub との同期に失敗しました" : message).slice(0, 500);
    try {
      const { ensureMigrated, first } = await import("../db");
      const { notifyRealtime, writeChanges } = await import("../sync");
      await ensureMigrated(this.env.DB);
      const issueId = await issueIdFor(this.env.DB, workspaceId, job, first);
      if (!issueId) return;
      const updated = await this.env.DB.prepare("UPDATE github_issue_links SET last_error = ? WHERE issue_id = ? AND workspace_id = ?")
        .bind(reason, issueId, workspaceId)
        .run();
      if ((updated.meta?.changes ?? 0) === 0) return;
      const last = await writeChanges(this.env.DB, workspaceId, [{ entity: "githubLink", entityId: issueId, op: "upsert" }]);
      await notifyRealtime(this.env, workspaceId, last);
    } catch (e) {
      console.error("github give up failed", e instanceof Error ? e.name : "error");
    }
  }

  private async listDue(): Promise<DueJob[]> {
    const now = Date.now() + 1500;
    const out: DueJob[] = [];
    for (const prefix of ["gh:dirty:", "gh:event:"]) {
      const listed = await this.storage.list<QueueItem>({ prefix });
      for (const [key, item] of listed) {
        if (item && typeof item.nextAt === "number" && item.nextAt <= now) out.push({ key, item });
      }
    }
    out.sort((a, b) => a.item.nextAt - b.item.nextAt || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    return out;
  }

  private recomputeNext(): Promise<void> {
    return this.lock(async () => {
      const times: number[] = [];
      for (const prefix of ["gh:dirty:", "gh:event:"]) {
        const listed = await this.storage.list<QueueItem>({ prefix });
        for (const [, item] of listed) if (item && typeof item.nextAt === "number") times.push(item.nextAt);
      }
      const meta = await this.loadMeta();
      const now = Date.now();
      const due = times.some((t) => t <= now);
      let nextAt: number | null = null;
      if (meta.rateLimitReset != null && meta.rateLimitReset > now && due) nextAt = meta.rateLimitReset;
      else if (times.length) nextAt = Math.min(...times);
      await this.saveMeta({ ...meta, nextAt });
      await this.signal();
    });
  }

  private async rememberWorkspace(workspaceId: string): Promise<void> {
    await this.lock(async () => {
      const meta = await this.loadMeta();
      if (meta.workspaceId === workspaceId) return;
      await this.saveMeta({ ...meta, workspaceId });
    });
  }

  /** 印の書き換えと nextAt の計算を直列にする。drain() の処理そのものは止めない */
  private lock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.state.then(fn, fn);
    this.state = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private putItem(key: string, nextAt: number, payload?: unknown): Promise<void> {
    const item: QueueItem = { token: crypto.randomUUID(), attempts: 0, nextAt };
    if (payload !== undefined) item.payload = payload;
    return this.lock(() => this.storage.put(key, item));
  }

  /** 処理を始めた印が、まだストレージに残っているか */
  private isCurrent(job: DueJob): Promise<boolean> {
    return this.lock(async () => {
      const current = await this.storage.get<QueueItem>(job.key);
      return current?.token === job.item.token;
    });
  }

  /** 今の token が処理開始時と同じときだけ書き換える。違えば新しい印を残す */
  private ifCurrent(job: DueJob, write: () => Promise<unknown>): Promise<void> {
    return this.lock(async () => {
      const current = await this.storage.get<QueueItem>(job.key);
      if (current?.token !== job.item.token) return;
      await write();
    });
  }

  private async loadMeta(): Promise<GhMeta> {
    const raw = await this.storage.get<Partial<GhMeta>>(META_KEY);
    return {
      workspaceId: typeof raw?.workspaceId === "string" ? raw.workspaceId : null,
      login: typeof raw?.login === "string" ? raw.login : null,
      error: typeof raw?.error === "string" ? raw.error : null,
      rateLimitReset: typeof raw?.rateLimitReset === "number" ? raw.rateLimitReset : null,
      userCheckedAt: typeof raw?.userCheckedAt === "number" ? raw.userCheckedAt : null,
      nextAt: typeof raw?.nextAt === "number" ? raw.nextAt : null,
    };
  }

  private async saveMeta(meta: GhMeta): Promise<void> {
    await this.storage.put(META_KEY, meta);
  }

  private processorCtx(workspaceId: string): GitHubProcessorContext {
    const origin = this.env.BETTER_AUTH_URL?.trim().replace(/\/+$/, "") ?? "";
    return {
      env: this.env,
      workspaceId,
      labelCache: this.labels,
      enqueueComment: (commentId) => this.enqueueComment(commentId),
      enqueueIssue: (issueId) => this.enqueueIssue(issueId),
      scheduleSheets: this.localSheets ? () => this.localSheets!(origin) : undefined,
    };
  }

  private async enqueueComment(commentId: string): Promise<void> {
    await this.putItem(`gh:dirty:comment:${commentId}`, Date.now());
    await this.recomputeNext();
  }

  /** via: "GitHub" の書き込みは scheduleGitHubSync が無視するので、完了・キャンセルだけここから印を付ける */
  private async enqueueIssue(issueId: string): Promise<void> {
    if (!issueId) return;
    await this.putItem(`gh:dirty:issue:${issueId}`, Date.now());
    await this.recomputeNext();
  }

  private async lockKeys(workspaceId: string, job: DueJob): Promise<string[]> {
    if (!this.env.DB || !workspaceId) return [];
    const { lockKeysForJob } = await import("./sync");
    return lockKeysForJob(this.env.DB, workspaceId, job.key, job.item.payload);
  }

  /** 空ならそのまま。キーは名前順に取り、同じ課題の処理とだけ重ならないようにする */
  private async withLocks<T>(keys: string[], fn: () => Promise<T>): Promise<T> {
    const ordered = [...new Set(keys)].filter(Boolean).sort();
    if (!ordered.length) return fn();
    const waits: Promise<void>[] = [];
    const releases: (() => void)[] = [];
    for (const key of ordered) {
      const prev = this.locks.get(key) ?? Promise.resolve();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const tail = prev.then(() => gate, () => gate);
      this.locks.set(key, tail);
      waits.push(prev.then(() => undefined, () => undefined));
      releases.push(() => {
        release();
        if (this.locks.get(key) === tail) this.locks.delete(key);
      });
    }
    for (const wait of waits) await wait;
    try {
      return await fn();
    } finally {
      for (const release of releases.reverse()) release();
    }
  }

  private async handleIssue(request: Request): Promise<Response> {
    const body = await readJson<{ workspaceId?: unknown; userId?: unknown; issueId?: unknown; action?: unknown; ref?: unknown; prefer?: unknown }>(request);
    const workspaceId = typeof body.workspaceId === "string" ? body.workspaceId : "";
    const userId = typeof body.userId === "string" ? body.userId : "";
    const issueId = typeof body.issueId === "string" ? body.issueId : "";
    let action: "create" | "link" | "unlink" | null = null;
    if (body.action === "create" || body.action === "link" || body.action === "unlink") action = body.action;
    if (!workspaceId || !userId || !issueId || !action) return Response.json({ error: "要求が不正です" }, { status: 400 });
    let prefer: "sen" | "github" | undefined;
    if (body.prefer === "sen" || body.prefer === "github") prefer = body.prefer;
    const op = {
      workspaceId,
      userId,
      issueId,
      action,
      ref: typeof body.ref === "string" ? body.ref : undefined,
      prefer,
    };
    try {
      const { lockKeysForManual, runManual } = await import("./sync");
      const keys = this.env.DB ? await lockKeysForManual(this.env.DB, op) : [`issue:${issueId}`];
      await this.rememberWorkspace(workspaceId);
      await this.withLocks(keys, () => runManual(this.processorCtx(workspaceId), op));
      return Response.json({ ok: true });
    } catch (e) {
      const { MutationError } = await import("../mutations");
      if (e instanceof MutationError) return Response.json({ error: e.message }, { status: e.status });
      if (e instanceof GitHubError) return Response.json({ error: e.message }, { status: e.status === 401 || e.status === 403 || e.status === 429 ? e.status : 502 });
      console.error("github issue op failed", e instanceof Error ? e.name : "error");
      return Response.json({ error: "GitHub との同期に失敗しました" }, { status: 500 });
    }
  }

  private async handleReconcile(request: Request): Promise<Response> {
    const body = await readJson<{ workspaceId?: unknown }>(request);
    const workspaceId = typeof body.workspaceId === "string" ? body.workspaceId : "";
    if (!workspaceId) return Response.json({ error: "ワークスペースがありません" }, { status: 400 });
    try {
      await this.rememberWorkspace(workspaceId);
      const { scanUpdates } = await import("./sync");
      await scanUpdates(
        this.env,
        workspaceId,
        {
          get: async (key) => {
            const value = await this.storage.get<string>(key);
            return typeof value === "string" ? value : undefined;
          },
          put: (key, value) => this.storage.put(key, value),
        },
        {
          issue: async (repoId, number) => {
            await this.putItem(`gh:dirty:gh:${repoId}:${number}`, Date.now());
          },
          comment: async (payload) => {
            await this.putItem(`gh:event:comment:${payload.comment.id}`, Date.now(), payload);
          },
          pull: async (payload) => {
            await this.putItem(`gh:event:pull:${payload.repository.id}:${payload.pull_request.number}`, Date.now(), payload);
          },
        },
      );
      await this.recomputeNext();
      return Response.json({ ok: true });
    } catch (e) {
      const gh = e instanceof GitHubError ? e : null;
      console.error("github reconcile failed", gh ? gh.status : e instanceof Error ? e.name : "error");
      if (gh && (gh.status === 401 || gh.status === 429 || gh.rateLimitReset != null)) await this.note({ error: gh.message, rateLimitReset: gh.rateLimitReset });
      return Response.json({ error: gh?.message ?? "突き合わせに失敗しました" }, { status: 500 });
    }
  }
}

function kindOf(key: string): keyof typeof processors | null {
  if (key.startsWith("gh:dirty:issue:")) return "issue";
  if (key.startsWith("gh:dirty:gh:")) return "githubIssue";
  if (key.startsWith("gh:dirty:comment:")) return "comment";
  if (key.startsWith("gh:event:comment:")) return "githubComment";
  if (key.startsWith("gh:event:pull:")) return "pull";
  return null;
}

async function issueIdFor(
  db: D1Database,
  workspaceId: string,
  job: DueJob,
  first: <T>(db: D1Database, sql: string, ...params: (string | number | null)[]) => Promise<T | null>,
): Promise<string | null> {
  if (job.key.startsWith("gh:dirty:issue:")) return job.key.slice("gh:dirty:issue:".length);
  if (job.key.startsWith("gh:dirty:comment:")) {
    const row = await first<{ issue_id: string }>(db, "SELECT issue_id FROM comments WHERE id = ? AND workspace_id = ?", job.key.slice("gh:dirty:comment:".length), workspaceId);
    return row?.issue_id ?? null;
  }
  if (job.key.startsWith("gh:dirty:gh:")) {
    const [repoId, number] = job.key.slice("gh:dirty:gh:".length).split(":");
    const row = await first<{ issue_id: string }>(
      db,
      "SELECT issue_id FROM github_issue_links WHERE workspace_id = ? AND repo_id = ? AND number = ?",
      workspaceId,
      Number(repoId),
      Number(number),
    );
    return row?.issue_id ?? null;
  }
  const payload = job.item.payload as Partial<GitHubCommentEvent & GitHubPullEvent> | undefined;
  const repoId = payload?.repository?.id;
  const number = payload?.issue?.number;
  if (typeof repoId !== "number" || typeof number !== "number") return null;
  const row = await first<{ issue_id: string }>(
    db,
    "SELECT issue_id FROM github_issue_links WHERE workspace_id = ? AND repo_id = ? AND number = ?",
    workspaceId,
    repoId,
    number,
  );
  return row?.issue_id ?? null;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.length > 0);
}

async function readJson<T>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    return {} as T;
  }
}
