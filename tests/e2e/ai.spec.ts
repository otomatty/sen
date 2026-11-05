import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { ApiTokenCreateRequest, ApiTokenCreateResponse } from "../../shared/types";
import { inviteByEmail, joinByInvite, seedDemo, signupViaUi, uniqueEmail } from "./helpers";

const PARENT = "決済画面の改善";
const SUB1 = "決済の入力欄を短くする";
const SUB2 = "決済のエラー文言を直す";
const WRITE_TOOLS = ["create_issues", "update_issues", "add_comment", "link_issues"];
const READ_TOOLS = ["get_workspace", "search_issues", "get_issue"];

const INIT_BODY = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "e2e", version: "1.0.0" },
  },
};

type ToolResult = Awaited<ReturnType<Client["callTool"]>>;

function toolText(result: ToolResult): { text: string; isError: boolean } {
  if (!("content" in result) || !Array.isArray(result.content)) throw new Error("ツールの結果に content がありません");
  const first = result.content[0];
  if (!first || first.type !== "text") throw new Error("ツールの結果がテキストではありません");
  return { text: first.text, isError: result.isError === true };
}

async function issueToken(page: Page, ws: string, body: ApiTokenCreateRequest): Promise<ApiTokenCreateResponse> {
  const r = await page.request.post(`/api/tokens?ws=${encodeURIComponent(ws)}`, {
    headers: { "x-sen-client": "1" },
    data: body,
  });
  if (!r.ok()) throw new Error(`トークンの発行に失敗しました (${r.status()}): ${await r.text()}`);
  return r.json() as Promise<ApiTokenCreateResponse>;
}

