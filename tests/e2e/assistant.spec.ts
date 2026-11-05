import fs from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import type { BootstrapPayload } from "../../shared/types";
import { signupViaUi, uniqueEmail } from "./helpers";

const ANTHROPIC_PORT = Number(process.env.E2E_ANTHROPIC_PORT ?? 4330);
const QUESTION = "サイクルはどこで見られますか？";
const FIRST_TEXT = "サイクルはチームの画面にあります。";
const SECOND_TEXT = "ボタンから開けます。";

interface ToolSpec {
  name: string;
  input: Record<string, unknown>;
}

interface MockTextTurn {
  text?: string;
  tools?: ToolSpec[];
  stopReason?: "end_turn" | "tool_use" | "max_tokens" | "refusal";
}

interface MockErrorTurn {
  error: { status: number; body: unknown };
}

type MockTurn = MockTextTurn | MockErrorTurn;

interface ContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  is_error?: boolean;
}

interface AnthropicMessage {
  role: string;
  content: string | ContentBlock[];
}

interface AnthropicBody {
  model?: string;
  temperature?: number;
  system?: { type?: string; text?: string; cache_control?: { type?: string } }[];
  tools?: { name?: string }[];
  messages?: AnthropicMessage[];
}

interface RecordedRequest {
  headers: Record<string, string>;
  body: AnthropicBody;
  raw: string;
}

const anthropic = {
  requests: [] as RecordedRequest[],
  queue: [] as MockTurn[],
};

let toolSeq = 0;

function isErrorTurn(turn: MockTurn): turn is MockErrorTurn {
  return "error" in turn;
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

function headerMap(req: IncomingMessage): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (value == null) continue;
    headers[key] = Array.isArray(value) ? value.join(", ") : value;
  }
  return headers;
}

