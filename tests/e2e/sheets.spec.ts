import { randomUUID, verify } from "node:crypto";
import fs from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import type { BootstrapPayload, Mutation, StateType } from "../../shared/types";
import {
  buildReport,
  buildSheetRequests,
  type ExistingSheet,
  type ReportInput,
  type ReportIssueInput,
} from "../../worker/sheets/report";
import { signupViaUi } from "./helpers";

const TODAY = "2026-11-10";
const GOOGLE_PORT = Number(process.env.E2E_GOOGLE_PORT ?? 4329);
const ACCESS_TOKEN = "e2e-access-token";
const CLIENT_EMAIL = "sen-e2e@sen-e2e.iam.gserviceaccount.com";
const SPREADSHEET = "e2e-spreadsheet";
const ACTIVITY_SHEET = 1001;
const WBS_SHEET = 1002;
const PUBLIC_KEY_PATH = path.join(os.tmpdir(), "sen-e2e-sheets-public.pem");
const EVIL_TITLE = '=IMPORTXML("http://evil")';
const DANGEROUS_TITLE = '="危険" & 1';

interface CellValue {
  stringValue?: string;
  formulaValue?: string;
}

interface SheetRequest {
  addSheet?: { properties?: { sheetId?: number; title?: string; index?: number } };
  updateCells?: {
    start?: { sheetId?: number };
    rows?: { values?: { userEnteredValue?: CellValue }[] }[];
  };
  updateDimensionProperties?: {
    range?: { sheetId?: number; dimension?: string; startIndex?: number; endIndex?: number };
    properties?: { hiddenByUser?: boolean };
    fields?: string;
  };
}

interface TokenCall {
  grant_type: string;
  assertion: string;
}

interface BatchCall {
  requests?: SheetRequest[];
}

const google = {
  tokens: [] as TokenCall[],
  batches: [] as BatchCall[],
  sheets: [{ sheetId: 0, title: "シート1" }] as { sheetId: number; title: string }[],
  failNext: null as number | null,
};

function issue(partial: Pick<ReportIssueInput, "id" | "projectId" | "stateType"> & Partial<ReportIssueInput>): ReportIssueInput {
  return {
    identifier: "ENG-1",
    title: "課題",
    descriptionText: "",
    stateName: "状態",
    priority: 0,
    assigneeName: null,
    labelNames: [],
    dueDate: null,
    startedOn: null,
    completedOn: null,
    ...partial,
  };
}

function input(projects: ReportInput["projects"], issues: ReportIssueInput[], origin: string | null = "http://localhost"): ReportInput {
  return {
    workspaceName: "テスト",
    urlKey: "sheets-e2e",
    origin,
    today: TODAY,
    now: Date.UTC(2026, 10, 10),
    projects,
    issues,
  };
}

function asRequests(report: ReturnType<typeof buildReport>, existing: ExistingSheet[]): SheetRequest[] {
  return buildSheetRequests(report, existing) as SheetRequest[];
}

function collectSheetIds(value: unknown, out: number[] = []): number[] {
  if (Array.isArray(value)) {
    for (const item of value) collectSheetIds(item, out);
    return out;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (key === "sheetId" && typeof child === "number") out.push(child);
      else collectSheetIds(child, out);
    }
  }
  return out;
}

function cellRows(requests: SheetRequest[], sheetId: number): { values?: { userEnteredValue?: CellValue }[] }[] {
  const update = requests.filter((request) => request.updateCells?.start?.sheetId === sheetId).at(-1);
  return update?.updateCells?.rows ?? [];
}

/** batchUpdate の updateCells を、タブごとの「セルの文字列」の行にする */
function sheetRows(body: BatchCall, sheetId: number): string[][] {
  return cellRows(body.requests ?? [], sheetId).map((row) =>
    (row.values ?? []).map((cell) => cell.userEnteredValue?.formulaValue ?? cell.userEnteredValue?.stringValue ?? ""),
  );
}

