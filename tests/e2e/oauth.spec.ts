import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { devSignIn, inviteByEmail, joinByInvite, seedDemo, signupViaUi, uniqueEmail } from "./helpers";

// Chromium がブロックするポート 9 を避ける。接続は page.route で受け、listen はしない。
const REDIRECT = "http://127.0.0.1:49199/callback";
const WRITE_TOOLS = ["create_issues", "update_issues", "add_comment", "link_issues"];
const INIT = {
  jsonrpc: "2.0", id: 1, method: "initialize",
  params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "oauth-e2e", version: "1.0.0" } },
};

function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

function register(request: APIRequestContext, body: Record<string, unknown>) {
  return request.post("/api/oauth/register", { data: body });
}

function authorizeUrl(params: Record<string, string>) {
  return `/api/oauth/authorize?${new URLSearchParams(params)}`;
}

async function approveInBrowser(page: Page, url: string, opts: {
  scope?: "read" | "write"; workspaceName?: string; deny?: boolean; clientName?: string;
} = {}) {
  // 実際のコールバックサーバーは立てず、ブラウザの遷移だけを受ける。
  await page.route("http://127.0.0.1:49199/**", (route) => route.fulfill({
    status: 200, contentType: "text/html", body: "<!doctype html><title>OAuth callback</title><p>完了</p>",
  }));
  try {
    await page.goto(url);
    await expect(page.getByTestId("oauth-consent")).toBeVisible();
    await expect(page.getByTestId("oauth-destination")).toHaveText("このパソコン（127.0.0.1）");
    if (opts.clientName) await expect(page.getByTestId("oauth-consent")).toContainText(opts.clientName);
    if (opts.workspaceName) await page.getByTestId("oauth-workspace").selectOption({ label: opts.workspaceName });
    if (opts.scope) await page.getByTestId(`oauth-scope-${opts.scope}`).click();
    await page.getByTestId(opts.deny ? "oauth-deny" : "oauth-approve").click();
    await page.waitForURL((u) => u.origin === new URL(REDIRECT).origin && u.pathname === "/callback");
    return new URL(page.url());
  } finally {
    await page.unroute("http://127.0.0.1:49199/**");
  }
}

interface TokenBody {
  access_token: string; refresh_token: string; token_type: string; expires_in: number; scope: string; error?: string;
}
async function exchange(request: APIRequestContext, form: Record<string, string>, headers?: Record<string, string>) {
  const response = await request.post("/api/oauth/token", { form, headers });
  return { status: response.status(), body: await response.json() as TokenBody };
}
function refresh(request: APIRequestContext, form: Record<string, string>) {
  return exchange(request, { grant_type: "refresh_token", ...form });
}
function postMcp(request: APIRequestContext, token?: string) {
  return request.post("/api/mcp", { data: INIT, headers: token ? { authorization: `Bearer ${token}` } : {} });
}
async function connectMcp(baseURL: string, token: string) {
  const client = new Client({ name: "oauth-e2e", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${baseURL}/api/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  }));
  return client;
}
async function registered(request: APIRequestContext, extra: Record<string, unknown> = {}) {
  const response = await register(request, { client_name: "OAuth E2E", redirect_uris: [REDIRECT], ...extra });
  expect(response.status()).toBe(201);
  return response.json() as Promise<{ client_id: string; client_secret?: string }>;
}
function authorization(clientId: string, challenge: string, extra: Record<string, string> = {}) {
  return authorizeUrl({ client_id: clientId, redirect_uri: REDIRECT, response_type: "code",
    code_challenge: challenge, code_challenge_method: "S256", state: "e2e-state", ...extra });
}
async function codeFor(page: Page, clientId: string, opts: Parameters<typeof approveInBrowser>[2] = {}) {
  const { verifier, challenge } = pkce();
  const callback = await approveInBrowser(page, authorization(clientId, challenge), opts);
  expect(callback.searchParams.get("state")).toBe("e2e-state");
  expect(callback.searchParams.get("iss")).toBe(test.info().project.use.baseURL);
  const code = callback.searchParams.get("code");
  expect(code).toBeTruthy();
  return { grant_type: "authorization_code", client_id: clientId, redirect_uri: REDIRECT, code: code!, code_verifier: verifier };
}
async function tokensFor(page: Page, opts: Parameters<typeof approveInBrowser>[2] = {}) {
  const { client_id } = await registered(page.request);
  const result = await exchange(page.request, await codeFor(page, client_id, opts));
  expect(result.status).toBe(200);
  expect(result.body.access_token).toMatch(/^sen_at_[A-Za-z0-9_-]{43}$/);
  expect(result.body.refresh_token).toMatch(/^sen_rt_[A-Za-z0-9_-]{43}$/);
  expect(result.body.expires_in).toBe(3600);
  expect(result.body.token_type).toBe("Bearer");
  return { client_id, ...result.body };
}
function invalidGrant(result: Awaited<ReturnType<typeof exchange>>) {
  expect(result.status).toBe(400);
  expect(result.body.error).toBe("invalid_grant");
}