async function connectMcp(baseURL: string, secret: string) {
  const client = new Client({ name: "e2e", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${baseURL}/api/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${secret}` } },
  });
  await client.connect(transport);
  return client;
}

async function callJson<T>(client: Client, name: string, args: Record<string, unknown> = {}): Promise<T> {
  const { text, isError } = toolText(await client.callTool({ name, arguments: args }));
  if (isError) throw new Error(text);
  return JSON.parse(text) as T;
}

async function callError(client: Client, name: string, args: Record<string, unknown> = {}): Promise<string> {
  const { text, isError } = toolText(await client.callTool({ name, arguments: args }));
  expect(isError).toBe(true);
  return text;
}

function titleRow(page: Page, title: string) {
  return page.locator("[data-testid=issue-row]").filter({
    has: page.locator(".row-title-text", { hasText: new RegExp(`^${title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`) }),
  });
}

async function postMcp(request: APIRequestContext, headers: Record<string, string> = {}) {
  return request.post("/api/mcp", {
    headers: { "content-type": "application/json", ...headers },
    data: INIT_BODY,
  });
}

test("画面からトークンを発行して、設定方法をコピーできる", async ({ page }) => {
  test.setTimeout(90_000);
  const baseURL = test.info().project.use.baseURL!;
  const port = new URL(baseURL).port;
  const { ws } = await signupViaUi(page);
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto(`/${ws}/settings/workspace`);
  await page.getByTestId("settings-nav-ai").click();
  await expect(page.getByTestId("ai-connect")).toBeVisible();
  await expect(page.getByTestId("ai-client-claude-code")).toHaveAttribute("aria-pressed", "true");

  await page.getByTestId("ai-token-create").click();
  const issued = page.getByTestId("ai-issued");
  await expect(issued).toContainText(
    `claude mcp add --scope user --transport http sen http://localhost:${port}/api/mcp --header "Authorization: Bearer sen_`,
  );
  const secret = (await issued.locator("code").innerText()).match(/sen_[A-Za-z0-9_-]{43}/)?.[0];
  expect(secret).toBeTruthy();

  await page.getByTestId("ai-copy").click();
  await expect(page.getByTestId("ai-copy")).toContainText("コピーしました");
  await page.getByTestId("ai-issued-done").click();
  await expect(page.getByTestId("ai-token-create")).toBeVisible();
  await expect(page.getByTestId("confirm-dialog")).toHaveCount(0);

  const claudeRow = page.getByTestId("ai-token-row").filter({ hasText: "Claude Code" });
  await expect(claudeRow).toContainText("作成と変更");
  await expect(claudeRow).toContainText("まだ使われていません");
  await page.reload();
  await expect(page.getByTestId("ai-token-row").filter({ hasText: "Claude Code" })).toBeVisible();
  await expect(page.getByTestId("ai-token-row")).toContainText("まだ使われていません");
  expect(await page.content()).not.toMatch(/sen_[A-Za-z0-9_-]{43}/);
  await expect(page.locator("body")).toContainText(/sen_…[A-Za-z0-9_-]{4}/);

  await page.getByTestId("ai-client-cursor").click();
  await expect(page.getByTestId("ai-client-cursor")).toHaveAttribute("aria-pressed", "true");
  await page.getByTestId("ai-token-create").click();
  const href = await page.getByTestId("ai-cursor-install").getAttribute("href");
  expect(href?.startsWith("cursor://anysphere.cursor-deeplink/mcp/install?name=sen&config=")).toBe(true);
  const encoded = new URL(href!).searchParams.get("config");
  const config = JSON.parse(Buffer.from(encoded ?? "", "base64").toString("utf8")) as {
    url: string;
    headers: { Authorization: string };
  };
  expect(config.url).toBe(`${baseURL}/api/mcp`);
  expect(config.headers.Authorization).toMatch(/^Bearer sen_[A-Za-z0-9_-]{43}$/);

  await page.getByTestId("ai-issued-done").click();
  await expect(page.getByTestId("confirm-dialog")).toContainText("設定をコピーしましたか？");
  await page.getByTestId("confirm-ok").click();
  await expect(page.getByTestId("ai-token-create")).toBeVisible();

  const row = page.getByTestId("ai-token-row").filter({ hasText: "Claude Code" });
  await row.getByTestId("ai-token-revoke").click();
  await expect(page.getByTestId("confirm-dialog")).toContainText("無効にする");
  await page.getByTestId("confirm-ok").click();
  await expect(page.getByTestId("ai-token-row").filter({ hasText: "Claude Code" })).toHaveCount(0);
  await expect(connectMcp(baseURL, secret!)).rejects.toThrow();
});

test("AI が課題をまとめて作り、画面にリアルタイムで「Claude Code 経由」と表示される", async ({ page }) => {
  test.setTimeout(120_000);
  const baseURL = test.info().project.use.baseURL!;
  const { ws } = await signupViaUi(page, { workspace: "AI 連携テスト" });
  await seedDemo(page.request, ws);
  const { secret } = await issueToken(page, ws, { client: "claude-code", scope: "write", expiresInDays: 90 });
  await page.goto(`/${ws}/team/ENG/all`);
  await expect(page.getByTestId("issue-list")).toBeVisible();
  await expect(page.getByTestId("sync-status")).toHaveAttribute("data-realtime", "on", { timeout: 15_000 });

  const client = await connectMcp(baseURL, secret);
  try {
    const listed = await client.listTools();
    const names = listed.tools.map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining([...READ_TOOLS, ...WRITE_TOOLS]));
    expect(client.getInstructions()).toContain("AI 連携テスト");

    const info = await callJson<{ teams: { key: string }[]; today: string }>(client, "get_workspace");
    expect(info.teams.map((team) => team.key)).toContain("ENG");
    expect(info.today).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    const created = await callJson<{
      created: { id: string; title: string; subIssues?: { id: string; title: string }[] }[];
    }>(client, "create_issues", {
      issues: [
        {
          team: "ENG",
          title: PARENT,
          priority: "high",
          assignee: "me",
          labels: ["改善"],
          description: "## 目的\n- 離脱を減らす\n- [ ] 計測を入れる",
          subIssues: [{ title: SUB1 }, { title: SUB2 }],
        },
      ],
    });
    expect(created.created).toHaveLength(1);
    const parent = created.created[0];
    expect(parent.id).toMatch(/^ENG-/);
    expect(parent.subIssues?.map((sub) => sub.title)).toEqual([SUB1, SUB2]);

    await expect(titleRow(page, PARENT)).toBeVisible();
    const titles = await page.locator("[data-testid=issue-group][data-group='未着手'] .row-title-text").allTextContents();
    expect(titles.indexOf(SUB2)).toBe(titles.indexOf(SUB1) + 1);

    await titleRow(page, PARENT).locator(".row-title-text").click();
    await expect(page.getByTestId("issue-title")).toHaveValue(PARENT);
    const description = page.getByTestId("issue-description");
    await expect(description.locator("h2")).toContainText("目的");
    await expect(description.locator("ul[data-type='taskList']")).toContainText("計測を入れる");
    await expect(description.getByRole("checkbox", { name: /計測を入れる/ })).toBeVisible();
    await expect(page.getByTestId("activity").getByTestId("via-badge").first()).toContainText("Claude Code 経由");
    await expect(page.getByTestId("sub-issues").locator(".row-title-text")).toHaveText([SUB1, SUB2]);

    const updated = await callJson<{ updated: { changes: string[] }[] }>(client, "update_issues", {
      updates: [{ issue: parent.id, status: "進行中" }],
    });
    expect(updated.updated[0].changes.join("\n")).toContain("ステータス");
    await expect(page.getByTestId("prop-status")).toContainText("進行中");

    await callJson(client, "add_comment", { issue: parent.id, body: "**確認しました**" });
    const comment = page.getByTestId("comment").filter({ hasText: "確認しました" });
    await expect(comment.locator("strong")).toHaveText("確認しました");
    await expect(comment.getByTestId("via-badge")).toContainText("Claude Code 経由");

    const found = await callJson<{ total: number; issues: { title: string }[] }>(client, "search_issues", { query: "決済" });
    const ours = found.issues.filter((issue) => [PARENT, SUB1, SUB2].includes(issue.title));
    expect(ours).toHaveLength(3);

    const detail = await callJson<{ description: string; subIssues?: { title: string }[] }>(client, "get_issue", { issue: parent.id });
    expect(detail.description).toContain("## 目的");
    expect(detail.subIssues).toHaveLength(2);

    const sub = parent.subIssues![0];
    await callJson(client, "link_issues", { issue: sub.id, type: "duplicate_of", target: parent.subIssues![1].id });
    const linked = await callJson<{ status: string }>(client, "get_issue", { issue: sub.id });
    expect(linked.status).toBe("重複");
    await page.goto(`/${ws}/issue/${sub.id}`);
    await expect(page.getByTestId("prop-status")).toContainText("重複");
  } finally {
    await client.close();
  }
});