function resetGoogle() {
  google.tokens = [];
  google.batches = [];
  google.sheets = [{ sheetId: 0, title: "シート1" }];
  google.failNext = null;
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

async function handleGoogle(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${GOOGLE_PORT}`);
  const body = await readBody(req);
  if (req.method === "POST" && url.pathname === "/oauth2/token") {
    const params = new URLSearchParams(body);
    google.tokens.push({ grant_type: params.get("grant_type") ?? "", assertion: params.get("assertion") ?? "" });
    sendJson(res, 200, { access_token: ACCESS_TOKEN, expires_in: 3600, token_type: "Bearer" });
    return;
  }
  const spreadsheet = `/v4/spreadsheets/${SPREADSHEET}`;
  if (req.method === "GET" && url.pathname === spreadsheet) {
    if (req.headers.authorization !== `Bearer ${ACCESS_TOKEN}`) {
      sendJson(res, 401, { error: "unauthorized" });
      return;
    }
    sendJson(res, 200, {
      sheets: google.sheets.map((sheet) => ({ properties: { sheetId: sheet.sheetId, title: sheet.title } })),
    });
    return;
  }
  if (req.method === "POST" && url.pathname === `${spreadsheet}:batchUpdate`) {
    if (google.failNext != null) {
      const code = google.failNext;
      google.failNext = null;
      sendJson(res, code, { error: { code, message: "The caller does not have permission", status: "PERMISSION_DENIED" } });
      return;
    }
    const parsed = JSON.parse(body) as BatchCall;
    google.batches.push(parsed);
    for (const request of parsed.requests ?? []) {
      const props = request.addSheet?.properties;
      if (typeof props?.sheetId === "number" && typeof props.title === "string") {
        google.sheets.push({ sheetId: props.sheetId, title: props.title });
      }
    }
    sendJson(res, 200, { spreadsheetId: SPREADSHEET, replies: [] });
    return;
  }
  sendJson(res, 404, { error: `unexpected ${req.method} ${url.pathname}` });
}

function startGoogle(): Promise<Server> {
  const server = createServer((req, res) => {
    void handleGoogle(req, res).catch((err) => {
      console.error("mock google failed", err instanceof Error ? err.message : err);
      if (!res.headersSent) sendJson(res, 500, { error: "mock failure" });
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(GOOGLE_PORT, "127.0.0.1", () => {
      server.off("error", reject);
      resolve(server);
    });
  });
}

async function mutate(page: Page, ws: string, mutations: Mutation[]) {
  const res = await page.request.post(`/api/mutate?ws=${encodeURIComponent(ws)}`, {
    headers: { "x-sen-client": "1" },
    data: { ops: mutations.map((mutation) => ({ clientId: randomUUID(), mutation })) },
  });
  const text = await res.text();
  if (!res.ok()) throw new Error(`mutate が失敗しました (${res.status()}): ${text}`);
  const body = JSON.parse(text) as { results: { ok: boolean; error?: string }[] };
  const failed = body.results.filter((result) => !result.ok);
  if (failed.length) throw new Error(`mutate が拒否されました: ${failed.map((result) => result.error).join(", ")}`);
}

function stateId(data: BootstrapPayload, teamId: string, type: StateType, name: string): string {
  const state = data.states.find((item) => item.teamId === teamId && item.type === type && item.name === name);
  if (!state) throw new Error(`ステータス「${name}」（${type}）が見つかりません`);
  return state.id;
}

test.describe("集計ルール", () => {
  test("タスクがないプロジェクト", () => {
    const { activities } = buildReport(input([{ id: "p", name: "空" }], []));
    expect(activities[0]).toMatchObject({ completionRate: "タスクなし", nextDue: "—", status: "タスク未登録" });
  });

  test("すべて完了している", () => {
    const { activities } = buildReport(
      input(
        [{ id: "p", name: "P" }],
        [
          issue({ id: "a", projectId: "p", stateType: "completed", completedOn: "2026-11-01" }),
          issue({ id: "b", identifier: "ENG-2", projectId: "p", stateType: "completed", completedOn: "2026-11-02" }),
        ],
      ),
    );
    expect(activities[0]).toMatchObject({ completionRate: "100%（2/2）", nextDue: "—", status: "完了" });
  });

  test("完了率は切り捨てる", () => {
    const third = buildReport(
      input(
        [{ id: "p", name: "P" }],
        [
          issue({ id: "a", projectId: "p", stateType: "completed" }),
          issue({ id: "b", identifier: "ENG-2", projectId: "p", stateType: "unstarted" }),
          issue({ id: "c", identifier: "ENG-3", projectId: "p", stateType: "started" }),
        ],
      ),
    );
    expect(third.activities[0]?.completionRate).toBe("33%（1/3）");

    const almost = buildReport(
      input(
        [{ id: "p", name: "P" }],
        Array.from({ length: 200 }, (_, index) =>
          issue({
            id: `id-${index}`,
            identifier: `ENG-${index + 1}`,
            projectId: "p",
            stateType: index < 199 ? "completed" : "unstarted",
          }),
        ),
      ),
    );
    expect(almost.activities[0]?.completionRate).toBe("99%（199/200）");
  });

  test("未完了で保留でない課題の期日が今日より前なら期限超過", () => {
    const { activities } = buildReport(
      input(
        [{ id: "p", name: "P" }],
        [issue({ id: "a", projectId: "p", stateType: "started", dueDate: "2026-11-09" })],
      ),
    );
    expect(activities[0]?.status).toBe("期限超過");
  });

  test("保留の課題は直近期限と期限超過に入らず、完了率の分母には入る", () => {
    const { activities } = buildReport(
      input(
        [{ id: "p", name: "P" }],
        [
          issue({ id: "done", projectId: "p", stateType: "completed" }),
          issue({ id: "hold", identifier: "ENG-2", projectId: "p", stateType: "backlog", dueDate: "2020-01-01" }),
        ],
      ),
    );
    expect(activities[0]).toMatchObject({ completionRate: "50%（1/2）", nextDue: "—", status: "保留あり" });
  });

  test("期日がない課題", () => {
    const none = buildReport(
      input(
        [{ id: "p", name: "P" }],
        [
          issue({ id: "a", projectId: "p", stateType: "unstarted" }),
          issue({ id: "b", identifier: "ENG-2", projectId: "p", stateType: "started" }),
        ],
      ),
    );
    expect(none.activities[0]?.nextDue).toBe("期限未設定");

    const some = buildReport(
      input(
        [{ id: "p", name: "P" }],
        [
          issue({ id: "a", projectId: "p", stateType: "unstarted", dueDate: "2026-11-20" }),
          issue({ id: "b", identifier: "ENG-2", projectId: "p", stateType: "started" }),
        ],
      ),
    );
    expect(some.activities[0]?.nextDue).toBe("2026/11/20（未設定1件）");
  });

  test("キャンセルした課題は WBS にも完了率にも入らない", () => {
    const report = buildReport(
      input(
        [{ id: "p", name: "P" }],
        [
          issue({ id: "done", projectId: "p", stateType: "completed" }),
          issue({ id: "cancel", identifier: "ENG-2", projectId: "p", stateType: "canceled" }),
          issue({ id: "open", identifier: "ENG-3", projectId: "p", stateType: "unstarted" }),
        ],
      ),
    );
    expect(report.activities[0]?.completionRate).toBe("50%（1/2）");
    expect(report.tasks.map((task) => task.id).sort()).toEqual(["done", "open"]);
  });

  test("工程・完了日・優先度", () => {
    const report = buildReport(
      input(
        [{ id: "p", name: "P" }],
        [
          issue({
            id: "done",
            projectId: "p",
            stateType: "completed",
            priority: 0,
            completedOn: "2026-11-01",
            labelNames: ["工程:企画・設計", "バグ", "工程：開発・検証"],
          }),
          issue({
            id: "started",
            identifier: "ENG-2",
            projectId: "p",
            stateType: "started",
            priority: 0,
            completedOn: "2026-11-02",
          }),
        ],
      ),
    );
    const done = report.tasks.find((task) => task.id === "done");
    const started = report.tasks.find((task) => task.id === "started");
    expect(done?.process).toBe("企画・設計／開発・検証");
    expect(done?.completedOn).toBe("2026/11/01");
    expect(done?.priority).toBe("なし");
    expect(started?.completedOn).toBe("");
    expect(started?.priority).toBe("なし");
  });

  test("WBS はプロジェクトの順、期日（未設定は後ろ）、番号の順", () => {
    const report = buildReport(
      input(
        [
          { id: "p1", name: "先" },
          { id: "p2", name: "後" },
        ],
        [
          issue({ id: "late-num", identifier: "ENG-5", projectId: "p1", stateType: "unstarted" }),
          issue({ id: "due-early-num", identifier: "ENG-2", projectId: "p1", stateType: "unstarted", dueDate: "2026-11-20" }),
          issue({ id: "due-earliest", identifier: "ENG-9", projectId: "p1", stateType: "started", dueDate: "2026-11-01" }),
          issue({ id: "other-project", identifier: "ENG-1", projectId: "p2", stateType: "unstarted", dueDate: "2020-01-01" }),
          issue({ id: "no-due-earlier-num", identifier: "ENG-3", projectId: "p1", stateType: "completed" }),
          issue({ id: "due-later-num", identifier: "ENG-8", projectId: "p1", stateType: "backlog", dueDate: "2026-11-20" }),
          issue({ id: "canceled", identifier: "ENG-4", projectId: "p1", stateType: "canceled", dueDate: "2020-01-01" }),
        ],
      ),
    );
    expect(report.tasks.map((task) => task.id)).toEqual([
      "due-earliest",
      "due-early-num",
      "due-later-num",
      "no-due-earlier-num",
      "late-num",
      "other-project",
    ]);
  });

  test("シート1 だけのときは活動一覧と WBS を足し、シート1 は触らない", () => {
    const requests = asRequests(buildReport(input([{ id: "p", name: "P" }], [])), [{ sheetId: 0, title: "シート1" }]);
    expect(requests.filter((request) => request.addSheet)).toEqual([
      { addSheet: { properties: { sheetId: ACTIVITY_SHEET, title: "活動一覧", index: 0 } } },
      { addSheet: { properties: { sheetId: WBS_SHEET, title: "WBS", index: 1 } } },
    ]);
    expect(collectSheetIds(requests)).not.toContain(0);
    expect(new Set(collectSheetIds(requests))).toEqual(new Set([ACTIVITY_SHEET, WBS_SHEET]));
  });

  test("既存の活動一覧には addSheet せず、その sheetId に書く", () => {
    const report = buildReport(input([{ id: "p", name: "P" }], []));
    const requests = asRequests(report, [
      { sheetId: 0, title: "シート1" },
      { sheetId: 55, title: "活動一覧" },
    ]);
    expect(requests.filter((request) => request.addSheet?.properties?.title === "活動一覧")).toEqual([]);
    expect(requests.some((request) => request.updateCells?.start?.sheetId === 55)).toBe(true);
    expect(requests.filter((request) => request.addSheet).map((request) => request.addSheet?.properties?.title)).toEqual(["WBS"]);

    const both = asRequests(report, [
      { sheetId: 0, title: "シート1" },
      { sheetId: 55, title: "活動一覧" },
      { sheetId: 66, title: "WBS" },
    ]);
    expect(both.filter((request) => request.addSheet)).toEqual([]);
    expect(both.some((request) => request.updateCells?.start?.sheetId === 55)).toBe(true);
    expect(both.some((request) => request.updateCells?.start?.sheetId === 66)).toBe(true);
    expect(collectSheetIds(both)).not.toContain(0);
  });

  test("式として読まれるタイトルは作業セルだけ HYPERLINK にし、引用符を重ねる", () => {
    const report = buildReport(
      input(
        [{ id: "p", name: "対象" }],
        [
          issue({
            id: "evil",
            identifier: "ENG-7",
            title: EVIL_TITLE,
            descriptionText: EVIL_TITLE,
            projectId: "p",
            stateType: "unstarted",
          }),
        ],
      ),
    );
    const row = cellRows(asRequests(report, [{ sheetId: 0, title: "シート1" }]), WBS_SHEET).find((candidate) =>
      candidate.values?.some((cell) => JSON.stringify(cell.userEnteredValue ?? {}).includes("IMPORTXML")),
    );
    expect(row).toBeTruthy();
    const values = row?.values ?? [];
    expect(values[2]?.userEnteredValue).toEqual({
      formulaValue: `=HYPERLINK("http://localhost/sheets-e2e/issue/ENG-7","ENG-7 ${EVIL_TITLE.replaceAll('"', '""')}")`,
    });
    expect(values[3]?.userEnteredValue).toEqual({ stringValue: EVIL_TITLE });
    for (const [index, cell] of values.entries()) {
      if (index === 2) continue;
      expect(cell.userEnteredValue?.formulaValue).toBeUndefined();
    }
  });

  test("origin が null のときはリンクを作らない", () => {
    const report = buildReport(
      input(
        [{ id: "p", name: "対象" }],
        [issue({ id: "evil", identifier: "ENG-7", title: EVIL_TITLE, projectId: "p", stateType: "unstarted" })],
        null,
      ),
    );
    const requests = asRequests(report, [{ sheetId: 0, title: "シート1" }]);
    const work = cellRows(requests, WBS_SHEET)
      .flatMap((row) => row.values ?? [])
      .find((cell) => cell.userEnteredValue?.stringValue?.includes("IMPORTXML"));
    expect(work?.userEnteredValue).toEqual({ stringValue: `ENG-7 ${EVIL_TITLE}` });
    const activity = cellRows(requests, ACTIVITY_SHEET).find((row) => row.values?.[0]?.userEnteredValue?.stringValue === "対象");
    expect(activity?.values?.[0]?.userEnteredValue).toEqual({ stringValue: "対象" });
  });

  test("ID 列は隠す", () => {
    const requests = asRequests(buildReport(input([{ id: "p", name: "P" }], [])), [{ sheetId: 0, title: "シート1" }]);
    const hidden = requests.filter((request) => request.updateDimensionProperties?.properties?.hiddenByUser === true);
    expect(hidden.map((request) => request.updateDimensionProperties)).toEqual([
      {
        range: { sheetId: ACTIVITY_SHEET, dimension: "COLUMNS", startIndex: 4, endIndex: 5 },
        properties: { hiddenByUser: true },
        fields: "hiddenByUser",
      },
      {
        range: { sheetId: WBS_SHEET, dimension: "COLUMNS", startIndex: 10, endIndex: 11 },
        properties: { hiddenByUser: true },
        fields: "hiddenByUser",
      },
    ]);
  });
});