class MemoryProvider implements OAuthClientProvider {
  redirectUrl = REDIRECT;
  clientMetadata = {
    client_name: "E2E クライアント", redirect_uris: [REDIRECT],
    grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none",
  };
  information?: OAuthClientInformationMixed;
  savedTokens?: OAuthTokens;
  authorizationUrl?: URL;
  verifier = "";
  clientInformation() { return this.information; }
  saveClientInformation(value: OAuthClientInformationMixed) { this.information = value; }
  tokens() { return this.savedTokens; }
  saveTokens(value: OAuthTokens) { this.savedTokens = value; }
  redirectToAuthorization(value: URL) { this.authorizationUrl = value; }
  saveCodeVerifier(value: string) { this.verifier = value; }
  codeVerifier() { return this.verifier; }
}

test("ディスカバリーと CORS のメタデータを公開する", async ({ request, baseURL }) => {
  const missing = await postMcp(request);
  expect(missing.status()).toBe(401);
  expect(missing.headers()["www-authenticate"]).toContain(`resource_metadata="${baseURL}/.well-known/oauth-protected-resource/api/mcp"`);
  expect(missing.headers()["www-authenticate"]).toContain('scope="read write"');
  expect(missing.headers()["www-authenticate"]).not.toContain("error=");
  const invalid = await postMcp(request, "invalid");
  expect(invalid.status()).toBe(401);
  expect(invalid.headers()["www-authenticate"]).toContain('error="invalid_token"');
  for (const path of ["/.well-known/oauth-protected-resource/api/mcp", "/.well-known/oauth-protected-resource"]) {
    const response = await request.get(path);
    expect(response.status()).toBe(200);
    expect(response.headers()["access-control-allow-origin"]).toBe("*");
    expect(await response.json()).toMatchObject({ resource: `${baseURL}/api/mcp`, authorization_servers: [baseURL] });
  }
  const metadata = await request.get("/.well-known/oauth-authorization-server");
  expect(metadata.status()).toBe(200);
  expect(metadata.headers()["access-control-allow-origin"]).toBe("*");
  expect(await metadata.json()).toMatchObject({
    issuer: baseURL, authorization_endpoint: `${baseURL}/api/oauth/authorize`, token_endpoint: `${baseURL}/api/oauth/token`,
    registration_endpoint: `${baseURL}/api/oauth/register`, revocation_endpoint: `${baseURL}/api/oauth/revoke`,
    code_challenge_methods_supported: ["S256"], client_id_metadata_document_supported: true,
    token_endpoint_auth_methods_supported: expect.arrayContaining(["none"]),
  });
  const oidc = await request.get("/.well-known/openid-configuration");
  expect(oidc.status()).toBe(404);
  expect(oidc.headers()["content-type"]).toContain("application/json");
  expect(await oidc.json()).toEqual({ error: "not_found" });
  for (const path of ["/api/mcp", "/api/oauth/token"]) {
    const response = await request.fetch(path, { method: "OPTIONS", headers: {
      origin: "https://client.example", "access-control-request-method": "POST",
      "access-control-request-headers": "authorization,mcp-protocol-version",
    } });
    expect(response.status()).toBe(204);
    expect(response.headers()["access-control-allow-origin"]).toBe("*");
    if (path === "/api/mcp") {
      const allowed = response.headers()["access-control-allow-headers"].toLowerCase();
      expect(allowed).toContain("authorization");
      expect(allowed).toContain("mcp-protocol-version");
    }
  }
});

