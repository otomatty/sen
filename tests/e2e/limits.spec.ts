import { randomUUID } from "node:crypto";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ISSUE_TITLE_MAX_LENGTH, MARKDOWN_MAX_LENGTH } from "../../shared/constants";
import type { ApiTokenCreateResponse, BootstrapPayload, Mutation } from "../../shared/types";
import { signupViaUi } from "./helpers";

async function postMutation(page: Page, ws: string, mutation: Mutation) {
  const res = await page.request.post(`/api/mutate?ws=${encodeURIComponent(ws)}`, {
    headers: { "x-sen-client": "1" },
    data: { ops: [{ clientId: randomUUID(), mutation }] },
  });
  const text = await res.text();
  expect(res.ok(), text).toBeTruthy();
  const body = JSON.parse(text) as { results: { ok: boolean; error?: string }[] };
  return body.results[0];
}

async function bootstrap(page: Page, ws: string) {
  const res = await page.request.get(`/api/bootstrap?ws=${encodeURIComponent(ws)}`);
  expect(res.ok()).toBeTruthy();
  return (await res.json()) as BootstrapPayload;
}

async function issueToken(request: APIRequestContext, ws: string) {
  const res = await request.post(`/api/tokens?ws=${encodeURIComponent(ws)}`, {
    headers: { "x-sen-client": "1" },
    data: { client: "claude-code", scope: "write", expiresInDays: 30 },
  });
  expect(res.ok()).toBeTruthy();
  return (await res.json()) as ApiTokenCreateResponse;
}

async function connectMcp(baseURL: string, secret: string) {
  const client = new Client({ name: "e2e", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${baseURL}/api/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${secret}` } },
  });
  await client.connect(transport);
  return client;
}

async function toolText(client: Client, name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args });
  if (!("content" in result) || !Array.isArray(result.content)) throw new Error("ツールの結果に content がありません");
  const first = result.content[0];
  if (!first || first.type !== "text") throw new Error("ツールの結果がテキストではありません");
  return { text: first.text, isError: result.isError === true };
}

test("API と AI 連携は、タイトル 256 文字を受け、257 文字を拒否する", async ({ page }) => {
  expect(ISSUE_TITLE_MAX_LENGTH).toBe(256);
  const { ws } = await signupViaUi(page);
  const data = await bootstrap(page, ws);
  const team = data.teams[0];
  expect(team).toBeTruthy();

  const okTitle = "あ".repeat(ISSUE_TITLE_MAX_LENGTH);
  const okId = randomUUID();
  const created = await postMutation(page, ws, { type: "issue.create", args: { id: okId, teamId: team.id, title: okTitle } });
  expect(created.ok).toBe(true);
  const stored = (await bootstrap(page, ws)).issues.find((issue) => issue.id === okId);
  expect(stored?.title).toBe(okTitle);

  const tooLong = await postMutation(page, ws, {
    type: "issue.create",
    args: { id: randomUUID(), teamId: team.id, title: "あ".repeat(ISSUE_TITLE_MAX_LENGTH + 1) },
  });
  expect(tooLong.ok).toBe(false);
  expect(tooLong.error).toBe("タイトルは256文字以内で入力してください");

  const baseURL = test.info().project.use.baseURL!;
  const { secret } = await issueToken(page.request, ws);
  const client = await connectMcp(baseURL, secret);
  try {
    const aiOk = await toolText(client, "create_issues", { issues: [{ team: team.key, title: "a".repeat(ISSUE_TITLE_MAX_LENGTH) }] });
    expect(aiOk.isError).toBe(false);
    const createdAi = JSON.parse(aiOk.text) as { created: { title: string }[] };
    expect(createdAi.created[0].title).toHaveLength(ISSUE_TITLE_MAX_LENGTH);

    const aiBad = await toolText(client, "create_issues", { issues: [{ team: team.key, title: "a".repeat(ISSUE_TITLE_MAX_LENGTH + 1) }] });
    expect(aiBad.isError).toBe(true);
    expect(aiBad.text).toContain("タイトルは256文字以内で入力してください");
  } finally {
    await client.close();
  }
});

test("API は、説明とコメントを 65,536 文字まで受け、65,537 文字を拒否する", async ({ page }) => {
  expect(MARKDOWN_MAX_LENGTH).toBe(65_536);
  const { ws } = await signupViaUi(page);
  const team = (await bootstrap(page, ws)).teams[0];
  expect(team).toBeTruthy();

  const description = ` ${"あ".repeat(MARKDOWN_MAX_LENGTH - 1)}`;
  expect(description).toHaveLength(MARKDOWN_MAX_LENGTH);
  const issueId = randomUUID();
  const created = await postMutation(page, ws, {
    type: "issue.create",
    args: { id: issueId, teamId: team.id, title: "長さの確認", description },
  });
  expect(created.ok).toBe(true);
  const stored = (await bootstrap(page, ws)).issues.find((issue) => issue.id === issueId);
  expect(stored?.description).toBe(description);

  const tooLong = `${description}あ`;
  expect(tooLong).toHaveLength(MARKDOWN_MAX_LENGTH + 1);
  const rejected = await postMutation(page, ws, {
    type: "issue.update",
    args: { id: issueId, patch: { description: tooLong } },
  });
  expect(rejected.ok).toBe(false);
  expect(rejected.error).toBe("説明は65,536文字以内で入力してください");
  expect((await bootstrap(page, ws)).issues.find((issue) => issue.id === issueId)?.description).toBe(description);

  const comment = ` ${"い".repeat(MARKDOWN_MAX_LENGTH - 1)}`;
  expect(comment).toHaveLength(MARKDOWN_MAX_LENGTH);
  const commentId = randomUUID();
  const commented = await postMutation(page, ws, { type: "comment.create", args: { id: commentId, issueId, body: comment } });
  expect(commented.ok).toBe(true);
  const threadRes = await page.request.get(`/api/issues/${issueId}/thread?ws=${encodeURIComponent(ws)}`);
  expect(threadRes.ok()).toBeTruthy();
  const thread = (await threadRes.json()) as { comments: { id: string; body: string }[] };
  expect(thread.comments.find((item) => item.id === commentId)?.body).toBe(comment);

  const commentRejected = await postMutation(page, ws, {
    type: "comment.create",
    args: { id: randomUUID(), issueId, body: `${comment}い` },
  });
  expect(commentRejected.ok).toBe(false);
  expect(commentRejected.error).toBe("コメントは65,536文字以内で入力してください");
});