test.describe.serial("模擬 Google サーバーでの反映", () => {
  test.describe.configure({ timeout: 90_000 });

  let server: Server | undefined;
  let context: BrowserContext | undefined;
  let page: Page;
  let ws = "";
  let overdueId = "";
  let completedStateId = "";

  test.beforeAll(async ({ browser }) => {
    resetGoogle();
    server = await startGoogle();
    context = await browser.newContext({
      baseURL: test.info().project.use.baseURL,
      locale: "ja-JP",
      timezoneId: "Asia/Tokyo",
      viewport: { width: 1360, height: 860 },
    });
    page = await context.newPage();
    const signed = await signupViaUi(page, { workspace: "Sheets E2E" });
    expect(
      signed.ws,
      `url_key が sheets-e2e ではありません（実際は ${signed.ws}）。「Sheets E2E」の slugify が変わったか、同じキーがすでに使われています`,
    ).toBe("sheets-e2e");
    ws = signed.ws;

    const bootRes = await page.request.get(`/api/bootstrap?ws=${encodeURIComponent(ws)}`);
    if (!bootRes.ok()) throw new Error(`bootstrap が失敗しました (${bootRes.status()}): ${await bootRes.text()}`);
    const data = (await bootRes.json()) as BootstrapPayload;
    const team = data.teams.find((item) => item.key === "ENG") ?? data.teams[0];
    if (!team) throw new Error("チームがありません");
    completedStateId = stateId(data, team.id, "completed", "完了");
    const startedId = stateId(data, team.id, "started", "進行中");
    const backlogId = stateId(data, team.id, "backlog", "バックログ");
    const unstartedId = stateId(data, team.id, "unstarted", "未着手");
    const canceledId = stateId(data, team.id, "canceled", "キャンセル");

    const labelId = randomUUID();
    const projectId = randomUUID();
    const doneId = randomUUID();
    overdueId = randomUUID();
    const holdId = randomUUID();
    const openId = randomUUID();
    const cancelId = randomUUID();
    await mutate(page, ws, [
      { type: "label.create", args: { id: labelId, name: "工程:企画・設計", color: "#6470e8" } },
      { type: "project.create", args: { id: projectId, name: "シート連携テスト", teamIds: [team.id] } },
      {
        type: "issue.create",
        args: {
          id: doneId,
          teamId: team.id,
          projectId,
          title: "完了した作業",
          stateId: completedStateId,
          labelIds: [labelId],
        },
      },
      {
        type: "issue.create",
        args: {
          id: overdueId,
          teamId: team.id,
          projectId,
          title: "期限を過ぎた作業",
          stateId: startedId,
          dueDate: "2020-01-10",
        },
      },
      {
        type: "issue.create",
        args: {
          id: holdId,
          teamId: team.id,
          projectId,
          title: "保留の作業",
          stateId: backlogId,
          dueDate: "2026-12-01",
        },
      },
      {
        type: "issue.create",
        args: { id: openId, teamId: team.id, projectId, title: DANGEROUS_TITLE, stateId: unstartedId },
      },
      {
        type: "issue.create",
        args: { id: cancelId, teamId: team.id, projectId, title: "キャンセルした作業", stateId: canceledId },
      },
    ]);

    const statusRes = await page.request.get(`/api/sheets/status?ws=${encodeURIComponent(ws)}`);
    const statusText = await statusRes.text();
    if (!statusRes.ok()) throw new Error(`連携状態の取得に失敗しました (${statusRes.status()}): ${statusText}`);
    expect(JSON.parse(statusText).enabled, `sheets-e2e で連携が無効です: ${statusText}`).toBe(true);
  });

  test.afterAll(async () => {
    await context?.close();
    if (!server) return;
    server.closeAllConnections?.();
    await new Promise<void>((resolve, reject) => {
      server?.close((err) => (err ? reject(err) : resolve()));
    });
  });

  test("今すぐ反映で 2 つのタブが作られ、集計が正しい", async () => {
    await page.goto(`/${ws}/settings/workspace`);
    await expect(page.getByTestId("sheets-sync-now")).toBeVisible();
    const before = google.batches.length;
    await page.getByTestId("sheets-sync-now").click();
    await expect(page.getByTestId("toast").filter({ hasText: "スプレッドシートに反映しました" })).toBeVisible();
    await expect(page.getByTestId("sheets-last-sync")).not.toContainText("まだ反映していません");
    await expect.poll(() => google.batches.length).toBeGreaterThan(before);

    const token = google.tokens[0];
    expect(token, "トークン要求がありません").toBeTruthy();
    const parts = token.assertion.split(".");
    expect(parts).toHaveLength(3);
    const [headerPart, payloadPart, signature] = parts;
    const header = JSON.parse(Buffer.from(headerPart, "base64url").toString("utf8")) as { alg?: string };
    const payload = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8")) as {
      iss?: string;
      scope?: string;
      aud?: string;
    };
    expect(header.alg).toBe("RS256");
    expect(payload.iss).toBe(CLIENT_EMAIL);
    expect(payload.scope).toBe("https://www.googleapis.com/auth/spreadsheets");
    expect(payload.aud).toBe(`http://localhost:${GOOGLE_PORT}/oauth2/token`);
    expect(fs.existsSync(PUBLIC_KEY_PATH), `${PUBLIC_KEY_PATH} がありません`).toBe(true);
    expect(
      verify(
        "RSA-SHA256",
        Buffer.from(`${headerPart}.${payloadPart}`),
        fs.readFileSync(PUBLIC_KEY_PATH),
        Buffer.from(signature, "base64url"),
      ),
    ).toBe(true);

    const latest = google.batches.at(-1);
    if (!latest) throw new Error("batchUpdate が記録されていません");
    const activity = sheetRows(latest, ACTIVITY_SHEET).find((row) => row.some((cell) => cell.includes("シート連携テスト")));
    expect(activity, "活動一覧にシート連携テストがありません").toBeTruthy();
    expect(activity?.[1]).toBe("2020/01/10（未設定1件）");
    expect(activity?.[2]).toBe("25%（1/4）");
    expect(activity?.[3]).toBe("期限超過");

    const wbs = sheetRows(latest, WBS_SHEET).filter((row) => row[0] === "シート連携テスト");
    expect(wbs).toHaveLength(4);
    const titles = wbs.map((row) => row[2]);
    expect(titles.some((cell) => cell.includes("キャンセルした作業"))).toBe(false);
    const done = wbs.find((row) => row[2].includes("完了した作業"));
    expect(done?.[1]).toBe("企画・設計");
    for (const row of wbs) expect(row[2].startsWith("=HYPERLINK(")).toBe(true);
    const dangerous = wbs.find((row) => row[2].includes("危険"));
    expect(dangerous, "式を含むタイトルの行がありません").toBeTruthy();
    expect(dangerous?.[2]).toContain('=""危険""');
  });

  test("保存すると自動で反映される", async () => {
    const before = google.batches.length;
    await mutate(page, ws, [{ type: "issue.update", args: { id: overdueId, patch: { stateId: completedStateId } } }]);
    await expect.poll(() => google.batches.length, { timeout: 15_000 }).toBeGreaterThan(before);
    const latest = google.batches.at(-1);
    if (!latest) throw new Error("自動反映の batchUpdate がありません");
    const activity = sheetRows(latest, ACTIVITY_SHEET).find((row) => row.some((cell) => cell.includes("シート連携テスト")));
    expect(activity?.[2]).toBe("50%（2/4）");
    expect(activity?.[3]).toBe("保留あり");
  });

  test("失敗したら理由が表示される", async () => {
    google.failNext = 403;
    await page.getByTestId("sheets-sync-now").click();
    const error = page.getByTestId("sheets-error");
    await expect(error).toContainText("編集者として共有");
    await expect(error).toContainText(CLIENT_EMAIL);
    await expect(page.getByTestId("sheets-sync-now")).toBeEnabled();
    await page.getByTestId("sheets-sync-now").click();
    await expect(page.getByTestId("sheets-error")).toHaveCount(0);
  });

  test("連携の対象でないワークスペースでは区画が出ない", async () => {
    const { ws: other } = await signupViaUi(page, { workspace: "別のワークスペース" });
    expect(other).not.toBe("sheets-e2e");
    const seen = page.waitForResponse((res) => res.url().includes("/api/sheets/status") && res.request().method() === "GET");
    await page.goto(`/${other}/settings/workspace`);
    expect(await (await seen).json()).toEqual({ enabled: false });
    await expect(page.getByTestId("settings-page")).toBeVisible();
    await expect(page.getByTestId("sheets-sync-now")).toHaveCount(0);
    const direct = await page.request.get(`/api/sheets/status?ws=${encodeURIComponent(other)}`);
    expect(direct.ok()).toBeTruthy();
    expect(await direct.json()).toEqual({ enabled: false });
  });
});