test("MCP SDK の OAuth クライアントで、登録から許可・接続・課題の作成まで通る", async ({ page, baseURL }) => {
  test.setTimeout(120_000);
  const { ws } = await signupViaUi(page, { workspace: "SDK OAuth ワークスペース" });
  await seedDemo(page.request, ws);
  const provider = new MemoryProvider();
  const initial = new Client({ name: "oauth-e2e", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${baseURL}/api/mcp`), { authProvider: provider });
  try {
    await expect(initial.connect(transport)).rejects.toBeInstanceOf(UnauthorizedError);
    expect(provider.authorizationUrl).toBeDefined();
    const callback = await approveInBrowser(page, provider.authorizationUrl!.href, { clientName: "E2E クライアント" });
    await transport.finishAuth(callback.searchParams.get("code")!);
  } finally {
    await initial.close();
  }
  const client = new Client({ name: "oauth-e2e", version: "1.0.0" });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`${baseURL}/api/mcp`), { authProvider: provider }));
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(expect.arrayContaining(WRITE_TOOLS));
    expect(client.getInstructions()).toContain("SDK OAuth ワークスペース");
    const result = await client.callTool({ name: "create_issues", arguments: { issues: [{ team: "ENG", title: "OAuth で作った課題" }] } });
    expect(result.isError).not.toBe(true);
    if (!("content" in result) || !Array.isArray(result.content) || result.content[0]?.type !== "text") throw new Error("課題作成の応答が不正です");
    const created = JSON.parse(result.content[0].text) as { created: { id: string }[] };
    await page.goto(`/${ws}/issue/${created.created[0].id}`);
    await expect(page.getByTestId("activity").getByTestId("via-badge").first()).toHaveText("E2E クライアント 経由");
  } finally { await client.close(); }
  await page.goto(`/${ws}/settings/workspace`);
  await page.getByTestId("settings-nav-ai").click();
  const row = page.getByTestId("ai-connection-row").filter({ hasText: "E2E クライアント" });
  await expect(row).toContainText("作成と変更");
  await row.getByTestId("ai-connection-revoke").click();
  await expect(page.getByTestId("confirm-dialog")).toContainText("接続を解除しますか？");
  await page.getByTestId("confirm-ok").click();
  await expect(row).toHaveCount(0);
  await expect(page.getByText("接続を解除しました", { exact: true })).toBeVisible();
  expect((await postMcp(page.request, provider.savedTokens!.access_token)).status()).toBe(401);
  invalidGrant(await refresh(page.request, { client_id: provider.information!.client_id, refresh_token: provider.savedTokens!.refresh_token! }));
});

test("閲覧のみで許可すると、書き込みのツールが無い", async ({ page, baseURL }) => {
  await signupViaUi(page);
  const tokens = await tokensFor(page, { scope: "read" });
  expect(tokens.scope).toBe("read");
  const client = await connectMcp(baseURL!, tokens.access_token);
  try {
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["get_workspace", "search_issues", "get_issue"]));
    for (const tool of WRITE_TOOLS) expect(names).not.toContain(tool);
  } finally { await client.close(); }
});

test("キャンセルすると access_denied で戻る", async ({ page, baseURL }) => {
  await signupViaUi(page);
  const { client_id } = await registered(page.request);
  const callback = await approveInBrowser(page, authorization(client_id, pkce().challenge), { deny: true });
  expect(callback.searchParams.get("error")).toBe("access_denied");
  expect(callback.searchParams.get("state")).toBe("e2e-state");
  expect(callback.searchParams.get("iss")).toBe(baseURL);
  expect(callback.searchParams.has("code")).toBe(false);
});

test("ワークスペースを選んで接続できる", async ({ page, baseURL }) => {
  await signupViaUi(page, { workspace: "最初のワークスペース" });
  const response = await page.request.post("/api/workspaces", { headers: { "x-sen-client": "1" }, data: { name: "選択したワークスペース" } });
  expect(response.ok()).toBe(true);
  const tokens = await tokensFor(page, { workspaceName: "選択したワークスペース" });
  const client = await connectMcp(baseURL!, tokens.access_token);
  try { expect(client.getInstructions()).toContain("選択したワークスペース"); }
  finally { await client.close(); }
});

test("確かめられない戻り先には戻さず、安全な戻り先だけに認可エラーを返す", async ({ page, request, baseURL }) => {
  const { client_id } = await registered(request);
  for (const [extra, error, message] of [
    [{ redirect_uri: "https://evil.example/callback" }, "invalid_redirect", "接続の戻り先が、AI ツールの登録と一致しません。AI ツールからもう一度接続してください。"],
    [{ client_id: "unknown-client" }, "invalid_client", "AI ツールを確認できませんでした。AI ツールからもう一度接続してください。"],
  ] as const) {
    const url = authorization(client_id, pkce().challenge, extra);
    const response = await request.get(url, { maxRedirects: 0 });
    expect(response.status()).toBe(302);
    expect(response.headers().location).toBe(`/oauth/consent?error=${error}`);
    await page.goto(url);
    await expect(page.getByTestId("oauth-error")).toHaveText(message);
    expect(new URL(page.url()).origin).toBe(baseURL);
  }
  for (const [extra, error] of [
    [{ code_challenge: "" }, "invalid_request"],
    [{ code_challenge_method: "plain" }, "invalid_request"],
    [{ response_type: "token" }, "unsupported_response_type"],
    [{ resource: "https://evil.example/api/mcp" }, "invalid_target"],
  ] as const) {
    const params = new URLSearchParams(authorization(client_id, pkce().challenge, extra).split("?")[1]);
    if (extra.code_challenge === "") params.delete("code_challenge");
    const response = await request.get(authorizeUrl(Object.fromEntries(params)), { maxRedirects: 0 });
    expect(response.status()).toBe(302);
    const location = new URL(response.headers().location);
    expect(location.origin + location.pathname).toBe(REDIRECT);
    expect(location.searchParams.get("error")).toBe(error);
    expect(location.searchParams.get("state")).toBe("e2e-state");
    expect(location.searchParams.get("iss")).toBe(baseURL);
  }
});

test("登録の戻り先とクライアント情報を検証する", async ({ request }) => {
  for (const body of [
    { redirect_uris: ["javascript:alert(1)"] }, { redirect_uris: ["http://example.com/cb"] },
    { redirect_uris: ["https://example.com/cb#fragment"] }, {},
  ]) expect((await register(request, body)).status()).toBe(400);
  for (const uri of ["cursor://anysphere.cursor-retrieval/oauth/callback", "http://localhost:33418/"]) {
    expect((await register(request, { redirect_uris: [uri] })).status()).toBe(201);
  }
  const response = await register(request, { redirect_uris: [REDIRECT], client_name: "あ".repeat(100) });
  expect(response.status()).toBe(201);
  const body = await response.json();
  expect(body.client_name).toBe("あ".repeat(40));
  expect(body.token_endpoint_auth_method).toBe("none");
  expect(body).not.toHaveProperty("client_secret");
});

test("コードと PKCE を検証し、コードの再利用で接続を失効する", async ({ page }) => {
  await signupViaUi(page);
  const { client_id } = await registered(page.request);
  const form = await codeFor(page, client_id);
  invalidGrant(await exchange(page.request, { ...form, code_verifier: pkce().verifier }));
  const other = await registered(page.request);
  const mismatch = await exchange(page.request, { ...form, client_id: other.client_id });
  expect([400, 401]).toContain(mismatch.status);
  expect(["invalid_grant", "invalid_client"]).toContain(mismatch.body.error);
  const first = await exchange(page.request, form);
  expect(first.status).toBe(200);
  expect((await postMcp(page.request, first.body.access_token)).status()).toBe(200);
  invalidGrant(await exchange(page.request, { ...form, code_verifier: pkce().verifier }));
  expect((await postMcp(page.request, first.body.access_token)).status()).toBe(200);
  const reusedByOther = await exchange(page.request, { ...form, client_id: other.client_id });
  expect([400, 401]).toContain(reusedByOther.status);
  expect(["invalid_grant", "invalid_client"]).toContain(reusedByOther.body.error);
  expect((await postMcp(page.request, first.body.access_token)).status()).toBe(200);
  invalidGrant(await exchange(page.request, form));
  expect((await postMcp(page.request, first.body.access_token)).status()).toBe(401);
});

test("リフレッシュトークンをローテーションし、失効できる", async ({ page, baseURL }) => {
  await signupViaUi(page);
  const first = await tokensFor(page);
  const rotate = (token: string) => refresh(page.request, { client_id: first.client_id, refresh_token: token });
  const second = await rotate(first.refresh_token);
  expect(second.status).toBe(200);
  const third = await rotate(second.body.refresh_token);
  expect(third.status).toBe(200);
  expect(new Set([first.refresh_token, second.body.refresh_token, third.body.refresh_token]).size).toBe(3);
  expect(new Set([first.access_token, second.body.access_token, third.body.access_token]).size).toBe(3);
  const client = await connectMcp(baseURL!, third.body.access_token);
  try { expect((await client.listTools()).tools.length).toBeGreaterThan(0); }
  finally { await client.close(); }
  const revoked = await page.request.post("/api/oauth/revoke", { form: { client_id: first.client_id, token: third.body.refresh_token } });
  expect(revoked.status()).toBe(200);
  expect((await postMcp(page.request, third.body.access_token)).status()).toBe(401);
  invalidGrant(await rotate(third.body.refresh_token));
});

test("猶予の中で 1 つ前のトークンを使ったあと、置き換えられたトークンが来たら接続ごと無効になる", async ({ page }) => {
  await signupViaUi(page);
  const first = await tokensFor(page);
  const rotate = (token: string) => refresh(page.request, { client_id: first.client_id, refresh_token: token });
  const second = await rotate(first.refresh_token);
  expect(second.status).toBe(200);
  const third = await rotate(first.refresh_token);
  expect(third.status).toBe(200);
  invalidGrant(await rotate(second.body.refresh_token));
  expect((await postMcp(page.request, third.body.access_token)).status()).toBe(401);
  invalidGrant(await rotate(third.body.refresh_token));
});

test("入れ替え済みの古いトークンが来たら接続ごと無効になる", async ({ page }) => {
  await signupViaUi(page);
  const first = await tokensFor(page);
  const rotate = (token: string) => refresh(page.request, { client_id: first.client_id, refresh_token: token });
  const second = await rotate(first.refresh_token);
  expect(second.status).toBe(200);
  const third = await rotate(second.body.refresh_token);
  expect(third.status).toBe(200);
  const other = await registered(page.request);
  invalidGrant(await refresh(page.request, { client_id: other.client_id, refresh_token: first.refresh_token }));
  expect((await postMcp(page.request, third.body.access_token)).status()).toBe(200);
  invalidGrant(await rotate(first.refresh_token));
  expect((await postMcp(page.request, third.body.access_token)).status()).toBe(401);
  invalidGrant(await rotate(third.body.refresh_token));
});

test("猶予を過ぎて 1 つ前のリフレッシュトークンを使うと、接続ごと無効になる", async ({ page }) => {
  await signupViaUi(page);
  const first = await tokensFor(page);
  const second = await refresh(page.request, { client_id: first.client_id, refresh_token: first.refresh_token });
  expect(second.status).toBe(200);
  // E2E 用の猶予 5000ms を確実に過ぎてから、1 つ前のトークンを再利用する。
  await page.waitForTimeout(6000);
  invalidGrant(await refresh(page.request, { client_id: first.client_id, refresh_token: first.refresh_token }));
  expect((await postMcp(page.request, second.body.access_token)).status()).toBe(401);
  invalidGrant(await refresh(page.request, { client_id: first.client_id, refresh_token: second.body.refresh_token }));
});

test("秘密を持つクライアントは正しい Basic 認証で交換できる", async ({ page }) => {
  await signupViaUi(page);
  const registration = await registered(page.request, { token_endpoint_auth_method: "client_secret_basic" });
  expect(registration.client_secret).toMatch(/^sen_cs_/);
  const form = await codeFor(page, registration.client_id);
  const absent = await exchange(page.request, form);
  expect([400, 401]).toContain(absent.status);
  expect(absent.body.error).toBe("invalid_client");
  const basic = (secret: string) => ({ authorization: `Basic ${Buffer.from(`${encodeURIComponent(registration.client_id)}:${encodeURIComponent(secret)}`).toString("base64")}` });
  const wrong = await exchange(page.request, form, basic("wrong-secret"));
  expect(wrong.status).toBe(401);
  expect(wrong.body.error).toBe("invalid_client");
  const correct = await exchange(page.request, form, basic(registration.client_secret!));
  expect(correct.status).toBe(200);
  expect(correct.body.access_token).toMatch(/^sen_at_/);
});

test("CIMD のクライアントを確認し、ループバックの異なるポートへ戻せる", async ({ page }) => {
  await signupViaUi(page);
  let origin = "";
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      client_id: `${origin}/client.json`, client_name: "CIMD クライアント",
      redirect_uris: ["http://127.0.0.1/callback"], token_endpoint_auth_method: "none",
    }));
  });
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, resolve); });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("CIMD サーバーのポートがありません");
    origin = `http://localhost:${address.port}`;
    const form = await codeFor(page, `${origin}/client.json`, { clientName: "CIMD クライアント" });
    const response = await exchange(page.request, form);
    expect(response.status).toBe(200);
    expect(response.body.access_token).toMatch(/^sen_at_/);
    const mismatch = await page.request.get(authorization(`${origin}/mismatch.json`, pkce().challenge), { maxRedirects: 0 });
    expect(mismatch.status()).toBe(302);
    expect(mismatch.headers().location).toBe("/oauth/consent?error=invalid_client");
  } finally {
    if (server.listening) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("ログインしていないと、ログインのあと同意画面に戻る", async ({ browser, request, baseURL }) => {
  const { client_id } = await registered(request);
  const context = await browser.newContext({ baseURL });
  try {
    const page = await context.newPage();
    await page.goto(authorization(client_id, pkce().challenge));
    await page.waitForURL((url) => url.pathname === "/login");
    const next = new URL(page.url()).searchParams.get("next");
    expect(next).toMatch(/^\/oauth\/consent\?request=.+/);
    await devSignIn(page);
    await page.goto(next!);
    await expect(page.getByTestId("oauth-consent")).toContainText("接続できるワークスペースがありません");
  } finally { await context.close(); }
});

test("メンバーから外すと、その人の OAuth の接続は使えない", async ({ page, browser }) => {
  test.setTimeout(120_000);
  const { ws } = await signupViaUi(page);
  const email = uniqueEmail("oauth-member");
  const link = await inviteByEmail(page, ws, email);
  const member = await joinByInvite(browser, link, { email, name: "OAuth メンバー" });
  try {
    const tokens = await tokensFor(member.page);
    expect((await postMcp(member.page.request, tokens.access_token)).status()).toBe(200);
    await page.goto(`/${ws}/settings/members`);
    const row = page.locator(".member-row", { hasText: "OAuth メンバー" });
    await row.getByRole("button", { name: "メンバーを削除" }).click();
    await page.getByTestId("confirm-ok").click();
    await expect(row).toHaveCount(0);
    expect((await postMcp(member.page.request, tokens.access_token)).status()).toBe(401);
    invalidGrant(await refresh(member.page.request, { client_id: tokens.client_id, refresh_token: tokens.refresh_token }));
  } finally { await member.context.close(); }
});

test("同意 API は x-sen-client の無い POST を CSRF として拒否する", async ({ page }) => {
  const { ws } = await signupViaUi(page);
  const { client_id } = await registered(page.request);
  const response = await page.request.get(authorization(client_id, pkce().challenge), { maxRedirects: 0 });
  expect(response.status()).toBe(302);
  const id = new URL(response.headers().location, test.info().project.use.baseURL!).searchParams.get("request");
  expect(id).toBeTruthy();
  const info = await page.request.get(`/api/oauth/requests/${id}`, { headers: { "x-sen-client": "1" } });
  expect(info.status()).toBe(200);
  const body = await info.json() as { workspaces: { id: string; urlKey: string }[] };
  const workspaceId = body.workspaces.find((w) => w.urlKey === ws)!.id;
  const denied = await page.request.post(`/api/oauth/requests/${id}/approve`, { data: { workspaceId, scope: "write" } });
  expect(denied.status()).toBe(403);
});