test("名前を間違えると、候補つきのエラーになり何も作られない", async ({ page }) => {
  const baseURL = test.info().project.use.baseURL!;
  const { ws } = await signupViaUi(page);
  await seedDemo(page.request, ws);
  const { secret } = await issueToken(page, ws, { client: "claude-code", scope: "write", expiresInDays: 30 });
  const client = await connectMcp(baseURL, secret);
  try {
    const labelError = await callError(client, "create_issues", {
      issues: [
        { team: "ENG", title: "作られてはいけない課題" },
        { team: "ENG", title: "ラベルが違う", labels: ["存在しないラベル"] },
      ],
    });
    expect(labelError).toContain("存在しないラベル");
    expect(labelError).toContain("改善");
    const search = await callJson<{ total: number }>(client, "search_issues", { query: "作られてはいけない課題" });
    expect(search.total).toBe(0);

    const teamError = await callError(client, "create_issues", {
      issues: [{ team: "XYZ", title: "チーム違い" }],
    });
    expect(teamError).toContain("XYZ");
    expect(teamError).toContain("ENG");
  } finally {
    await client.close();
  }
});

test("互いを親にする更新は循環として拒否され、何も変わらない", async ({ page }) => {
  const baseURL = test.info().project.use.baseURL!;
  const { ws } = await signupViaUi(page);
  await seedDemo(page.request, ws);
  const { secret } = await issueToken(page, ws, { client: "claude-code", scope: "write", expiresInDays: 30 });
  const client = await connectMcp(baseURL, secret);
  try {
    const created = await callJson<{ created: { id: string }[] }>(client, "create_issues", {
      issues: [
        { team: "ENG", title: "循環の確認 A" },
        { team: "ENG", title: "循環の確認 B" },
      ],
    });
    const [a, b] = created.created;
    const error = await callError(client, "update_issues", {
      updates: [
        { issue: a.id, parent: b.id },
        { issue: b.id, parent: a.id },
      ],
    });
    expect(error).toContain("循環");
    const detailA = await callJson<{ parent?: string }>(client, "get_issue", { issue: a.id });
    const detailB = await callJson<{ parent?: string }>(client, "get_issue", { issue: b.id });
    expect(detailA.parent).toBeUndefined();
    expect(detailB.parent).toBeUndefined();

    await callJson(client, "update_issues", { updates: [{ issue: a.id, parent: b.id }] });
    const linked = await callJson<{ parent?: string }>(client, "get_issue", { issue: a.id });
    expect(linked.parent).toBe(b.id);
    const other = await callJson<{ parent?: string }>(client, "get_issue", { issue: b.id });
    expect(other.parent).toBeUndefined();
  } finally {
    await client.close();
  }
});

