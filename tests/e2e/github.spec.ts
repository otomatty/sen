import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import type { BootstrapPayload, GitHubRepo, StateType } from "../../shared/types";
import { acceptGitHubWebhook, githubSignature, verifyGitHubSignature } from "../../worker/github/signature";
import { devSignIn, dismissWelcome, signupViaUi } from "./helpers";
import { GITHUB_TOKEN, addGitHubRepo, githubMock, resetGitHubMock, startGitHubMock } from "./github-mock";

const SECRET = "e2e-github-webhook-secret";

test("署名が無い・違う・長さが違うときは拒否し、同じ本文だけ通す", async () => {
  const body = "{\"zen\":\"keep it logically awesome\"}";
  const good = await githubSignature(SECRET, body);
  expect(await verifyGitHubSignature(SECRET, body, good)).toBe(true);
  expect(await verifyGitHubSignature(SECRET, body, good.toUpperCase().replace("SHA256", "sha256"))).toBe(true);
  expect(await verifyGitHubSignature(SECRET, body + " ", good)).toBe(false);
  expect(await verifyGitHubSignature(SECRET, body, null)).toBe(false);
  expect(await verifyGitHubSignature(SECRET, body, "sha256=abc")).toBe(false);
  expect(await verifyGitHubSignature(SECRET, body, `sha256=${"ab".repeat(32)}`)).toBe(false);
  expect(await verifyGitHubSignature("other-secret", body, good)).toBe(false);
});

test("設定が無いときの Webhook は 503", async () => {
  const res = await acceptGitHubWebhook(new Request("https://sen.example/api/github/webhook", { method: "POST", body: "{}" }), {});
  expect(res).toBeInstanceOf(Response);
  expect((res as Response).status).toBe(503);
});

test("Webhook は署名が正しければ 202、同じ配送は 200、ping は 200、署名が悪いと 401", async ({ request }) => {
  const push = JSON.stringify({ ref: "refs/heads/main", repository: { id: 1, full_name: "acme/widgets" } });
  const delivery = randomUUID();
  const first = await postWebhook(request, { event: "push", body: push, delivery });
  expect(first.status()).toBe(202);
  const again = await postWebhook(request, { event: "push", body: push, delivery });
  expect(again.status()).toBe(200);

  const ping = JSON.stringify({ zen: "keep it logically awesome" });
  const pingRes = await postWebhook(request, { event: "ping", body: ping });
  expect(pingRes.status()).toBe(200);

  const missing = await postWebhook(request, { event: "push", body: push, signature: null });
  expect(missing.status()).toBe(401);
  const wrong = await postWebhook(request, { event: "push", body: push, signature: `sha256=${"00".repeat(32)}` });
  expect(wrong.status()).toBe(401);
});