function sseEvent(type: string, data: unknown): string {
  return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** Anthropic Messages API のストリーミング（公式 SDK が読む SSE） */
function streamBody(turn: MockTextTurn): string {
  const stopReason = turn.stopReason ?? (turn.tools?.length ? "tool_use" : "end_turn");
  const parts: string[] = [];
  parts.push(
    sseEvent("message_start", {
      type: "message_start",
      message: {
        id: `msg_e2e_${++toolSeq}`,
        type: "message",
        role: "assistant",
        content: [],
        model: "claude-haiku-5-5",
        stop_reason: null,
        stop_sequence: null,
        stop_details: null,
        container: null,
        usage: {
          input_tokens: 10,
          output_tokens: 1,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    }),
  );
  let index = 0;
  if (turn.text) {
    parts.push(
      sseEvent("content_block_start", {
        type: "content_block_start",
        index,
        content_block: { type: "text", text: "", citations: null },
      }),
    );
    parts.push(
      sseEvent("content_block_delta", {
        type: "content_block_delta",
        index,
        delta: { type: "text_delta", text: turn.text },
      }),
    );
    parts.push(sseEvent("content_block_stop", { type: "content_block_stop", index }));
    index += 1;
  }
  for (const tool of turn.tools ?? []) {
    const id = `toolu_e2e_${++toolSeq}`;
    parts.push(
      sseEvent("content_block_start", {
        type: "content_block_start",
        index,
        content_block: { type: "tool_use", id, name: tool.name, input: {}, caller: { type: "direct" } },
      }),
    );
    parts.push(
      sseEvent("content_block_delta", {
        type: "content_block_delta",
        index,
        delta: { type: "input_json_delta", partial_json: JSON.stringify(tool.input) },
      }),
    );
    parts.push(sseEvent("content_block_stop", { type: "content_block_stop", index }));
    index += 1;
  }
  parts.push(
    sseEvent("message_delta", {
      type: "message_delta",
      delta: { stop_reason: stopReason, stop_sequence: null, stop_details: null },
      usage: { output_tokens: 16 },
    }),
  );
  parts.push(sseEvent("message_stop", { type: "message_stop" }));
  return parts.join("");
}

async function handleAnthropic(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${ANTHROPIC_PORT}`);
  const raw = await readBody(req);
  if (req.method !== "POST" || url.pathname !== "/v1/messages") {
    sendJson(res, 404, { type: "error", error: { type: "not_found_error", message: `${req.method} ${url.pathname}` } });
    return;
  }
  let body: AnthropicBody = {};
  try {
    body = JSON.parse(raw) as AnthropicBody;
  } catch {
    body = {};
  }
  anthropic.requests.push({ headers: headerMap(req), body, raw });
  const next = anthropic.queue.shift();
  if (!next) {
    sendJson(res, 400, { type: "error", error: { type: "invalid_request_error", message: "no scripted response" } });
    return;
  }
  if (isErrorTurn(next)) {
    sendJson(res, next.error.status, next.error.body);
    return;
  }
  res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" });
  res.end(streamBody(next));
}

function startAnthropic(): Promise<Server> {
  const server = createServer((req, res) => {
    void handleAnthropic(req, res).catch((err) => {
      console.error("mock anthropic failed", err instanceof Error ? err.message : err);
      if (!res.headersSent) sendJson(res, 500, { type: "error", error: { type: "api_error", message: "mock failure" } });
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(ANTHROPIC_PORT, "127.0.0.1", () => {
      server.off("error", reject);
      resolve(server);
    });
  });
}

function blocksOf(content: string | ContentBlock[]): ContentBlock[] {
  return typeof content === "string" ? [{ type: "text", text: content }] : content;
}

function messageText(message: AnthropicMessage): string {
  return blocksOf(message.content)
    .map((block) => block.text ?? "")
    .filter(Boolean)
    .join("\n");
}

/** 最後のテキスト。画面の文と質問が分かれているときは、質問の方 */
function lastText(message: AnthropicMessage): string {
  const texts = blocksOf(message.content)
    .map((block) => block.text)
    .filter((text): text is string => typeof text === "string" && text.length > 0);
  return texts.at(-1) ?? "";
}

function requestBody(index: number): AnthropicBody {
  const recorded = anthropic.requests[index];
  if (!recorded) throw new Error(`模擬サーバーへのリクエストが ${index + 1} 件目まで来ていません`);
  return recorded.body;
}

function cyclesChapterSeconds(chapter: number): number {
  const manifest = JSON.parse(fs.readFileSync(path.join(process.cwd(), "public/tutorials/manifest.json"), "utf8")) as {
    tutorials: { id: string; chapters: { t: number }[] }[];
  };
  const tutorial = manifest.tutorials.find((item) => item.id === "cycles");
  const step = tutorial?.chapters[chapter - 1];
  if (!step) throw new Error(`cycles のステップ ${chapter} がありません`);
  return step.t;
}

async function loadBootstrap(page: Page, ws: string): Promise<BootstrapPayload> {
  const res = await page.request.get(`/api/bootstrap?ws=${encodeURIComponent(ws)}`, {
    headers: { "x-sen-client": "1" },
  });
  const text = await res.text();
  expect(res.ok(), text).toBeTruthy();
  return JSON.parse(text) as BootstrapPayload;
}

async function signUp(page: Page) {
  const nonce = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const displayName = `表示名-${nonce}`;
  const workspaceName = `AI非送信チェック-${nonce}`;
  const email = uniqueEmail("assistant");
  const signed = await signupViaUi(page, { name: displayName, email, workspace: workspaceName });
  await expect(page.getByTestId("nav-assistant")).toBeVisible();
  return signed;
}

async function openPanel(page: Page) {
  await page.getByTestId("nav-assistant").click();
  await expect(page.getByTestId("assistant-panel")).toBeVisible();
}

async function ask(page: Page, text: string) {
  const input = page.getByTestId("assistant-input");
  await expect(input).toBeEnabled();
  await input.fill(text);
  await page.getByTestId("assistant-send").click();
}

test.describe("AI アシスタント", () => {
  test.describe.configure({ timeout: 90_000 });
  let server: Server | undefined;

  test.beforeAll(async () => {
    server = await startAnthropic();
  });

  test.afterAll(async () => {
    if (!server) return;
    server.closeAllConnections?.();
    await new Promise<void>((resolve, reject) => {
      server?.close((err) => (err ? reject(err) : resolve()));
    });
  });

  test.beforeEach(() => {
    anthropic.requests = [];
    anthropic.queue = [];
  });

  test("質問がストリーミングされ、画面を開くボタンと動画が出る", async ({ page }) => {
    const { ws, email } = await signUp(page);
    const boot = await loadBootstrap(page, ws);
    const titles = [...new Set(boot.issues.map((issue) => issue.title))].filter((title) => title.length > 0);
    expect(titles.length).toBeGreaterThanOrEqual(3);
    const team = boot.teams[0];
    expect(team).toBeTruthy();

    await openPanel(page);
    await expect(page.getByTestId("assistant-remaining")).toHaveText("今日はあと 3 回");

    anthropic.queue.push({
      text: FIRST_TEXT,
      tools: [
        { name: "open_screen", input: { screen: "team-cycles" } },
        { name: "play_tutorial", input: { tutorial: "cycles", chapter: 2 } },
      ],
      stopReason: "tool_use",
    });
    anthropic.queue.push({ text: SECOND_TEXT, stopReason: "end_turn" });

    await ask(page, QUESTION);

    const assistant = page.locator("[data-testid=assistant-message][data-role=assistant]");
    await expect(assistant).toContainText(FIRST_TEXT);
    await expect(assistant).toContainText(SECOND_TEXT);
    await expect(page.getByTestId("assistant-open-screen")).toBeEnabled();
    await expect(page.getByTestId("assistant-open-screen")).toContainText("開く");
    await expect(page.getByTestId("assistant-tutorial")).toBeVisible();
    await expect(page.getByTestId("assistant-remaining")).toHaveText("今日はあと 2 回");

    await expect.poll(() => anthropic.requests.length).toBe(2);
    const first = anthropic.requests[0]!;
    const body = first.body;
    expect(body.model).toBe("claude-haiku-5-5");
    expect(body.system?.[0]?.cache_control?.type).toBe("ephemeral");
    expect(body.tools?.map((tool) => tool.name)).toEqual(["open_screen", "play_tutorial", "ask_user"]);
    expect(body).not.toHaveProperty("temperature");
    // 公式 SDK（@anthropic-ai/sdk 1.3.0）は API キーを Authorization: Bearer で送る
    expect(first.headers.authorization).toBe("Bearer e2e-anthropic-key");

    const firstUser = [...(body.messages ?? [])].reverse().find((message) => message.role === "user");
    expect(firstUser).toBeTruthy();
    expect(messageText(firstUser!)).toContain("いま開いている画面");

    const leaked = [boot.workspace.name, email, boot.me.name, boot.me.email, ...titles];
    const rawBodies = [first.raw, JSON.stringify(first.body)];
    for (const secret of leaked) {
      for (const raw of rawBodies) expect(raw, secret).not.toContain(secret);
    }

    const second = requestBody(1);
    const echoed = (second.messages ?? []).find((message) => message.role === "assistant");
    expect(echoed).toBeTruthy();
    const echoedBlocks = blocksOf(echoed!.content);
    expect(echoedBlocks.find((block) => block.type === "text")?.text).toBe(FIRST_TEXT);
    const toolUses = echoedBlocks.filter((block) => block.type === "tool_use");
    expect(toolUses.map((block) => ({ name: block.name, input: block.input }))).toEqual([
      { name: "open_screen", input: { screen: "team-cycles" } },
      { name: "play_tutorial", input: { tutorial: "cycles", chapter: 2 } },
    ]);
    const followUp = second.messages?.at(-1);
    expect(followUp?.role).toBe("user");
    const results = blocksOf(followUp!.content).filter((block) => block.type === "tool_result");
    expect(results).toHaveLength(toolUses.length);
    for (const call of toolUses) {
      const result = results.find((block) => block.tool_use_id === call.id);
      expect(result, call.id).toBeTruthy();
      expect(result?.is_error ?? false).toBe(false);
    }

    await page.getByTestId("assistant-open-screen").click();
    await expect(page).toHaveURL(new RegExp(`/${ws}/team/${team!.key}/cycles$`));

    const seconds = cyclesChapterSeconds(2);
    await page.getByTestId("assistant-tutorial-play").click();
    await expect(page.getByTestId("video-modal")).toBeVisible();
    await expect
      .poll(() => page.getByTestId("tutorial-video").evaluate((el: HTMLVideoElement) => el.currentTime))
      .toBeGreaterThanOrEqual(seconds);
  });

  test("聞き返しの選択肢を押すと、その答えが次の質問になる", async ({ page }) => {
    await signUp(page);
    await openPanel(page);
    anthropic.queue.push({
      tools: [{ name: "ask_user", input: { question: "どちらを作りますか？", options: ["課題", "プロジェクト"] } }],
      stopReason: "tool_use",
    });
    await ask(page, "新しく作りたい");
    const options = page.getByTestId("assistant-ask-option");
    await expect(options).toHaveCount(2);
    await expect(page.getByText("どちらを作りますか？")).toBeVisible();

    anthropic.queue.push({ text: "課題の作り方です。", stopReason: "end_turn" });
    await options.filter({ hasText: /^課題$/ }).click();

    await expect.poll(() => anthropic.requests.length).toBe(2);
    const messages = requestBody(1).messages ?? [];
    const user = messages.at(-1);
    expect(user?.role).toBe("user");
    expect(lastText(user!)).toBe("課題");
    const prev = messages.at(-2);
    expect(prev?.role).toBe("assistant");
    const summary = messageText(prev!);
    expect(summary).toContain("どちらを作りますか？");
    expect(summary).toContain("「課題」");
    expect(summary).toContain("「プロジェクト」");

    await expect(page.locator("[data-testid=assistant-message][data-role=assistant]").last()).toContainText("課題の作り方です。");
    await expect(options).toHaveCount(2);
    await expect(options.nth(0)).toBeDisabled();
    await expect(options.nth(1)).toBeDisabled();
  });

  test("不正なツールの入力はエラーになり、動画のカードは出ない", async ({ page }) => {
    await signUp(page);
    await openPanel(page);
    anthropic.queue.push({
      tools: [{ name: "play_tutorial", input: { tutorial: "cycles", chapter: 99 } }],
      stopReason: "tool_use",
    });
    anthropic.queue.push({ text: "ステップを確認できませんでした。", stopReason: "end_turn" });
    await ask(page, "動画を見せて");

    await expect.poll(() => anthropic.requests.length).toBe(2);
    await expect(page.locator("[data-testid=assistant-message][data-role=assistant]")).toContainText("ステップを確認できませんでした。");
    const messages = requestBody(1).messages ?? [];
    const results = blocksOf(messages.at(-1)?.content ?? []).filter((block) => block.type === "tool_result");
    expect(results).toHaveLength(1);
    expect(results[0]?.is_error).toBe(true);
    await expect(page.getByTestId("assistant-tutorial")).toHaveCount(0);
  });

  test("1 日の回数を使い切ると入力できなくなり、次は 429 になる", async ({ page }) => {
    const { ws } = await signUp(page);
    await openPanel(page);
    for (let i = 1; i <= 3; i++) anthropic.queue.push({ text: `${i} 件目の答えです。`, stopReason: "end_turn" });
    for (let i = 1; i <= 3; i++) {
      await ask(page, `質問${i}`);
      await expect(page.getByTestId("assistant-remaining")).toHaveText(`今日はあと ${3 - i} 回`);
    }
    await expect(page.getByTestId("assistant-input")).toBeDisabled();

    const res = await page.request.post(`/api/assistant?ws=${encodeURIComponent(ws)}`, {
      headers: { "x-sen-client": "1" },
      data: { messages: [{ role: "user", text: "4回目です" }], screen: null },
    });
    expect(res.status()).toBe(429);
    expect(await res.text()).toContain("上限");
  });

  test("AI 側のエラーでは回数を戻す", async ({ page }) => {
    await signUp(page);
    await openPanel(page);
    await expect(page.getByTestId("assistant-remaining")).toHaveText("今日はあと 3 回");
    anthropic.queue.push({
      error: {
        status: 400,
        body: { type: "error", error: { type: "invalid_request_error", message: "リクエストが不正です" } },
      },
    });
    await ask(page, "これは失敗する質問");
    await expect(page.getByTestId("assistant-error")).toBeVisible();
    await expect(page.getByTestId("assistant-remaining")).toHaveText("今日はあと 3 回");
    await expect(page.getByTestId("assistant-input")).toBeEnabled();
  });

  test("コマンドパレットから AI に聞ける", async ({ page }) => {
    await signUp(page);
    anthropic.queue.push({ text: "設定のラベルから付けられます。", stopReason: "end_turn" });
    await page.keyboard.press("Control+k");
    await expect(page.getByTestId("command-palette")).toBeVisible();
    await page.getByTestId("palette-input").fill("ラベルの付け方");
    const items = page.getByTestId("palette-item");
    await expect(items.last()).toHaveAttribute("data-command", "ask-ai");
    await expect(items.last()).toContainText("AI に聞く");
    const count = await items.count();
    for (let i = 1; i < count; i++) await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");

    await expect(page.getByTestId("assistant-panel")).toBeVisible();
    await expect(page.locator("[data-testid=assistant-message][data-role=user]")).toContainText("ラベルの付け方");
    await expect.poll(() => anthropic.requests.length).toBe(1);
    const user = [...(requestBody(0).messages ?? [])].reverse().find((message) => message.role === "user");
    expect(lastText(user!)).toBe("ラベルの付け方");
  });

  test("新しい利用者の status は有効で、残りは上限と同じ", async ({ page }) => {
    const { ws } = await signUp(page);
    const res = await page.request.get(`/api/assistant/status?ws=${encodeURIComponent(ws)}`, {
      headers: { "x-sen-client": "1" },
    });
    expect(res.ok()).toBeTruthy();
    expect(await res.json()).toEqual({ enabled: true, limit: 3, remaining: 3 });
  });
});