test("親子を入れ替える更新は、順番にかかわらず成功する", async ({ page }) => {
  const baseURL = test.info().project.use.baseURL!;
  const { ws } = await signupViaUi(page);
  await seedDemo(page.request, ws);
  const { secret } = await issueToken(page, ws, { client: "claude-code", scope: "write", expiresInDays: 30 });
  const client = await connectMcp(baseURL, secret);
  try {
    const created = await callJson<{ created: { id: string }[] }>(client, "create_issues", {
      issues: [
        { team: "ENG", title: "入れ替え A" },
        { team: "ENG", title: "入れ替え B" },
        { team: "ENG", title: "逆順 A" },
        { team: "ENG", title: "逆順 B" },
      ],
    });
    const [a, b, revA, revB] = created.created;

    await callJson(client, "update_issues", { updates: [{ issue: a.id, parent: b.id }] });
    await callJson(client, "update_issues", {
      updates: [
        { issue: a.id, parent: null },
        { issue: b.id, parent: a.id },
      ],
    });
    const detailA = await callJson<{ parent?: string }>(client, "get_issue", { issue: a.id });
    const detailB = await callJson<{ parent?: string }>(client, "get_issue", { issue: b.id });
    expect(detailB.parent).toBe(a.id);
    expect(detailA.parent).toBeUndefined();

    await callJson(client, "update_issues", { updates: [{ issue: revA.id, parent: revB.id }] });
    await callJson(client, "update_issues", {
      updates: [
        { issue: revB.id, parent: revA.id },
        { issue: revA.id, parent: null },
      ],
    });
    const detailRevA = await callJson<{ parent?: string }>(client, "get_issue", { issue: revA.id });
    const detailRevB = await callJson<{ parent?: string }>(client, "get_issue", { issue: revB.id });
    expect(detailRevB.parent).toBe(revA.id);
    expect(detailRevA.parent).toBeUndefined();
  } finally {
    await client.close();
  }
});

test("閲覧のみのトークンでは書き込めない", async ({ page }) => {
  const baseURL = test.info().project.use.baseURL!;
  const { ws } = await signupViaUi(page);
  await seedDemo(page.request, ws);
  const { secret } = await issueToken(page, ws, { client: "claude-code", scope: "read", expiresInDays: 30 });
  const client = await connectMcp(baseURL, secret);
  try {
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining(READ_TOOLS));
    for (const name of WRITE_TOOLS) expect(names).not.toContain(name);
    const info = await callJson<{ permission: string }>(client, "get_workspace");
    expect(info.permission).toBe("read");
    const denied = await callError(client, "create_issues", { issues: [{ team: "ENG", title: "書けない" }] });
    expect(denied).toContain("閲覧のみ");
  } finally {
    await client.close();
  }
});