test.describe.serial("GitHub 連携の設定", () => {
  test.describe.configure({ timeout: 90_000 });

  let server: Server | undefined;
  let page: Page;
  let ws = "";

  test.beforeAll(async ({ browser }) => {
    resetGitHubMock();
    addGitHubRepo("acme/no-issues", { hasIssues: false });
    server = await startGitHubMock();
    page = await browser.newPage();
    const signed = await signupViaUi(page, { workspace: "GitHub E2E" });
    expect(signed.ws, `url_key が github-e2e ではありません（実際は ${signed.ws}）`).toBe("github-e2e");
    ws = signed.ws;
  });

  test.afterAll(async () => {
    await page?.context().close();
    await new Promise<void>((resolve, reject) => server?.close((err) => (err ? reject(err) : resolve())) ?? resolve());
  });

  test("対象ワークスペースだけ区画が出て、トークンのユーザー名が見える", async () => {
    await page.goto(`/${ws}/settings/workspace`);
    await expect(page.getByTestId("github-section")).toBeVisible();
    await expect(page.getByTestId("github-login")).toHaveText("トークンのユーザー：sen-bot");
    const status = await page.request.get(`/api/github/status?ws=${ws}`);
    expect(status.ok()).toBeTruthy();
    expect(await status.json()).toMatchObject({ enabled: true, login: "sen-bot", error: null });

    const created = await page.request.post("/api/workspaces", {
      headers: { "x-sen-client": "1" },
      data: { name: "Other Place" },
    });
    expect(created.ok()).toBeTruthy();
    const other = ((await created.json()) as { workspaceKey: string }).workspaceKey;
    expect(other).not.toBe(ws);
    const otherStatus = await page.request.get(`/api/github/status?ws=${other}`);
    expect(await otherStatus.json()).toMatchObject({ enabled: false, login: null, error: null, webhookUrl: "" });
    await page.goto(`/${other}/settings/workspace`);
    await expect(page.getByRole("heading", { name: "ワークスペース" })).toBeVisible();
    await expect(page.getByTestId("github-section")).toHaveCount(0);
  });

  test("管理者が連携すると Webhook が作られ、自動の移動の初期値になる", async () => {
    await page.goto(`/${ws}/settings/workspace`);
    await page.getByTestId("github-repo-DEF").fill("acme/widgets");
    await page.getByTestId("github-link-DEF").click();
    await expect(page.getByTestId("github-webhook-DEF")).toContainText("自動で作成済み");
    await expect(page.getByTestId("github-repo-name-DEF")).toHaveText("acme/widgets");

    const hook = githubMock.hooks.find((item) => item.fullName === "acme/widgets");
    expect(hook).toBeTruthy();
    expect(hook?.url).toBe(`${new URL(page.url()).origin}/api/github/webhook`);
    expect(hook?.events).toEqual(["issues", "issue_comment", "pull_request"]);
    expect(hook?.secret).toBe(SECRET);
    expect(hook?.contentType).toBe("json");
    const recorded = githubMock.requests.find((item) => item.method === "POST" && item.path === "/repos/acme/widgets/hooks");
    expect(recorded?.body).toMatchObject({
      name: "web",
      active: true,
      events: ["issues", "issue_comment", "pull_request"],
      config: { content_type: "json", secret: SECRET, url: hook?.url },
    });

    const data = await bootstrap(page, ws);
    const team = data.teams.find((item) => item.key === "DEF");
    expect(team).toBeTruthy();
    const draft = stateId(data, team!.id, "started", "進行中");
    const review = stateId(data, team!.id, "started", "レビュー中");
    const done = stateId(data, team!.id, "completed", "完了");
    await expect(page.getByTestId("github-pr-draft-DEF")).toHaveValue(draft);
    await expect(page.getByTestId("github-pr-open-DEF")).toHaveValue(review);
    await expect(page.getByTestId("github-pr-merged-DEF")).toHaveValue(done);

    const text = await page.content();
    expect(text).not.toContain(GITHUB_TOKEN);
    expect(text).not.toContain(SECRET);
    const sync = await page.request.get(`/api/sync?ws=${encodeURIComponent(ws)}&after=0`);
    const syncText = await sync.text();
    expect(syncText).not.toContain(GITHUB_TOKEN);
    expect(syncText).not.toContain(SECRET);
  });

  test("プルリクエストの自動の移動を変えて保存できる", async () => {
    await page.goto(`/${ws}/settings/workspace`);
    await page.getByTestId("github-pr-draft-DEF").selectOption({ label: "変えない" });
    await page.getByTestId("github-pr-open-DEF").selectOption({ label: "未着手" });
    await page.getByTestId("github-pr-save-DEF").click();
    await expect(page.getByText("保存しました")).toBeVisible();
    await page.reload();
    await expect(page.getByTestId("github-pr-draft-DEF")).toHaveValue("");
    const data = await bootstrap(page, ws);
    const team = data.teams.find((item) => item.key === "DEF")!;
    await expect(page.getByTestId("github-pr-open-DEF")).toHaveValue(stateId(data, team.id, "unstarted", "未着手"));
    const repo = data.githubRepos.find((item) => item.teamId === team.id) as GitHubRepo;
    expect(repo.prDraftStateId).toBeNull();
    expect(repo.prOpenStateId).toBe(stateId(data, team.id, "unstarted", "未着手"));
  });

  test("スマホ幅でも区画が画面の外にはみ出さない", async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/${ws}/settings/workspace`);
    await expect(page.getByTestId("github-section")).toBeVisible();
    const fits = await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
    expect(fits).toBe(true);
    await page.setViewportSize({ width: 1360, height: 860 });
  });

  test("連携を外すと Webhook の削除が届く", async () => {
    const hookId = githubMock.hooks.find((item) => item.fullName === "acme/widgets")?.id;
    expect(hookId).toBeTruthy();
    await page.goto(`/${ws}/settings/workspace`);
    await page.getByTestId("github-unlink-DEF").click();
    await page.getByTestId("confirm-ok").click();
    await expect(page.getByTestId("github-repo-DEF")).toBeVisible();
    expect(githubMock.requests.some((item) => item.method === "DELETE" && item.path === `/repos/acme/widgets/hooks/${hookId}`)).toBe(true);
    expect(githubMock.hooks.some((item) => item.id === hookId)).toBe(false);
  });

  test("Webhook を作れないときは手で設定する手順が出る", async () => {
    githubMock.hookStatus = 403;
    try {
      await page.goto(`/${ws}/settings/workspace`);
      await page.getByTestId("github-repo-DEF").fill("acme/widgets");
      await page.getByTestId("github-link-DEF").click();
      const manual = page.getByTestId("github-webhook-manual-DEF");
      await expect(manual).toBeVisible();
      await expect(manual).toContainText("手で設定してください");
      await expect(manual).toContainText("Issues、Issue comments、Pull requests");
      await expect(page.getByTestId("github-webhook-url-DEF")).toHaveText(`${new URL(page.url()).origin}/api/github/webhook`);
      await expect(manual).toContainText("GITHUB_WEBHOOK_SECRET");
      await expect(manual).not.toContainText(SECRET);
      expect(githubMock.hooks.some((item) => item.fullName === "acme/widgets")).toBe(false);
    } finally {
      githubMock.hookStatus = 201;
    }
    await page.getByTestId("github-unlink-DEF").click();
    await page.getByTestId("confirm-ok").click();
    await expect(page.getByTestId("github-repo-DEF")).toBeVisible();
  });

  test("存在しないリポジトリと、ほかのチームで連携済みのリポジトリはエラー", async () => {
    await page.goto(`/${ws}/settings/workspace`);
    await page.getByTestId("github-repo-DEF").fill("missing/repo");
    await page.getByTestId("github-link-DEF").click();
    await expect(page.getByText("リポジトリが見つかりません")).toBeVisible();

    await page.getByTestId("github-repo-DEF").fill("acme/no-issues");
    await page.getByTestId("github-link-DEF").click();
    await expect(page.getByText("このリポジトリでは Issues が無効です")).toBeVisible();

    await page.getByTestId("github-repo-DEF").fill("acme/widgets");
    await page.getByTestId("github-link-DEF").click();
    await expect(page.getByTestId("github-webhook-DEF")).toContainText("自動で作成済み");

    const teamId = randomUUID();
    const created = await page.request.post(`/api/mutate?ws=${encodeURIComponent(ws)}`, {
      headers: { "x-sen-client": "1" },
      data: { ops: [{ clientId: randomUUID(), mutation: { type: "team.create", args: { id: teamId, name: "ほか", key: "OTH" } } }] },
    });
    expect(created.ok()).toBeTruthy();
    await page.reload();
    await page.getByTestId("github-repo-OTH").fill("acme/widgets");
    await page.getByTestId("github-link-OTH").click();
    await expect(page.getByText("このリポジトリは、ほかのチームですでに連携しています")).toBeVisible();
  });

  test("管理者でないメンバーは連携できない", async ({ browser }) => {
    await page.goto(`/${ws}/settings/members`);
    const code = (await page.getByTestId("invite-link").inputValue()).split("/invite/")[1];
    const ctx = await browser.newContext();
    const member = await ctx.newPage();
    await devSignIn(member, { name: "参加 次郎" });
    await member.goto(`/invite/${code}`);
    await member.getByTestId("invite-accept").click();
    await expect(member.getByTestId("app")).toBeVisible();
    await dismissWelcome(member);
    await member.goto(`/${ws}/settings/workspace`);
    await expect(member.getByTestId("github-section")).toBeVisible();
    await expect(member.getByTestId("github-link-DEF")).toHaveCount(0);
    await expect(member.getByTestId("github-unlink-DEF")).toHaveCount(0);
    await expect(member.getByTestId("github-link-OTH")).toHaveCount(0);
    const denied = await member.request.post(`/api/github/repos?ws=${encodeURIComponent(ws)}`, {
      headers: { "x-sen-client": "1" },
      data: { teamId: randomUUID(), repo: "acme/widgets" },
    });
    expect(denied.status()).toBe(403);
    await ctx.close();
  });

  test("プロフィールの GitHub ユーザー名は小文字で保存し、不正・重複は拒否し、空で消せる", async ({ browser }) => {
    await page.goto(`/${ws}/settings/profile`);
    const input = page.getByTestId("profile-github-login");
    await input.fill("OctoCat");
    await input.blur();
    await expect(input).toHaveValue("octocat");
    await expect.poll(async () => (await bootstrap(page, ws)).me.githubLogin).toBe("octocat");

    await input.fill("a--b");
    await input.blur();
    await expect(page.getByText("GitHub のユーザー名の形式が正しくありません")).toBeVisible();
    await expect.poll(async () => (await bootstrap(page, ws)).me.githubLogin).toBe("octocat");

    await page.goto(`/${ws}/settings/members`);
    const code = (await page.getByTestId("invite-link").inputValue()).split("/invite/")[1];
    const ctx = await browser.newContext();
    const other = await ctx.newPage();
    await devSignIn(other, { name: "重複 花子" });
    await other.goto(`/invite/${code}`);
    await other.getByTestId("invite-accept").click();
    await expect(other.getByTestId("app")).toBeVisible();
    await dismissWelcome(other);
    await other.goto(`/${ws}/settings/profile`);
    const otherInput = other.getByTestId("profile-github-login");
    await otherInput.fill("OctoCat");
    await otherInput.blur();
    await expect(other.getByText("この GitHub ユーザー名は、ほかの人が登録しています")).toBeVisible();
    await expect.poll(async () => (await bootstrap(other, ws)).me.githubLogin).toBeNull();
    await ctx.close();

    await page.goto(`/${ws}/settings/profile`);
    await input.fill("");
    await input.blur();
    await expect.poll(async () => (await bootstrap(page, ws)).me.githubLogin).toBeNull();
  });
});

async function postWebhook(
  request: APIRequestContext,
  opts: { event: string; body: string; delivery?: string; signature?: string | null },
) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-github-event": opts.event,
    "x-github-delivery": opts.delivery ?? randomUUID(),
  };
  if (opts.signature !== null) headers["x-hub-signature-256"] = opts.signature ?? (await githubSignature(SECRET, opts.body));
  return request.post("/api/github/webhook", { headers, data: opts.body });
}

async function bootstrap(page: Page, ws: string): Promise<BootstrapPayload> {
  const res = await page.request.get(`/api/bootstrap?ws=${encodeURIComponent(ws)}`);
  expect(res.ok()).toBeTruthy();
  return (await res.json()) as BootstrapPayload;
}

function stateId(data: BootstrapPayload, teamId: string, type: StateType, name: string): string {
  const state = data.states.find((item) => item.teamId === teamId && item.type === type && item.name === name);
  if (!state) throw new Error(`ステータス「${name}」が見つかりません`);
  return state.id;
}