test("トークン以外では MCP に接続できず、トークンではトークンを発行できない", async ({ page, browser, request }) => {
  test.setTimeout(90_000);
  const { ws } = await signupViaUi(page, { name: "管理 花子" });
  const issued = await issueToken(page, ws, { client: "claude-code", scope: "read", expiresInDays: 30 });

  const missing = await postMcp(page.request);
  expect(missing.status()).toBe(401);
  expect(missing.headers()["www-authenticate"]).toBeTruthy();

  const bogus = await postMcp(page.request, { authorization: "Bearer not-a-token" });
  expect(bogus.status()).toBe(401);
  expect(bogus.headers()["www-authenticate"]).toBeTruthy();

  const del = await page.request.delete(`/api/tokens/${issued.token.id}?ws=${ws}`, { headers: { "x-sen-client": "1" } });
  expect(del.ok()).toBeTruthy();
  const revoked = await postMcp(page.request, { authorization: `Bearer ${issued.secret}` });
  expect(revoked.status()).toBe(401);
  expect(revoked.headers()["www-authenticate"]).toBeTruthy();

  const cookieOnly = await page.request.post("/api/mcp", {
    headers: { "content-type": "application/json" },
    data: INIT_BODY,
  });
  expect(cookieOnly.status()).toBe(401);

  const get = await page.request.get("/api/mcp");
  expect(get.status()).toBe(405);

  const csrf = await page.request.post(`/api/mutate?ws=${ws}`, { data: { ops: [] } });
  expect(csrf.status()).toBe(403);

  const fresh = await issueToken(page, ws, { client: "other", scope: "read", expiresInDays: 30 });
  const minted = await request.post(`/api/tokens?ws=${ws}`, {
    headers: { authorization: `Bearer ${fresh.secret}`, "x-sen-client": "1", "content-type": "application/json" },
    data: { client: "other", scope: "write", expiresInDays: 30 },
  });
  expect(minted.status()).toBe(401);

  const email = uniqueEmail("member");
  const link = await inviteByEmail(page, ws, email);
  const { context: ctx2, page: p2 } = await joinByInvite(browser, link, { email, name: "参加 次郎" });
  try {
    const memberToken = await issueToken(p2, ws, { client: "cursor", scope: "write", expiresInDays: 30 });

    await page.goto(`/${ws}/settings/members`);
    const member = page.locator(".member-row", { hasText: "参加 次郎" });
    await expect(member).toBeVisible();
    await member.getByRole("button", { name: "メンバーを削除" }).click();
    await page.getByTestId("confirm-ok").click();
    await expect(member).toHaveCount(0);

    const removed = await postMcp(request, { authorization: `Bearer ${memberToken.secret}` });
    expect(removed.status()).toBe(401);
    expect(removed.headers()["www-authenticate"]).toBeTruthy();
  } finally {
    await ctx2.close();
  }
});

test("有効期限が不正なときと、21個目のトークンは拒否する", async ({ page }) => {
  test.setTimeout(90_000);
  const { ws } = await signupViaUi(page);
  for (const expiresInDays of [10, 0, 31, 400]) {
    const r = await page.request.post(`/api/tokens?ws=${ws}`, {
      headers: { "x-sen-client": "1" },
      data: { client: "other", scope: "read", expiresInDays },
    });
    expect(r.status()).toBe(400);
  }
  const missing = await page.request.post(`/api/tokens?ws=${ws}`, {
    headers: { "x-sen-client": "1" },
    data: { client: "other", scope: "read" },
  });
  expect(missing.status()).toBe(400);

  for (let i = 0; i < 20; i++) {
    const r = await page.request.post(`/api/tokens?ws=${ws}`, {
      headers: { "x-sen-client": "1" },
      data: { client: "other", scope: "read", expiresInDays: 30 },
    });
    expect(r.ok(), `token ${i}`).toBeTruthy();
  }
  const over = await page.request.post(`/api/tokens?ws=${ws}`, {
    headers: { "x-sen-client": "1" },
    data: { client: "other", scope: "read", expiresInDays: 90 },
  });
  expect(over.status()).toBe(400);
  expect((await over.json()).error).toBe("トークンは20個まで発行できます。使っていないトークンを無効にしてください");
});
