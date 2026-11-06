import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { MARKDOWN_MAX_LENGTH } from "../../shared/constants";
import type { Activity, BootstrapPayload, Comment, GitHubLink, GitHubRepo, Issue, Mutation, StateType } from "../../shared/types";
import {
  advanceStateId,
  formatOutboundComment,
  initialStateId,
  mergeLabels,
  mergeOpenClosed,
  mergeScalar,
  nextGitHubAssignees,
  parseIssueRef,
  resolveGitHubAssignee,
  stateIdForGitHub,
  type WorkflowStateRef,
} from "../../worker/github/merge";
import { extractPullReferences, pullLinkState } from "../../worker/github/pulls";
import { acceptGitHubWebhook, githubSignature, verifyGitHubSignature } from "../../worker/github/signature";
import { inviteByEmail, joinByInvite, signupViaUi, uniqueEmail } from "./helpers";
import { GITHUB_TOKEN, addGitHubRepo, githubMock, resetGitHubMock, startGitHubMock, type MockIssue, type MockPull } from "./github-mock";

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
    const email = uniqueEmail("member");
    const link = await inviteByEmail(page, ws, email);
    const joined = await joinByInvite(browser, link, { email, name: "参加 次郎" });
    const member = joined.page;
    try {
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
    } finally {
      await joined.context.close();
    }
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

    const email = uniqueEmail("dup");
    const link = await inviteByEmail(page, ws, email);
    const joined = await joinByInvite(browser, link, { email, name: "重複 花子" });
    const other = joined.page;
    try {
    await other.goto(`/${ws}/settings/profile`);
    const otherInput = other.getByTestId("profile-github-login");
    await otherInput.fill("OctoCat");
    await otherInput.blur();
    await expect(other.getByText("この GitHub ユーザー名は、ほかの人が登録しています")).toBeVisible();
    await expect.poll(async () => (await bootstrap(other, ws)).me.githubLogin).toBeNull();
    } finally {
      await joined.context.close();
    }

    await page.goto(`/${ws}/settings/profile`);
    await input.fill("");
    await input.blur();
    await expect.poll(async () => (await bootstrap(page, ws)).me.githubLogin).toBeNull();
  });

  test("連携したチームで課題を作ると GitHub に Issue ができ、画面と履歴に出る", async () => {
    githubMock.labels.set("acme/widgets", [{ name: "Bug" }, { name: "GitHubOnly" }]);
    const data = await bootstrap(page, ws);
    const team = data.teams.find((item) => item.key === "DEF");
    expect(team).toBeTruthy();
    teamId = team!.id;
    meId = data.me.id;
    bugLabel = randomUUID();
    senOnlyLabel = randomUUID();
    expect((await postMutation(page, ws, { type: "user.update", args: { githubLogin: "octocat" } })).ok).toBe(true);
    expect((await postMutation(page, ws, { type: "label.create", args: { id: bugLabel, name: "Bug", color: "#c45c26" } })).ok).toBe(true);
    expect((await postMutation(page, ws, { type: "label.create", args: { id: senOnlyLabel, name: "SenOnly", color: "#4c6ef5" } })).ok).toBe(true);

    const created = await createSenIssue(page, ws, {
      title: "同期される課題",
      description: "最初の本文",
      assigneeId: meId,
      labelIds: [bugLabel, senOnlyLabel],
    });
    syncedIssueId = created.id;
    const remote = await waitMockIssue("同期される課題");
    syncedNumber = remote.number;
    expect(remote.body).toBe("最初の本文");
    expect(remote.labels.map((label) => label.name)).toEqual(["Bug"]);
    expect(remote.assignees.map((user) => user.login)).toEqual(["octocat"]);
    const link = await waitLink(page, ws, syncedIssueId);
    expect(link).toMatchObject({ repo: "acme/widgets", number: remote.number });
    await expect.poll(async () => activityActions(page, ws, syncedIssueId)).toContain("created");

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/${ws}/issue/DEF-${created.number}`);
    await expect(page.getByTestId("github-issue-link")).toHaveText(`acme/widgets#${remote.number}`);
    await expect(page.getByTestId("github-issue-link")).toHaveAttribute("href", `https://github.com/acme/widgets/issues/${remote.number}`);
    await expect(page.getByTestId("github-synced-at")).toBeVisible();
    await expect(page.getByTestId("github-unlink")).toBeVisible();
    await expect(page.getByTestId("activity-line").filter({ hasText: "が GitHub に" }).filter({ hasText: "を作りました" })).toBeVisible();
    const fits = await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
    expect(fits).toBe(true);
    await page.setViewportSize({ width: 1360, height: 860 });
    const html = await page.content();
    expect(html).not.toContain(GITHUB_TOKEN);
    expect(html).not.toContain(SECRET);
  });

  test("タイトルと説明は双方向に反映され、同じ変更では PATCH が止ま", async () => {
    const number = syncedNumber;
    const before = patchCount(number);
    expect((await postMutation(page, ws, { type: "issue.update", args: { id: syncedIssueId, patch: { title: "Sen で変えた", description: "Sen の説明" } } })).ok).toBe(true);
    await expect.poll(() => mockIssue(number)?.title ?? "", { timeout: 15_000 }).toBe("Sen で変えた");
    await expect.poll(() => mockIssue(number)?.body ?? "").toBe("Sen の説明");
    const pushed = patchCount(number);
    expect(pushed).toBeGreaterThan(before);
    await page.waitForTimeout(800);
    expect(patchCount(number)).toBe(pushed);

    const issue = mockIssue(number)!;
    issue.title = "GitHub で変えた";
    issue.body = "GitHub の説明";
    issue.updated_at = new Date().toISOString();
    const echoed = patchCount(number);
    expect((await postIssueWebhook(page, number, "edited")).status()).toBe(202);
    await expect.poll(async () => (await senIssue(page, ws, syncedIssueId)).title, { timeout: 15_000 }).toBe("GitHub で変えた");
    expect((await senIssue(page, ws, syncedIssueId)).description).toBe("GitHub の説明");
    await page.goto(`/${ws}/issue/DEF-${(await senIssue(page, ws, syncedIssueId)).number}`);
    await expect(page.getByTestId("activity-line").filter({ hasText: "GitHub 経由" }).first()).toBeVisible();
    await page.waitForTimeout(800);
    expect(patchCount(number)).toBe(echoed);
  });

  test("GitHub でタイトルを変えた人は、登録があればそのメンバー、無ければ連携した管理者として履歴に残る", async ({ browser }) => {
    const email = uniqueEmail("editor");
    const link = await inviteByEmail(page, ws, email);
    const joined = await joinByInvite(browser, link, { email, name: "編集 花子" });
    const editor = joined.page;
    let editorId = "";
    try {
      await editor.goto(`/${ws}/settings/profile`);
      const input = editor.getByTestId("profile-github-login");
      await input.fill("Title-Editor");
      await input.blur();
      await expect.poll(async () => (await bootstrap(editor, ws)).me.githubLogin).toBe("title-editor");
      editorId = (await bootstrap(editor, ws)).me.id;
    } finally {
      await joined.context.close();
    }

    const created = await createSenIssue(page, ws, { title: "行為者を記録する課題", description: "本文" });
    const remote = await waitMockIssue("行為者を記録する課題");
    await waitLink(page, ws, created.id);

    remote.title = "花子が変えた";
    remote.updated_at = new Date().toISOString();
    expect((await postIssueWebhook(page, remote.number, "edited", "Title-Editor")).status()).toBe(202);
    await expect.poll(async () => {
      const activity = (await threadOf(page, ws, created.id)).activities.find((item) => item.type === "title" && item.data.to === "花子が変えた");
      return activity ? `${activity.actorId}:${activity.via ?? ""}` : "";
    }, { timeout: 15_000 }).toBe(`${editorId}:GitHub`);

    remote.title = "未登録の人が変えた";
    remote.updated_at = new Date().toISOString();
    expect((await postIssueWebhook(page, remote.number, "edited", "stranger")).status()).toBe(202);
    await expect.poll(async () => {
      const activity = (await threadOf(page, ws, created.id)).activities.find((item) => item.type === "title" && item.data.to === "未登録の人が変えた");
      return activity ? `${activity.actorId}:${activity.via ?? ""}` : "";
    }, { timeout: 15_000 }).toBe(`${meId}:GitHub`);

    await page.goto(`/${ws}/issue/DEF-${created.number}`);
    await expect(page.getByTestId("activity-line").filter({ hasText: "編集 花子" }).filter({ hasText: "花子が変えた" })).toBeVisible();
    await expect(page.getByTestId("activity-line").filter({ hasText: "テスト 太郎" }).filter({ hasText: "未登録の人が変えた" })).toBeVisible();
  });

  test("完了とキャンセルは closed になり、GitHub の開閉は Sen のステータスになる", async () => {
    const number = syncedNumber;
    const data = await bootstrap(page, ws);
    const done = stateId(data, teamId, "completed", "完了");
    const canceled = stateId(data, teamId, "canceled", "キャンセル");
    const unstarted = stateId(data, teamId, "unstarted", "未着手");
    expect((await postMutation(page, ws, { type: "issue.update", args: { id: syncedIssueId, patch: { stateId: done } } })).ok).toBe(true);
    await expect.poll(() => mockIssue(number)?.state ?? "", { timeout: 15_000 }).toBe("closed");
    expect(mockIssue(number)?.state_reason).toBe("completed");

    expect((await postMutation(page, ws, { type: "issue.update", args: { id: syncedIssueId, patch: { stateId: canceled } } })).ok).toBe(true);
    await expect.poll(() => mockIssue(number)?.state_reason ?? "", { timeout: 15_000 }).toBe("not_planned");
    expect(mockIssue(number)?.state).toBe("closed");

    const issue = mockIssue(number)!;
    issue.state = "open";
    issue.state_reason = "reopened";
    issue.updated_at = new Date().toISOString();
    expect((await postIssueWebhook(page, number, "reopened")).status()).toBe(202);
    await expect.poll(async () => (await senIssue(page, ws, syncedIssueId)).stateId, { timeout: 15_000 }).toBe(unstarted);

    issue.state = "closed";
    issue.state_reason = "completed";
    issue.updated_at = new Date().toISOString();
    expect((await postIssueWebhook(page, number, "closed")).status()).toBe(202);
    await expect.poll(async () => (await senIssue(page, ws, syncedIssueId)).stateId, { timeout: 15_000 }).toBe(done);
  });

  test("閉じた理由だけが変わっても、完了・キャンセル・重複が双方向に反映される", async () => {
    const created = await createSenIssue(page, ws, { title: "理由を同期する課題", description: "" });
    const remote = await waitMockIssue("理由を同期する課題");
    await waitLink(page, ws, created.id);
    const data = await bootstrap(page, ws);
    const done = stateId(data, teamId, "completed", "完了");
    const canceled = stateId(data, teamId, "canceled", "キャンセル");
    const duplicate = stateId(data, teamId, "canceled", "重複");

    expect((await postMutation(page, ws, { type: "issue.update", args: { id: created.id, patch: { stateId: done } } })).ok).toBe(true);
    await expect.poll(() => mockIssue(remote.number)?.state ?? "", { timeout: 15_000 }).toBe("closed");
    expect(mockIssue(remote.number)?.state_reason).toBe("completed");

    expect((await postMutation(page, ws, { type: "issue.update", args: { id: created.id, patch: { stateId: canceled } } })).ok).toBe(true);
    await expect.poll(() => mockIssue(remote.number)?.state_reason ?? "", { timeout: 15_000 }).toBe("not_planned");
    expect(mockIssue(remote.number)?.state).toBe("closed");

    expect((await postMutation(page, ws, { type: "issue.update", args: { id: created.id, patch: { stateId: done } } })).ok).toBe(true);
    await expect.poll(() => mockIssue(remote.number)?.state_reason ?? "", { timeout: 15_000 }).toBe("completed");

    const issue = mockIssue(remote.number)!;
    issue.state = "closed";
    issue.state_reason = "not_planned";
    issue.updated_at = new Date().toISOString();
    expect((await postIssueWebhook(page, remote.number, "closed")).status()).toBe(202);
    await expect.poll(async () => (await senIssue(page, ws, created.id)).stateId, { timeout: 15_000 }).toBe(canceled);

    expect((await postMutation(page, ws, { type: "issue.update", args: { id: created.id, patch: { stateId: duplicate } } })).ok).toBe(true);
    await expect.poll(() => mockIssue(remote.number)?.state_reason ?? "", { timeout: 15_000 }).toBe("duplicate");
    expect(mockIssue(remote.number)?.state).toBe("closed");

    expect((await postMutation(page, ws, { type: "issue.update", args: { id: created.id, patch: { stateId: canceled } } })).ok).toBe(true);
    await expect.poll(() => mockIssue(remote.number)?.state_reason ?? "", { timeout: 15_000 }).toBe("not_planned");

    issue.state_reason = "duplicate";
    issue.updated_at = new Date().toISOString();
    expect((await postIssueWebhook(page, remote.number, "closed")).status()).toBe(202);
    await expect.poll(async () => (await senIssue(page, ws, created.id)).stateId, { timeout: 15_000 }).toBe(duplicate);
  });

  test("説明が両方で変わったら Sen を残し、GitHub 側の説明をコメントにして送る", async () => {
    const created = await createSenIssue(page, ws, { title: "説明が衝突する課題", description: "元の説明" });
    const remote = await waitMockIssue("説明が衝突する課題");
    await waitLink(page, ws, created.id);
    await page.waitForTimeout(800);
    remote.body = "GitHub だけが知っている説明";
    remote.updated_at = new Date().toISOString();
    expect((await postMutation(page, ws, { type: "issue.update", args: { id: created.id, patch: { description: "Sen に残す説明" } } })).ok).toBe(true);
    const note = "GitHub 側の説明と同時に変わったため、Sen の説明を残しました。GitHub 側の説明は次のとおりです。";
    await expect.poll(async () => (await senIssue(page, ws, created.id)).description, { timeout: 15_000 }).toBe("Sen に残す説明");
    await expect.poll(() => mockIssue(remote.number)?.body ?? "", { timeout: 15_000 }).toBe("Sen に残す説明");
    await expect.poll(async () => (await threadOf(page, ws, created.id)).comments.some((comment) => comment.body.includes(note) && comment.body.includes("GitHub だけが知っている説明")), { timeout: 15_000 }).toBe(true);
    await expect.poll(() => githubMock.comments.some((comment) => comment.number === remote.number && comment.body.includes(note) && comment.body.includes("GitHub だけが知っている説明") && comment.body.includes("<!-- sen:comment:")), { timeout: 15_000 }).toBe(true);
  });

  test("両側にあるラベルだけが行き来し、片方にしか無いラベルは残る", async () => {
    const created = await createSenIssue(page, ws, { title: "ラベルの課題", description: "", labelIds: [bugLabel, senOnlyLabel] });
    const remote = await waitMockIssue("ラベルの課題");
    expect(remote.labels.map((label) => label.name)).toEqual(["Bug"]);
    await waitLink(page, ws, created.id);
    remote.labels = [{ name: "Bug" }, { name: "GitHubOnly" }];
    remote.updated_at = new Date().toISOString();
    expect((await postIssueWebhook(page, remote.number, "labeled")).status()).toBe(202);
    await page.waitForTimeout(800);
    const sen = await senIssue(page, ws, created.id);
    const names = await labelNames(page, ws, sen.labelIds);
    expect(names).toContain("Bug");
    expect(names).toContain("SenOnly");
    expect(names).not.toContain("GitHubOnly");
    expect(mockIssue(remote.number)?.labels.map((label) => label.name)).toEqual(["Bug", "GitHubOnly"]);

    expect((await postMutation(page, ws, { type: "issue.update", args: { id: created.id, patch: { labelIds: [senOnlyLabel] } } })).ok).toBe(true);
    await expect.poll(() => mockIssue(remote.number)?.labels.map((label) => label.name).join(",") ?? "", { timeout: 15_000 }).toBe("GitHubOnly");
    expect((await senIssue(page, ws, created.id)).labelIds).toContain(senOnlyLabel);
  });

  test("登録したメンバーの担当者だけが行き来し、422 のときは担当者を外して送り直す", async () => {
    const created = await createSenIssue(page, ws, { title: "担当者の課題", description: "担当", assigneeId: meId });
    const remote = await waitMockIssue("担当者の課題");
    expect(remote.assignees.map((user) => user.login)).toEqual(["octocat"]);
    await waitLink(page, ws, created.id);
    remote.assignees = [{ login: "octocat" }, { login: "outsider" }];
    remote.updated_at = new Date().toISOString();
    expect((await postIssueWebhook(page, remote.number, "assigned")).status()).toBe(202);
    await page.waitForTimeout(800);
    expect((await senIssue(page, ws, created.id)).assigneeId).toBe(meId);
    expect(mockIssue(remote.number)?.assignees.map((user) => user.login)).toEqual(["octocat", "outsider"]);

    expect((await postMutation(page, ws, { type: "issue.update", args: { id: created.id, patch: { assigneeId: null } } })).ok).toBe(true);
    await expect.poll(() => (mockIssue(remote.number)?.assignees ?? []).map((user) => user.login).join(","), { timeout: 15_000 }).toBe("outsider");

    githubMock.rejectAssignees = true;
    try {
      const patches = patchCount(remote.number);
      expect((await postMutation(page, ws, { type: "issue.update", args: { id: created.id, patch: { title: "担当者は送れない", assigneeId: meId } } })).ok).toBe(true);
      await expect.poll(() => mockIssue(remote.number)?.title ?? "", { timeout: 15_000 }).toBe("担当者は送れない");
      const sent = githubMock.requests.filter((item) => item.method === "PATCH" && item.path === `/repos/acme/widgets/issues/${remote.number}`).slice(patches);
      expect(sent.some((item) => Array.isArray((item.body as { assignees?: unknown } | null)?.assignees) && ((item.body as { assignees: string[] }).assignees.length > 0))).toBe(true);
      const last = sent[sent.length - 1]?.body as { assignees?: unknown; title?: string };
      expect(last.assignees).toBeUndefined();
      expect(last.title).toBe("担当者は送れない");
      expect(mockIssue(remote.number)?.assignees.map((user) => user.login)).toEqual(["outsider"]);
      await expect.poll(async () => (await bootstrap(page, ws)).githubLinks.find((link) => link.issueId === created.id)?.lastError ?? "", { timeout: 15_000 }).toContain("担当者を GitHub に反映できませんでした（octocat）");
      await page.goto(`/${ws}/issue/DEF-${created.number}`);
      await expect(page.getByTestId("github-last-error")).toContainText("担当者を GitHub に反映できませんでした（octocat）");
      expect(await page.content()).not.toContain(GITHUB_TOKEN);
    } finally {
      githubMock.rejectAssignees = false;
    }
  });

  test("コメントは印つきで投稿され、戻ってきても二重にならず、GitHub の @名前 はメンションしない", async ({ browser }) => {
    const created = await createSenIssue(page, ws, { title: "コメントの課題", description: "コメント用" });
    const remote = await waitMockIssue("コメントの課題");
    await waitLink(page, ws, created.id);
    const commentId = randomUUID();
    expect((await postMutation(page, ws, { type: "comment.create", args: { id: commentId, issueId: created.id, body: "Sen からのコメント" } })).ok).toBe(true);
    await expect.poll(() => githubMock.comments.find((comment) => comment.number === remote.number)?.body ?? "", { timeout: 15_000 }).toContain("Sen からのコメント");
    const posted = githubMock.comments.find((comment) => comment.number === remote.number)!;
    expect(posted.body.startsWith("**")).toBe(true);
    expect(posted.body).toContain("（Sen）");
    expect(posted.body).toContain(`<!-- sen:comment:${commentId} -->`);
    expect((await postCommentWebhook(page, remote.number, posted)).status()).toBe(202);
    await page.waitForTimeout(800);
    const afterEcho = await threadOf(page, ws, created.id);
    expect(afterEcho.comments.filter((comment) => comment.body.includes("Sen からのコメント"))).toHaveLength(1);

    const member = githubMock.comments.length;
    githubMock.comments.push(mockComment(remote.number, "メンバーが書きました", "octocat"));
    expect((await postCommentWebhook(page, remote.number, githubMock.comments[member]!)).status()).toBe(202);
    await expect.poll(async () => (await threadOf(page, ws, created.id)).comments.some((comment) => comment.body === "メンバーが書きました" && comment.userId === meId && !comment.githubAuthor), { timeout: 15_000 }).toBe(true);

    const email = uniqueEmail("mention");
    const link = await inviteByEmail(page, ws, email);
    const joined = await joinByInvite(browser, link, { email, name: "言及 三郎" });
    const mentioned = joined.page;

    const outsider = githubMock.comments.length;
    githubMock.comments.push(mockComment(remote.number, "外部です @言及 三郎", "ghost"));
    expect((await postCommentWebhook(page, remote.number, githubMock.comments[outsider]!)).status()).toBe(202);
    await expect.poll(async () => (await threadOf(page, ws, created.id)).comments.some((comment) => comment.githubAuthor === "ghost"), { timeout: 15_000 }).toBe(true);
    await expect.poll(async () => (await bootstrap(mentioned, ws)).notifications.some((item) => item.type === "mention"), { timeout: 3_000 }).toBe(false);
    await joined.context.close();

    const spoofId = randomUUID();
    expect((await postMutation(page, ws, { type: "comment.create", args: { id: spoofId, issueId: created.id, body: "成り済まし", githubAuthor: "ghost" } })).ok).toBe(true);
    await expect.poll(async () => {
      const comment = (await threadOf(page, ws, created.id)).comments.find((item) => item.id === spoofId);
      return comment ? comment.githubAuthor : "missing";
    }, { timeout: 15_000 }).toBeNull();

    await page.goto(`/${ws}/issue/DEF-${created.number}`);
    const ghost = page.getByTestId("comment").filter({ hasText: "外部です @言及 三郎" });
    await expect(ghost).toContainText("@ghost（GitHub）");
    await expect(ghost.getByTestId("github-comment-avatar")).toBeVisible();
    await expect(ghost).toContainText("GitHub 経由");
    const own = page.getByTestId("comment").filter({ hasText: "メンバーが書きました" });
    await expect(own).toContainText("テスト 太郎");
    await expect(own.getByTestId("github-comment-avatar")).toHaveCount(0);
    await expect(own).toContainText("GitHub 経由");
  });

  test("連携のあとに作られた Issue だけを取り込み、古い Issue と PR は取り込まない", async () => {
    const repo = widgets();
    const old = pushMockIssue({ title: "連携より前の Issue", created_at: "2000-01-01T00:00:00.000Z", updated_at: new Date().toISOString() });
    const fresh = pushMockIssue({ title: "連携より後の Issue", created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
    const pull = pushMockIssue({ title: "これは PR", created_at: new Date().toISOString(), updated_at: new Date().toISOString(), pull_request: { url: "https://api.github.com/pulls/1" } });
    expect((await postIssueWebhook(page, old.number, "opened")).status()).toBe(202);
    expect((await postIssueWebhook(page, fresh.number, "opened")).status()).toBe(202);
    expect((await postIssueWebhook(page, pull.number, "opened")).status()).toBe(202);
    await expect.poll(async () => (await bootstrap(page, ws)).issues.some((issue) => issue.title === "連携より後の Issue"), { timeout: 15_000 }).toBe(true);
    const imported = (await bootstrap(page, ws)).issues.find((issue) => issue.title === "連携より後の Issue")!;
    await expect.poll(async () => activityActions(page, ws, imported.id)).toContain("imported");
    await page.waitForTimeout(800);
    const titles = (await bootstrap(page, ws)).issues.map((issue) => issue.title);
    expect(titles).not.toContain("連携より前の Issue");
    expect(titles).not.toContain("これは PR");
    expect(repo.id).toBeGreaterThan(0);
  });

  test("Webhook が無くても毎日の突き合わせで Sen に反映される", async () => {
    const created = await createSenIssue(page, ws, { title: "突き合わせの課題", description: "before" });
    const remote = await waitMockIssue("突き合わせの課題");
    await waitLink(page, ws, created.id);
    await page.waitForTimeout(500);
    remote.title = "Webhook なしで変えた";
    remote.updated_at = new Date().toISOString();
    const res = await page.request.post(`/api/dev/github/reconcile?ws=${encodeURIComponent(ws)}`, { headers: { "x-sen-client": "1" } });
    expect(res.ok()).toBeTruthy();
    await expect.poll(async () => (await senIssue(page, ws, created.id)).title, { timeout: 15_000 }).toBe("Webhook なしで変えた");
    const titles = (await bootstrap(page, ws)).issues.map((issue) => issue.title);
    expect(titles).not.toContain("連携より前の Issue");
    expect(titles).not.toContain("これは PR");
  });

  test("GitHub で Issue が削除されたら紐づけが外れ、履歴に残る", async () => {
    const created = await createSenIssue(page, ws, { title: "削除される課題", description: "消える" });
    const remote = await waitMockIssue("削除される課題");
    await waitLink(page, ws, created.id);
    githubMock.issues = githubMock.issues.filter((issue) => issue.number !== remote.number || issue.fullName !== "acme/widgets");
    expect((await postIssueWebhook(page, remote.number, "deleted")).status()).toBe(202);
    await expect.poll(async () => (await bootstrap(page, ws)).githubLinks.some((link) => link.issueId === created.id), { timeout: 15_000 }).toBe(false);
    await expect.poll(async () => activityActions(page, ws, created.id)).toContain("unlinked");
    await page.goto(`/${ws}/issue/DEF-${created.number}`);
    await expect(page.getByTestId("activity-line").filter({ hasText: "が GitHub の" }).filter({ hasText: "紐づけを外しました" })).toBeVisible();
  });

  test("手で紐づけ、作成、解除ができ、別の課題や別リポジトリは断る", async () => {
    const headers = { "x-sen-client": "1" };
    const unlinked = await page.request.delete(`/api/github/repos/${teamId}?ws=${encodeURIComponent(ws)}`, { headers });
    expect(unlinked.ok()).toBeTruthy();
    const older = await createSenIssue(page, ws, { title: "連携より前に作った課題", description: "手で作る" });
    const senSide = await createSenIssue(page, ws, { title: "Sen に合わせる課題", description: "Sen の本文" });
    const githubSide = await createSenIssue(page, ws, { title: "上書きされる Sen", description: "上書きされる本文" });
    const duplicate = await createSenIssue(page, ws, { title: "重複して紐づけたい", description: "" });
    await page.waitForTimeout(800);
    const relinked = await page.request.post(`/api/github/repos?ws=${encodeURIComponent(ws)}`, { headers, data: { teamId, repo: "acme/widgets" } });
    expect(relinked.ok()).toBeTruthy();
    await page.waitForTimeout(800);
    expect(githubMock.issues.some((issue) => issue.title === "連携より前に作った課題")).toBe(false);
    expect(githubMock.issues.some((issue) => issue.title === "Sen に合わせる課題")).toBe(false);

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/${ws}/issue/DEF-${older.number}`);
    await expect(page.getByTestId("github-create")).toBeVisible();
    const fits = await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
    expect(fits).toBe(true);
    await page.setViewportSize({ width: 1360, height: 860 });
    await page.getByTestId("github-create").click();
    const createdRemote = await waitMockIssue("連携より前に作った課題");
    await expect(page.getByTestId("github-issue-link")).toHaveText(`acme/widgets#${createdRemote.number}`, { timeout: 15_000 });
    await expect.poll(async () => activityActions(page, ws, older.id)).toContain("created");

    const senRemote = pushMockIssue({ title: "GitHub 側のタイトル", body: "GitHub 側の本文", created_at: "2000-01-01T00:00:00.000Z" });
    await page.goto(`/${ws}/issue/DEF-${senSide.number}`);
    await page.getByTestId("github-link-existing").click();
    await page.getByTestId("github-link-ref").fill(`acme/widgets#${senRemote.number}`);
    await page.getByTestId("github-link-prefer-sen").check();
    await page.getByTestId("github-link-submit").click();
    await expect(page.getByTestId("github-issue-link")).toHaveText(`acme/widgets#${senRemote.number}`, { timeout: 15_000 });
    await expect.poll(() => mockIssue(senRemote.number)?.title ?? "").toBe("Sen に合わせる課題");
    expect(mockIssue(senRemote.number)?.body).toBe("Sen の本文");
    expect((await senIssue(page, ws, senSide.id)).title).toBe("Sen に合わせる課題");
    await expect.poll(async () => activityActions(page, ws, senSide.id)).toContain("linked");

    const githubRemote = pushMockIssue({ title: "GitHub に合わせる", body: "GitHub の本文", created_at: "2000-01-01T00:00:00.000Z" });
    await page.goto(`/${ws}/issue/DEF-${githubSide.number}`);
    await page.getByTestId("github-link-existing").click();
    await page.getByTestId("github-link-ref").fill(`https://github.com/acme/widgets/issues/${githubRemote.number}`);
    await page.getByTestId("github-link-prefer-github").check();
    await page.getByTestId("github-link-submit").click();
    await expect(page.getByTestId("github-issue-link")).toBeVisible({ timeout: 15_000 });
    await expect.poll(async () => (await senIssue(page, ws, githubSide.id)).title).toBe("GitHub に合わせる");
    expect((await senIssue(page, ws, githubSide.id)).description).toBe("GitHub の本文");
    expect(mockIssue(githubRemote.number)?.title).toBe("GitHub に合わせる");

    const denied = await page.request.post(`/api/github/issues/${duplicate.id}/link?ws=${encodeURIComponent(ws)}`, {
      headers,
      data: { mode: "link", ref: String(senRemote.number), prefer: "sen" },
    });
    expect(denied.status()).toBe(409);
    expect(await denied.json()).toMatchObject({ error: "この Issue は、別の課題とすでに紐づいています" });

    addGitHubRepo("other/lib");
    pushMockIssue({ fullName: "other/lib", title: "別リポジトリ", created_at: new Date().toISOString() });
    const wrong = await page.request.post(`/api/github/issues/${duplicate.id}/link?ws=${encodeURIComponent(ws)}`, {
      headers,
      data: { mode: "link", ref: "other/lib#1", prefer: "github" },
    });
    expect(wrong.status()).toBe(400);
    expect(((await wrong.json()) as { error: string }).error).toContain("連携していないリポジトリ");

    const titleBefore = mockIssue(createdRemote.number)?.title;
    await page.goto(`/${ws}/issue/DEF-${older.number}`);
    await page.getByTestId("github-unlink").click();
    await expect(page.getByTestId("github-create")).toBeVisible({ timeout: 15_000 });
    expect(mockIssue(createdRemote.number)?.title).toBe(titleBefore);
    await expect.poll(async () => activityActions(page, ws, older.id)).toContain("unlinked");
    await expect(page.getByTestId("activity-line").filter({ hasText: "が GitHub の" }).filter({ hasText: "紐づけを外しました" })).toBeVisible();
  });

  test("下書きの PR が課題を進め、レビュー待ちとマージでさらに進み、Issue を閉じる", async () => {
    const created = await createSenIssue(page, ws, { title: "PR で進む課題", description: "進む" });
    const remote = await waitMockIssue("PR で進む課題");
    await waitLink(page, ws, created.id);
    const data = await bootstrap(page, ws);
    const doing = stateId(data, teamId, "started", "進行中");
    const review = stateId(data, teamId, "started", "レビュー中");
    const done = stateId(data, teamId, "completed", "完了");
    const pull = pushMockPull({
      title: "ログインを直す",
      body: `Fixes DEF-${created.number}`,
      headRef: "feature",
      draft: true,
      user: { login: "octocat" },
    });

    expect((await postPullWebhook(page, pull, "opened")).status()).toBe(202);
    await expect.poll(async () => (await senIssue(page, ws, created.id)).stateId, { timeout: 15_000 }).toBe(doing);
    await expect.poll(async () => (await pullOn(page, ws, created.id, pull.number))?.state ?? "", { timeout: 15_000 }).toBe("draft");

    await page.goto(`/${ws}/issue/DEF-${created.number}`);
    const card = page.getByTestId("github-pull").filter({ hasText: `#${pull.number} ログインを直す` });
    await expect(card).toBeVisible();
    await expect(card.getByTestId("github-pull-state")).toHaveText("下書き");
    await expect(card.getByTestId("github-pull-author")).toHaveText("octocat");
    await expect(card.locator("a")).toHaveAttribute("href", `https://github.com/acme/widgets/pull/${pull.number}`);
    await expectBadgesReadable(page);
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
    await page.setViewportSize({ width: 1360, height: 860 });

    await page.goto(`/${ws}/search?q=${encodeURIComponent("PR で進む課題")}`);
    const row = page.locator(`[data-testid="issue-row"][data-identifier="DEF-${created.number}"]`);
    await expect(row.getByTestId("issue-pr-mark")).toHaveText("1");

    pull.draft = false;
    pull.state = "open";
    pull.updated_at = new Date().toISOString();
    expect((await postPullWebhook(page, pull, "ready_for_review")).status()).toBe(202);
    await expect.poll(async () => (await senIssue(page, ws, created.id)).stateId, { timeout: 15_000 }).toBe(review);
    await page.goto(`/${ws}/issue/DEF-${created.number}`);
    await expect(page.getByTestId("github-pull").filter({ hasText: "ログインを直す" }).getByTestId("github-pull-state")).toHaveText("レビュー待ち");
    await expectBadgesReadable(page);
    await expect(page.getByTestId("activity-line").filter({ hasText: "ステータスを" }).filter({ hasText: "GitHub 経由" }).first()).toBeVisible();

    pull.state = "closed";
    pull.merged = true;
    pull.updated_at = new Date().toISOString();
    expect((await postPullWebhook(page, pull, "closed")).status()).toBe(202);
    await expect.poll(async () => (await senIssue(page, ws, created.id)).stateId, { timeout: 15_000 }).toBe(done);
    await expect.poll(() => mockIssue(remote.number)?.state ?? "", { timeout: 15_000 }).toBe("closed");
    expect(mockIssue(remote.number)?.state_reason).toBe("completed");
    await page.goto(`/${ws}/issue/DEF-${created.number}`);
    await expect(page.getByTestId("github-pull").filter({ hasText: "ログインを直す" }).getByTestId("github-pull-state")).toHaveText("マージ済み");
    await expectBadgesReadable(page);

    const closed = pushMockPull({
      title: "マージしない",
      body: `DEF-${created.number}`,
      headRef: "wip",
      state: "closed",
      user: { login: "octocat" },
    });
    expect((await postPullWebhook(page, closed, "closed")).status()).toBe(202);
    await expect.poll(async () => (await pullOn(page, ws, created.id, closed.number))?.state ?? "", { timeout: 15_000 }).toBe("closed");
    await page.goto(`/${ws}/issue/DEF-${created.number}`);
    await expect(page.getByTestId("github-pull").filter({ hasText: "マージしない" }).getByTestId("github-pull-state")).toHaveText("閉じた");
    await expectBadgesReadable(page);
    await page.goto(`/${ws}/search?q=${encodeURIComponent("PR で進む課題")}`);
    await expect(page.locator(`[data-testid="issue-row"][data-identifier="DEF-${created.number}"]`).getByTestId("issue-pr-mark")).toHaveCount(0);
  });

  test("完了とキャンセルの課題は、新しい PR でもステータスが動かない", async () => {
    const data = await bootstrap(page, ws);
    const done = stateId(data, teamId, "completed", "完了");
    const canceled = stateId(data, teamId, "canceled", "キャンセル");
    const finished = await createSenIssue(page, ws, { title: "完了のままの課題", description: "" });
    await waitLink(page, ws, finished.id);
    expect((await postMutation(page, ws, { type: "issue.update", args: { id: finished.id, patch: { stateId: done } } })).ok).toBe(true);
    await expect.poll(async () => (await senIssue(page, ws, finished.id)).stateId, { timeout: 15_000 }).toBe(done);
    const again = pushMockPull({ title: "もう一つの PR", body: "", headRef: `def-${finished.number}-again`, draft: true, user: { login: "octocat" } });
    expect((await postPullWebhook(page, again, "opened")).status()).toBe(202);
    await expect.poll(async () => (await pullOn(page, ws, finished.id, again.number))?.number ?? 0, { timeout: 15_000 }).toBe(again.number);
    expect((await senIssue(page, ws, finished.id)).stateId).toBe(done);

    const dropped = await createSenIssue(page, ws, { title: "キャンセルのままの課題", description: "" });
    await waitLink(page, ws, dropped.id);
    expect((await postMutation(page, ws, { type: "issue.update", args: { id: dropped.id, patch: { stateId: canceled } } })).ok).toBe(true);
    await expect.poll(async () => (await senIssue(page, ws, dropped.id)).stateId, { timeout: 15_000 }).toBe(canceled);
    const late = pushMockPull({ title: "キャンセル後の PR", body: `DEF-${dropped.number}`, headRef: "late", user: { login: "octocat" } });
    expect((await postPullWebhook(page, late, "opened")).status()).toBe(202);
    await expect.poll(async () => (await pullOn(page, ws, dropped.id, late.number))?.number ?? 0, { timeout: 15_000 }).toBe(late.number);
    expect((await senIssue(page, ws, dropped.id)).stateId).toBe(canceled);
  });

  test("PR の本文から参照を消すと紐づけが外れ、ブランチ名の参照は残る", async () => {
    const kept = await createSenIssue(page, ws, { title: "ブランチに残る課題", description: "" });
    const dropped = await createSenIssue(page, ws, { title: "本文だけで紐づく課題", description: "" });
    await waitLink(page, ws, kept.id);
    await waitLink(page, ws, dropped.id);
    const pull = pushMockPull({
      title: "両方を参照する",
      body: `Fixes DEF-${dropped.number}`,
      headRef: `taro/def-${kept.number}`,
      user: { login: "octocat" },
    });
    expect((await postPullWebhook(page, pull, "opened")).status()).toBe(202);
    await expect.poll(async () => `${Boolean(await pullOn(page, ws, kept.id, pull.number))}:${Boolean(await pullOn(page, ws, dropped.id, pull.number))}`, { timeout: 15_000 }).toBe("true:true");

    pull.body = "参照を消した";
    pull.updated_at = new Date().toISOString();
    expect((await postPullWebhook(page, pull, "edited")).status()).toBe(202);
    await expect.poll(async () => `${Boolean(await pullOn(page, ws, kept.id, pull.number))}:${Boolean(await pullOn(page, ws, dropped.id, pull.number))}`, { timeout: 15_000 }).toBe("true:false");
  });

  test("連携していないチームの課題は PR が見えるが、ステータスは動かない", async () => {
    const data = await bootstrap(page, ws);
    const other = data.teams.find((team) => team.key === "OTH");
    expect(other).toBeTruthy();
    const untouched = stateId(data, other!.id, "unstarted", "未着手");
    const id = randomUUID();
    expect((await postMutation(page, ws, { type: "issue.create", args: { id, teamId: other!.id, title: "連携していないチームの課題", description: "" } })).ok).toBe(true);
    const created = await waitSenIssue(page, ws, id);
    expect(created.stateId).toBe(untouched);
    const pull = pushMockPull({
      title: "他チームへの PR",
      body: `OTH-${created.number}`,
      headRef: "elsewhere",
      user: { login: "octocat" },
    });
    expect((await postPullWebhook(page, pull, "opened")).status()).toBe(202);
    await expect.poll(async () => (await pullOn(page, ws, created.id, pull.number))?.title ?? "", { timeout: 15_000 }).toBe("他チームへの PR");
    expect((await senIssue(page, ws, created.id)).stateId).toBe(untouched);
    await page.goto(`/${ws}/issue/OTH-${created.number}`);
    await expect(page.getByTestId("github-issue")).toBeVisible();
    await expect(page.getByTestId("github-pull")).toContainText(`#${pull.number} 他チームへの PR`);
    await expect(page.getByTestId("github-create")).toHaveCount(0);
    await page.goto(`/${ws}/search?q=${encodeURIComponent("連携していないチームの課題")}`);
    await expect(page.locator(`[data-testid="issue-row"][data-identifier="OTH-${created.number}"]`).getByTestId("issue-pr-mark")).toHaveText("1");
  });

  test("PR の作者が GitHub ユーザー名を登録したメンバーなら、その人の操作として履歴に残る", async ({ browser }) => {
    const email = uniqueEmail("author");
    const link = await inviteByEmail(page, ws, email);
    const joined = await joinByInvite(browser, link, { email, name: "PR 作者" });
    const author = joined.page;
    let authorId = "";
    try {
      await author.goto(`/${ws}/settings/profile`);
      const input = author.getByTestId("profile-github-login");
      await input.fill("Pull-Author");
      await input.blur();
      await expect.poll(async () => (await bootstrap(author, ws)).me.githubLogin).toBe("pull-author");
      authorId = (await bootstrap(author, ws)).me.id;
    } finally {
      await joined.context.close();
    }

    const created = await createSenIssue(page, ws, { title: "作者が残る課題", description: "" });
    await waitLink(page, ws, created.id);
    const pull = pushMockPull({
      title: "作者の PR",
      body: "",
      headRef: `def-${created.number}-by-author`,
      draft: true,
      user: { login: "Pull-Author" },
    });
    expect((await postPullWebhook(page, pull, "opened")).status()).toBe(202);
    await expect.poll(async () => {
      const activity = (await threadOf(page, ws, created.id)).activities.find((item) => item.type === "state");
      return activity ? `${activity.actorId}:${activity.via ?? ""}` : "";
    }, { timeout: 15_000 }).toBe(`${authorId}:GitHub`);
    await page.goto(`/${ws}/issue/DEF-${created.number}`);
    const line = page.getByTestId("activity-line").filter({ hasText: "ステータスを" }).filter({ hasText: "PR 作者" });
    await expect(line).toContainText("GitHub 経由");
    await expect(page.getByTestId("github-pull-author")).toHaveText("Pull-Author");
  });

  test("自動の移動を「変えない」にするとステータスは動かない", async () => {
    const before = await bootstrap(page, ws);
    const draft = stateId(before, teamId, "started", "進行中");
    const review = stateId(before, teamId, "started", "レビュー中");
    const done = stateId(before, teamId, "completed", "完了");
    const headers = { "x-sen-client": "1" };
    try {
      const cleared = await page.request.patch(`/api/github/repos/${teamId}?ws=${encodeURIComponent(ws)}`, {
        headers,
        data: { prDraftStateId: null, prOpenStateId: null, prMergedStateId: null },
      });
      expect(cleared.ok()).toBeTruthy();
      const created = await createSenIssue(page, ws, { title: "動かさない課題", description: "" });
      await waitLink(page, ws, created.id);
      const start = (await senIssue(page, ws, created.id)).stateId;
      const pull = pushMockPull({
        title: "設定で止める",
        body: `DEF-${created.number}`,
        headRef: "hold",
        draft: true,
        user: { login: "octocat" },
      });
      expect((await postPullWebhook(page, pull, "opened")).status()).toBe(202);
      await expect.poll(async () => (await pullOn(page, ws, created.id, pull.number))?.state ?? "", { timeout: 15_000 }).toBe("draft");
      expect((await senIssue(page, ws, created.id)).stateId).toBe(start);
      pull.draft = false;
      pull.state = "closed";
      pull.merged = true;
      pull.updated_at = new Date().toISOString();
      expect((await postPullWebhook(page, pull, "closed")).status()).toBe(202);
      await expect.poll(async () => (await pullOn(page, ws, created.id, pull.number))?.state ?? "", { timeout: 15_000 }).toBe("merged");
      expect((await senIssue(page, ws, created.id)).stateId).toBe(start);
    } finally {
      const restored = await page.request.patch(`/api/github/repos/${teamId}?ws=${encodeURIComponent(ws)}`, {
        headers,
        data: { prDraftStateId: draft, prOpenStateId: review, prMergedStateId: done },
      });
      expect(restored.ok()).toBeTruthy();
    }
  });

  test("Webhook を送らなくても突き合わせで PR の紐づけが反映される", async () => {
    const created = await createSenIssue(page, ws, { title: "突き合わせで紐づく課題", description: "" });
    await waitLink(page, ws, created.id);
    const pull = pushMockPull({
      title: "Webhook なしの PR",
      body: `Fixes DEF-${created.number}`,
      headRef: "reconcile-me",
      draft: true,
      user: { login: "octocat" },
    });
    const res = await page.request.post(`/api/dev/github/reconcile?ws=${encodeURIComponent(ws)}`, { headers: { "x-sen-client": "1" } });
    expect(res.ok()).toBeTruthy();
    await expect.poll(async () => (await pullOn(page, ws, created.id, pull.number))?.title ?? "", { timeout: 15_000 }).toBe("Webhook なしの PR");
    const data = await bootstrap(page, ws);
    await expect.poll(async () => (await senIssue(page, ws, created.id)).stateId, { timeout: 15_000 }).toBe(stateId(data, teamId, "started", "進行中"));
  });

  test("コメントの応答が失われても、やり直しで二重に投稿しない", async () => {
    const created = await createSenIssue(page, ws, { title: "コメントを一度だけ送る", description: "本文" });
    const remote = await waitMockIssue("コメントを一度だけ送る");
    await waitLink(page, ws, created.id);
    const commentId = randomUUID();
    const posts = () => githubMock.requests.filter((item) => item.method === "POST" && item.path === `/repos/acme/widgets/issues/${remote.number}/comments`).length;
    const before = posts();
    githubMock.loseOnce = { method: "POST", suffix: "/comments" };
    try {
      expect((await postMutation(page, ws, { type: "comment.create", args: { id: commentId, issueId: created.id, body: "最初の本文" } })).ok).toBe(true);
      await expect.poll(() => githubMock.comments.filter((comment) => comment.number === remote.number).length).toBe(1);
      expect(githubMock.loseOnce).toBeNull();
      expect((await postMutation(page, ws, { type: "comment.update", args: { id: commentId, body: "最初の本文のまま" } })).ok).toBe(true);
      await expect.poll(() => githubMock.requests.filter((item) => item.method === "GET" && item.path === `/repos/acme/widgets/issues/${remote.number}/comments`).length).toBeGreaterThan(0);
    } finally {
      githubMock.loseOnce = null;
    }
    const posted = githubMock.comments.filter((comment) => comment.number === remote.number);
    expect(posted).toHaveLength(1);
    expect(posted[0]?.body).toContain("最初の本文");
    expect(posted[0]?.body).toContain(`<!-- sen:comment:${commentId} -->`);
    expect(posts()).toBe(before + 1);
  });

  test("Issue の応答が失われても、やり直しで二重に作らない", async () => {
    const title = "Issue を一度だけ作る";
    const description = "失われた応答の本文";
    githubMock.loseOnce = { method: "POST", suffix: "/issues" };
    try {
      const created = await createSenIssue(page, ws, { title, description });
      await expect.poll(() => githubMock.issues.filter((issue) => issue.title === title).length).toBe(1);
      expect(githubMock.loseOnce).toBeNull();
      expect((await postMutation(page, ws, { type: "issue.update", args: { id: created.id, patch: { priority: 2 } } })).ok).toBe(true);
      await waitLink(page, ws, created.id);
    } finally {
      githubMock.loseOnce = null;
    }
    expect(githubMock.issues.filter((issue) => issue.title === title)).toHaveLength(1);
    expect(githubMock.issues.find((issue) => issue.title === title)?.body).toBe(description);
    expect(githubMock.requests.filter((item) => item.method === "POST" && item.path === "/repos/acme/widgets/issues" && (item.body as { title?: string } | null)?.title === title)).toHaveLength(1);
    expect(githubMock.requests.some((item) => item.method === "GET" && item.path === "/repos/acme/widgets/issues" && item.search.includes("creator="))).toBe(true);
  });

  test("Issue の作成待ちのあいだのコメントは、できたあとに届く", async () => {
    const title = "コメントを後から送る";
    githubMock.failOnce = { method: "POST", suffix: "/issues" };
    try {
      const created = await createSenIssue(page, ws, { title, description: "あとで" });
      await expect.poll(() => githubMock.requests.some((item) => item.method === "POST" && item.path === "/repos/acme/widgets/issues" && (item.body as { title?: string } | null)?.title === title)).toBe(true);
      expect(githubMock.issues.some((issue) => issue.title === title)).toBe(false);
      const commentId = randomUUID();
      expect((await postMutation(page, ws, { type: "comment.create", args: { id: commentId, issueId: created.id, body: "作成を待っていた" } })).ok).toBe(true);
      expect((await postMutation(page, ws, { type: "issue.update", args: { id: created.id, patch: { priority: 3 } } })).ok).toBe(true);
      await waitLink(page, ws, created.id);
      await expect.poll(() => githubMock.comments.some((comment) => comment.body.includes("作成を待っていた") && comment.body.includes(`<!-- sen:comment:${commentId} -->`))).toBe(true);
    } finally {
      githubMock.failOnce = null;
    }
    expect(githubMock.issues.filter((issue) => issue.title === title)).toHaveLength(1);
  });

  test("送る前の編集は届き、送ったあとの編集は届かない", async () => {
    const created = await createSenIssue(page, ws, { title: "編集のタイミング", description: "本文" });
    const remote = await waitMockIssue("編集のタイミング");
    await waitLink(page, ws, created.id);
    const commentId = randomUUID();
    const posts = () => githubMock.requests.filter((item) => item.method === "POST" && item.path === `/repos/acme/widgets/issues/${remote.number}/comments`).length;
    githubMock.failOnce = { method: "POST", suffix: "/comments" };
    try {
      expect((await postMutation(page, ws, { type: "comment.create", args: { id: commentId, issueId: created.id, body: "送信前" } })).ok).toBe(true);
      await expect.poll(() => posts()).toBeGreaterThan(0);
      expect(githubMock.comments.filter((comment) => comment.number === remote.number)).toHaveLength(0);
      expect((await postMutation(page, ws, { type: "comment.update", args: { id: commentId, body: "送信前に直した" } })).ok).toBe(true);
      await expect.poll(() => githubMock.comments.find((comment) => comment.number === remote.number)?.body ?? "").toContain("送信前に直した");
    } finally {
      githubMock.failOnce = null;
    }
    const sent = posts();
    expect(githubMock.comments.filter((comment) => comment.number === remote.number)).toHaveLength(1);
    expect((await postMutation(page, ws, { type: "comment.update", args: { id: commentId, body: "送ったあと" } })).ok).toBe(true);
    expect((await postMutation(page, ws, { type: "issue.update", args: { id: created.id, patch: { title: "編集のタイミングを確認" } } })).ok).toBe(true);
    await expect.poll(() => mockIssue(remote.number)?.title ?? "").toBe("編集のタイミングを確認");
    expect(posts()).toBe(sent);
    expect(githubMock.comments.find((comment) => comment.number === remote.number)?.body ?? "").not.toContain("送ったあと");
    expect(githubMock.comments.find((comment) => comment.number === remote.number)?.body ?? "").toContain("送信前に直した");
  });

  test("上限いっぱいのコメントは印を残して GitHub に届く", async () => {
    const created = await createSenIssue(page, ws, { title: "長いコメント", description: "本文" });
    const remote = await waitMockIssue("長いコメント");
    await waitLink(page, ws, created.id);
    const commentId = randomUUID();
    const body = "あ".repeat(MARKDOWN_MAX_LENGTH);
    expect((await postMutation(page, ws, { type: "comment.create", args: { id: commentId, issueId: created.id, body } })).ok).toBe(true);
    await expect.poll(() => githubMock.comments.find((comment) => comment.number === remote.number)?.body ?? "").toContain(`<!-- sen:comment:${commentId} -->`);
    const posted = githubMock.comments.find((comment) => comment.number === remote.number)!;
    expect(posted.body.length).toBeLessThanOrEqual(MARKDOWN_MAX_LENGTH);
    expect(posted.body).toContain("…（長いため一部を省きました。全文は Sen にあります）");
    expect(posted.body.endsWith(`<!-- sen:comment:${commentId} -->`)).toBe(true);
    const saved = (await threadOf(page, ws, created.id)).comments.find((comment) => comment.id === commentId);
    expect(saved?.body).toHaveLength(MARKDOWN_MAX_LENGTH);
  });

  test("突き合わせの途中の編集は、GitHub の値で上書きされない", async () => {
    const created = await createSenIssue(page, ws, { title: "上書きされない課題", description: "本文" });
    const remote = await waitMockIssue("上書きされない課題");
    await waitLink(page, ws, created.id);
    await page.waitForTimeout(400);
    remote.title = "GitHub の古い値";
    remote.updated_at = new Date().toISOString();
    const held = holdGitHubGet(`/repos/acme/widgets/issues/${remote.number}`);
    try {
      expect((await postIssueWebhook(page, remote.number, "edited")).status()).toBe(202);
      await held.entered;
      expect((await postMutation(page, ws, { type: "issue.update", args: { id: created.id, patch: { title: "Sen で残す" } } })).ok).toBe(true);
    } finally {
      held.release();
    }
    await expect.poll(async () => (await senIssue(page, ws, created.id)).title, { timeout: 15_000 }).toBe("Sen で残す");
    await expect.poll(() => mockIssue(remote.number)?.title ?? "", { timeout: 15_000 }).toBe("Sen で残す");
    const titles = (await threadOf(page, ws, created.id)).activities.filter((item) => item.type === "title").map((item) => item.data.to);
    expect(titles).toContain("Sen で残す");
    expect(titles).not.toContain("GitHub の古い値");
  });

  test("遅れて届いた PR の Webhook は、今の PR で紐づける", async () => {
    const kept = await createSenIssue(page, ws, { title: "PR に残る課題", description: "" });
    const dropped = await createSenIssue(page, ws, { title: "PR から消した課題", description: "" });
    await waitLink(page, ws, kept.id);
    await waitLink(page, ws, dropped.id);
    const pull = pushMockPull({
      title: "今のタイトル",
      body: `Fixes DEF-${kept.number}`,
      headRef: "current-branch",
      state: "closed",
      merged: true,
      user: { login: "octocat" },
    });
    expect((await postPullWebhook(page, pull, "closed")).status()).toBe(202);
    await expect.poll(async () => (await pullOn(page, ws, kept.id, pull.number))?.state ?? "", { timeout: 15_000 }).toBe("merged");
    expect(await pullOn(page, ws, dropped.id, pull.number)).toBeUndefined();

    const repo = widgets();
    const pullPath = `/repos/acme/widgets/pulls/${pull.number}`;
    const beforeGets = githubMock.requests.filter((item) => item.method === "GET" && item.path === pullPath).length;
    expect((await postWebhook(page.request, {
      event: "pull_request",
      body: JSON.stringify({
        action: "opened",
        pull_request: {
          number: pull.number,
          title: "古いタイトル",
          body: `Fixes DEF-${kept.number}\nFixes DEF-${dropped.number}`,
          html_url: `https://github.com/acme/widgets/pull/${pull.number}`,
          state: "open",
          draft: false,
          merged: false,
          user: { login: "old-author" },
          head: { ref: "old-branch" },
        },
        repository: { id: repo.id, full_name: repo.full_name },
        sender: { login: "old-author" },
      }),
    })).status()).toBe(202);
    await expect.poll(() => githubMock.requests.filter((item) => item.method === "GET" && item.path === pullPath).length).toBeGreaterThan(beforeGets);
    await expect.poll(async () => {
      const row = await pullOn(page, ws, kept.id, pull.number);
      return row ? `${row.state}:${row.title}:${row.author ?? ""}` : "";
    }, { timeout: 15_000 }).toBe("merged:今のタイトル:octocat");
    expect(await pullOn(page, ws, dropped.id, pull.number)).toBeUndefined();
    await page.goto(`/${ws}/search?q=${encodeURIComponent("PR に残る課題")}`);
    await expect(page.locator(`[data-testid="issue-row"][data-identifier="DEF-${kept.number}"]`).getByTestId("issue-pr-mark")).toHaveCount(0);

    const missing = 880001;
    expect((await postWebhook(page.request, {
      event: "pull_request",
      body: JSON.stringify({
        action: "opened",
        pull_request: {
          number: missing,
          title: "無い PR",
          body: `Fixes DEF-${kept.number}`,
          html_url: `https://github.com/acme/widgets/pull/${missing}`,
          state: "open",
          draft: false,
          merged: false,
          user: { login: "octocat" },
          head: { ref: `def-${kept.number}-missing` },
        },
        repository: { id: repo.id, full_name: repo.full_name },
        sender: { login: "octocat" },
      }),
    })).status()).toBe(202);
    await expect.poll(() => githubMock.requests.some((item) => item.method === "GET" && item.path === `/repos/acme/widgets/pulls/${missing}`)).toBe(true);
    await page.waitForTimeout(800);
    expect((await bootstrap(page, ws)).githubPulls.some((item) => item.number === missing)).toBe(false);
    expect((await pullOn(page, ws, kept.id, pull.number))?.state).toBe("merged");
  });

  test("ボットのコメントはボットの名前で表示される", async () => {
    const rejected = await postMutation(page, ws, { type: "user.update", args: { githubLogin: "github-actions[bot]" } });
    expect(rejected.ok).toBe(false);
    expect(rejected.error ?? "").toContain("形式");
    const created = await createSenIssue(page, ws, { title: "ボットのコメント", description: "" });
    const remote = await waitMockIssue("ボットのコメント");
    await waitLink(page, ws, created.id);
    const comment = mockComment(remote.number, "ボットが書きました", "github-actions[bot]");
    githubMock.comments.push(comment);
    expect((await postCommentWebhook(page, remote.number, comment)).status()).toBe(202);
    await expect.poll(async () => (await threadOf(page, ws, created.id)).comments.some((item) => item.githubAuthor === "github-actions[bot]"), { timeout: 15_000 }).toBe(true);
    await page.goto(`/${ws}/issue/DEF-${created.number}`);
    const bot = page.getByTestId("comment").filter({ hasText: "ボットが書きました" });
    await expect(bot).toContainText("@github-actions[bot]（GitHub）");
    await expect(bot).not.toContainText("テスト 太郎");
  });

  test("登録の無い GitHub ユーザーのコメントは購読中の管理者に届く", async ({ browser }) => {
    const created = await createSenIssue(page, ws, { title: "通知の課題", description: "" });
    const remote = await waitMockIssue("通知の課題");
    await waitLink(page, ws, created.id);
    const email = uniqueEmail("gh-note");
    const link = await inviteByEmail(page, ws, email);
    const joined = await joinByInvite(browser, link, { email, name: "通知 メンバー" });
    const member = joined.page;
    try {
      await member.goto(`/${ws}/settings/profile`);
      const input = member.getByTestId("profile-github-login");
      await input.fill("note-member");
      await input.blur();
      await expect.poll(async () => (await bootstrap(member, ws)).me.githubLogin).toBe("note-member");
      const memberId = (await bootstrap(member, ws)).me.id;
      expect((await postMutation(page, ws, { type: "issue.update", args: { id: created.id, patch: { subscriberIds: [meId, memberId] } } })).ok).toBe(true);

      const outsider = mockComment(remote.number, "外部からのコメント", "ghost");
      githubMock.comments.push(outsider);
      expect((await postCommentWebhook(page, remote.number, outsider)).status()).toBe(202);
      await expect.poll(async () => {
        const comment = (await threadOf(page, ws, created.id)).comments.find((item) => item.body === "外部からのコメント");
        if (!comment) return false;
        return (await bootstrap(page, ws)).notifications.some((item) => item.type === "comment" && item.data.commentId === comment.id);
      }, { timeout: 15_000 }).toBe(true);

      const own = mockComment(remote.number, "メンバー本人のコメント", "note-member");
      githubMock.comments.push(own);
      expect((await postCommentWebhook(page, remote.number, own)).status()).toBe(202);
      await expect.poll(async () => {
        const comment = (await threadOf(page, ws, created.id)).comments.find((item) => item.body === "メンバー本人のコメント");
        if (!comment) return "";
        const memberHas = (await bootstrap(member, ws)).notifications.some((item) => item.type === "comment" && item.data.commentId === comment.id);
        const adminHas = (await bootstrap(page, ws)).notifications.some((item) => item.type === "comment" && item.data.commentId === comment.id);
        return `${memberHas}:${adminHas}`;
      }, { timeout: 15_000 }).toBe("false:true");
    } finally {
      await joined.context.close();
    }
  });

  test("毎日の突き合わせは 3,000 件で打ち切っても続きを読む", async () => {
    test.setTimeout(180_000);
    const created = await createSenIssue(page, ws, { title: "続きの受け皿", description: "" });
    const remote = await waitMockIssue("続きの受け皿");
    await waitLink(page, ws, created.id);
    const start = Date.now() + 120_000;
    // 既存の Issue が先頭に入っても、3001 件目が次の突き合わせに残るように、時刻をずらして 3,000 件置く
    pushAgedSeries(3000, start);
    const targetAt = new Date(start + 3000 * 3000).toISOString();
    const target = pushMockIssue({ title: "打ち切りの先の課題", created_at: targetAt, updated_at: targetAt });
    const late = mockComment(remote.number, "打ち切りの先のコメント", "ghost");
    late.created_at = targetAt;
    late.updated_at = targetAt;
    githubMock.comments.push(late);

    const reconcile = () =>
      page.request.post(`/api/dev/github/reconcile?ws=${encodeURIComponent(ws)}`, { headers: { "x-sen-client": "1" }, timeout: 120_000 });
    expect((await reconcile()).ok()).toBeTruthy();
    await page.waitForTimeout(2500);
    expect((await bootstrap(page, ws)).issues.some((issue) => issue.title === "打ち切りの先の課題")).toBe(false);
    expect((await threadOf(page, ws, created.id)).comments.some((comment) => comment.body === "打ち切りの先のコメント")).toBe(false);
    expect((await reconcile()).ok()).toBeTruthy();
    await expect.poll(async () => (await bootstrap(page, ws)).issues.some((issue) => issue.title === "打ち切りの先の課題"), { timeout: 30_000 }).toBe(true);
    await expect.poll(async () => (await threadOf(page, ws, created.id)).comments.some((comment) => comment.body === "打ち切りの先のコメント"), { timeout: 30_000 }).toBe(true);
    expect(target.number).toBeGreaterThan(0);
  });
});

test("長いコメントは印を残して 65,536 文字以内に収まる", () => {
  const id = "11111111-1111-4111-8111-111111111111";
  expect(formatOutboundComment("太郎", "本文", id)).toBe(`**太郎**（Sen）\n\n本文\n\n<!-- sen:comment:${id} -->`);

  const name = "A";
  const head = `**${name}**（Sen）\n\n`;
  const marker = `\n\n<!-- sen:comment:${id} -->`;
  const note = "\n\n…（長いため一部を省きました。全文は Sen にあります）";
  const room = MARKDOWN_MAX_LENGTH - head.length - note.length - marker.length;
  const body = (room % 2 === 0 ? "x" : "") + "😀".repeat(40_000);
  expect(body.length).toBeGreaterThan(MARKDOWN_MAX_LENGTH);
  const out = formatOutboundComment(name, body, id);
  expect(out.length).toBeLessThanOrEqual(MARKDOWN_MAX_LENGTH);
  expect(out).toContain("…（長いため一部を省きました。全文は Sen にあります）");
  expect(out.endsWith(`<!-- sen:comment:${id} -->`)).toBe(true);
  for (let i = 0; i < out.length; i++) {
    const code = out.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = out.charCodeAt(i + 1);
      expect(next).toBeGreaterThanOrEqual(0xdc00);
      expect(next).toBeLessThanOrEqual(0xdfff);
      i += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new Error("サロゲートの下位だけが残っている");
    }
  }
});

test("課題の 3-way 比較はブラウザを使わない", () => {
  expect(mergeScalar("同じ", "同じ", "同じ")).toBe("none");
  expect(mergeScalar("元", "Sen", "元")).toBe("push");
  expect(mergeScalar("元", "元", "GitHub")).toBe("pull");
  expect(mergeScalar("元", "両方", "両方")).toBe("none");
  expect(mergeScalar("元", "Sen", "GitHub")).toBe("sen-wins");

  expect(mergeOpenClosed("open", "closed:completed", "open")).toBe("push");
  expect(mergeOpenClosed("open", "open", "closed:completed")).toBe("pull");
  expect(mergeOpenClosed("open", "closed:completed", "closed:not_planned")).toBe("sen-wins");
  expect(mergeOpenClosed("closed:completed", "closed:not_planned", "closed:completed")).toBe("push");
  expect(mergeOpenClosed("closed:completed", "closed:completed", "closed:not_planned")).toBe("pull");
  expect(mergeOpenClosed("closed:completed", "closed:not_planned", "closed:duplicate")).toBe("sen-wins");
  expect(mergeOpenClosed("closed:completed", "closed:not_planned", "closed:not_planned")).toBe("none");
  expect(mergeOpenClosed("closed:completed", "closed:completed", "closed:completed")).toBe("none");
  expect(mergeOpenClosed("closed", "closed:completed", "closed:not_planned")).toBe("none");
  expect(mergeOpenClosed("closed", "open", "closed:completed")).toBe("push");
  expect(mergeOpenClosed("closed", "closed:completed", "open")).toBe("pull");

  const common = ["bug", "feature"];
  expect(mergeLabels(["bug"], ["bug", "feature"], ["bug"], common)).toEqual(["bug", "feature"]);
  expect(mergeLabels(["bug"], ["bug"], ["bug", "feature"], common)).toEqual(["bug", "feature"]);
  expect(mergeLabels(["bug", "feature"], ["bug"], ["bug", "feature"], common)).toEqual(["bug"]);
  expect(mergeLabels(["bug"], ["bug", "SenOnly"], ["Bug", "GitHubOnly"], ["bug"])).toEqual(["bug"]);
  expect(mergeLabels(["bug"], [], ["feature"], common)).toEqual(["feature"]);

  const members = new Set(["octocat", "alice"]);
  expect(resolveGitHubAssignee(["OctoCat", "outsider"], "octocat", members)).toBe("octocat");
  expect(resolveGitHubAssignee(["outsider", "Alice"], "octocat", members)).toBe("alice");
  expect(resolveGitHubAssignee(["outsider"], null, members)).toBeNull();
  expect(nextGitHubAssignees(["outsider", "octocat"], "octocat", "alice")).toEqual(["outsider", "alice"]);
  expect(nextGitHubAssignees(["outsider", "octocat"], "octocat", null)).toEqual(["outsider"]);

  const states: WorkflowStateRef[] = [
    { id: "backlog", name: "バックログ", type: "backlog", position: 0 },
    { id: "todo", name: "未着手", type: "unstarted", position: 1 },
    { id: "doing", name: "進行中", type: "started", position: 2 },
    { id: "done", name: "完了", type: "completed", position: 3 },
    { id: "cancel", name: "キャンセル", type: "canceled", position: 4 },
    { id: "dup", name: "重複", type: "canceled", position: 5 },
  ];
  expect(stateIdForGitHub(states, "closed", "completed", "unstarted")).toBe("done");
  expect(stateIdForGitHub(states, "closed", "not_planned", "unstarted")).toBe("cancel");
  expect(stateIdForGitHub(states, "closed", "duplicate", "unstarted")).toBe("dup");
  expect(stateIdForGitHub(states, "open", "reopened", "completed")).toBe("todo");
  expect(stateIdForGitHub(states, "open", "reopened", "started")).toBeNull();
  expect(initialStateId(states, "open", null)).toBe("todo");
  expect(parseIssueRef("12", "acme/widgets")).toEqual({ fullName: "acme/widgets", number: 12 });
  expect(parseIssueRef("acme/widgets#34", "other/repo")).toEqual({ fullName: "acme/widgets", number: 34 });
  expect(parseIssueRef("https://github.com/acme/widgets/issues/7", "other/repo")).toEqual({ fullName: "acme/widgets", number: 7 });
  expect(parseIssueRef("not a ref", "acme/widgets")).toBeNull();

  expect(extractPullReferences({ branch: "taro/eng-12", title: "", body: "" }, ["ENG"]).issues).toEqual([{ key: "ENG", number: 12 }]);
  expect(extractPullReferences({ branch: "eng-12-fix-login", title: "", body: "" }, ["eng"]).issues).toEqual([{ key: "ENG", number: 12 }]);
  expect(extractPullReferences({ branch: "", title: "[ENG-12]", body: "" }, ["ENG"]).issues).toEqual([{ key: "ENG", number: 12 }]);
  expect(extractPullReferences({ branch: "", title: "", body: "Fixes ENG-12, closes #34" }, ["ENG"])).toEqual({
    issues: [{ key: "ENG", number: 12 }],
    github: [{ repo: null, number: 34 }],
  });
  expect(extractPullReferences({ branch: "", title: "Resolves owner/repo#34", body: "" }, ["ENG"]).github).toEqual([{ repo: "owner/repo", number: 34 }]);
  expect(extractPullReferences({ branch: "utf-8-docs", title: "UTF-8", body: "Fixes UTF-8" }, ["ENG"]).issues).toEqual([]);
  const coded = "見える ENG-12 と #1\n```\nENG-99\n#99\nowner/repo#99\n```\n`ENG-98` と `#98`";
  expect(extractPullReferences({ branch: "", title: "", body: coded }, ["ENG"])).toEqual({
    issues: [{ key: "ENG", number: 12 }],
    github: [{ repo: null, number: 1 }],
  });
  expect(extractPullReferences({ branch: "eng-12", title: "ENG-12", body: "eng-12 closes #7。もう一度 #7 と owner/repo#7" }, ["ENG"])).toEqual({
    issues: [{ key: "ENG", number: 12 }],
    github: [
      { repo: null, number: 7 },
      { repo: "owner/repo", number: 7 },
    ],
  });
  expect(extractPullReferences({ branch: "", title: "", body: "other/repo-#34" }, ["ENG"]).github).toEqual([{ repo: "other/repo-", number: 34 }]);
  expect(extractPullReferences({ branch: "", title: "", body: "see #34" }, ["ENG"]).github).toEqual([{ repo: null, number: 34 }]);
  expect(extractPullReferences({ branch: "", title: "", body: "other/repo-#34 と see #34" }, ["ENG"]).github).toEqual([
    { repo: "other/repo-", number: 34 },
    { repo: null, number: 34 },
  ]);

  const flow: WorkflowStateRef[] = [
    { id: "backlog", name: "バックログ", type: "backlog", position: 0 },
    { id: "todo", name: "未着手", type: "unstarted", position: 1 },
    { id: "doing", name: "進行中", type: "started", position: 2 },
    { id: "review", name: "レビュー中", type: "started", position: 3 },
    { id: "done", name: "完了", type: "completed", position: 4 },
    { id: "cancel", name: "キャンセル", type: "canceled", position: 5 },
  ];
  expect(advanceStateId(flow, "todo", "doing")).toBe("doing");
  expect(advanceStateId(flow, "doing", "review")).toBe("review");
  expect(advanceStateId(flow, "review", "doing")).toBeNull();
  expect(advanceStateId(flow, "review", "done")).toBe("done");
  expect(advanceStateId(flow, "done", "doing")).toBeNull();
  expect(advanceStateId(flow, "cancel", "done")).toBeNull();
  expect(advanceStateId(flow, "doing", "doing")).toBeNull();
  expect(advanceStateId(flow, "doing", null)).toBeNull();
  expect(pullLinkState({ state: "open", draft: true, merged: false })).toBe("draft");
  expect(pullLinkState({ state: "open", draft: false, merged: false })).toBe("open");
  expect(pullLinkState({ state: "closed", draft: false, merged: true })).toBe("merged");
  expect(pullLinkState({ state: "closed", draft: true, merged: false })).toBe("closed");
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

let teamId = "";
let meId = "";
let bugLabel = "";
let senOnlyLabel = "";
let syncedIssueId = "";
let syncedNumber = 0;

async function postMutation(page: Page, ws: string, mutation: Mutation | { type: "comment.create"; args: { id: string; issueId: string; body: string; githubAuthor?: string } }) {
  const res = await page.request.post(`/api/mutate?ws=${encodeURIComponent(ws)}`, {
    headers: { "x-sen-client": "1" },
    data: { ops: [{ clientId: randomUUID(), mutation }] },
  });
  const text = await res.text();
  expect(res.ok(), text).toBeTruthy();
  const body = JSON.parse(text) as { results: { ok: boolean; error?: string }[] };
  return body.results[0] ?? { ok: false, error: text };
}

async function createSenIssue(
  page: Page,
  ws: string,
  input: { title: string; description: string; assigneeId?: string; labelIds?: string[] },
): Promise<Issue> {
  const id = randomUUID();
  const result = await postMutation(page, ws, {
    type: "issue.create",
    args: { id, teamId, title: input.title, description: input.description, assigneeId: input.assigneeId, labelIds: input.labelIds },
  });
  expect(result.ok, result.error).toBe(true);
  return waitSenIssue(page, ws, id);
}

async function waitSenIssue(page: Page, ws: string, id: string): Promise<Issue> {
  let found: Issue | undefined;
  await expect.poll(async () => {
    found = (await bootstrap(page, ws)).issues.find((issue) => issue.id === id);
    return found?.number ?? 0;
  }, { timeout: 15_000 }).toBeGreaterThan(0);
  return found!;
}

async function senIssue(page: Page, ws: string, id: string): Promise<Issue> {
  const issue = (await bootstrap(page, ws)).issues.find((item) => item.id === id);
  if (!issue) throw new Error("課題が見つかりません");
  return issue;
}

async function waitLink(page: Page, ws: string, issueId: string): Promise<GitHubLink> {
  let found: GitHubLink | undefined;
  await expect.poll(async () => {
    found = (await bootstrap(page, ws)).githubLinks.find((link) => link.issueId === issueId);
    return found?.number ?? 0;
  }, { timeout: 15_000 }).toBeGreaterThan(0);
  return found!;
}

async function waitMockIssue(title: string): Promise<MockIssue> {
  let found: MockIssue | undefined;
  await expect.poll(() => {
    found = githubMock.issues.find((issue) => issue.fullName === "acme/widgets" && issue.title === title);
    return Boolean(found);
  }, { timeout: 15_000 }).toBe(true);
  return found!;
}

function mockIssue(number: number): MockIssue | undefined {
  return githubMock.issues.find((issue) => issue.fullName === "acme/widgets" && issue.number === number);
}

function patchCount(number: number): number {
  return githubMock.requests.filter((item) => item.method === "PATCH" && item.path === `/repos/acme/widgets/issues/${number}`).length;
}

function widgets() {
  const repo = githubMock.repos.get("acme/widgets");
  if (!repo) throw new Error("acme/widgets がありません");
  return repo;
}

function pushMockIssue(input: { title: string; body?: string | null; created_at: string; updated_at?: string; fullName?: string; pull_request?: unknown }): MockIssue {
  const fullName = input.fullName ?? "acme/widgets";
  const number = githubMock.issues.filter((issue) => issue.fullName.toLowerCase() === fullName.toLowerCase()).reduce((max, issue) => Math.max(max, issue.number), 0) + 1;
  const issue: MockIssue = {
    id: githubMock.nextIssueId++,
    number,
    fullName,
    title: input.title,
    body: input.body ?? "",
    state: "open",
    state_reason: null,
    labels: [],
    assignees: [],
    created_at: input.created_at,
    updated_at: input.updated_at ?? input.created_at,
    ...(input.pull_request ? { pull_request: input.pull_request } : {}),
  };
  githubMock.issues.push(issue);
  return issue;
}

function holdGitHubGet(path: string): { entered: Promise<void>; release: () => void } {
  let release!: () => void;
  let entered!: () => void;
  const enteredPromise = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = () => resolve();
  });
  githubMock.hold = { method: "GET", path, entered, gate };
  return { entered: enteredPromise, release };
}

function pushAgedSeries(count: number, startMs: number) {
  const fullName = "acme/widgets";
  let number = 0;
  for (const issue of githubMock.issues) if (issue.fullName === fullName && issue.number > number) number = issue.number;
  const body = "<!-- sen:comment:bulk -->";
  for (let i = 0; i < count; i++) {
    number += 1;
    const updatedAt = new Date(startMs + i * 3000).toISOString();
    githubMock.issues.push({
      id: githubMock.nextIssueId++,
      number,
      fullName,
      title: `古い ${number}`,
      body: "",
      state: "open",
      state_reason: null,
      labels: [],
      assignees: [],
      created_at: "2000-01-01T00:00:00.000Z",
      updated_at: updatedAt,
    });
    githubMock.comments.push({
      id: githubMock.nextCommentId++,
      fullName,
      number: 1,
      body,
      user: { login: "ghost" },
      created_at: updatedAt,
      updated_at: updatedAt,
    });
  }
}

function mockComment(number: number, body: string, login: string) {
  const comment = {
    id: githubMock.nextCommentId++,
    fullName: "acme/widgets",
    number,
    body,
    user: { login },
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  return comment;
}

async function pullOn(page: Page, ws: string, issueId: string, number: number) {
  const data = await bootstrap(page, ws);
  return data.githubPulls.find((pull) => pull.issueId === issueId && pull.number === number);
}

async function postPullWebhook(page: Page, pull: MockPull, action: string) {
  const repo = widgets();
  return postWebhook(page.request, {
    event: "pull_request",
    body: JSON.stringify({
      action,
      pull_request: {
        number: pull.number,
        title: pull.title,
        body: pull.body,
        html_url: `https://github.com/${pull.fullName}/pull/${pull.number}`,
        state: pull.state,
        draft: pull.draft,
        merged: pull.merged,
        user: pull.user,
        head: { ref: pull.headRef },
      },
      repository: { id: repo.id, full_name: repo.full_name },
      sender: { login: "webhook-sender" },
    }),
  });
}

function pushMockPull(input: {
  title: string;
  body?: string | null;
  headRef: string;
  draft?: boolean;
  state?: "open" | "closed";
  merged?: boolean;
  user?: { login: string } | null;
  fullName?: string;
}): MockPull {
  const fullName = input.fullName ?? "acme/widgets";
  const number = githubMock.pulls.filter((pull) => pull.fullName.toLowerCase() === fullName.toLowerCase()).reduce((max, pull) => Math.max(max, pull.number), 0) + 1;
  const pull: MockPull = {
    id: githubMock.nextPullId++,
    number,
    fullName,
    title: input.title,
    body: input.body ?? "",
    state: input.state ?? "open",
    draft: input.draft === true,
    merged: input.merged === true,
    user: input.user === undefined ? { login: "octocat" } : input.user,
    headRef: input.headRef,
    updated_at: new Date().toISOString(),
  };
  githubMock.pulls.push(pull);
  return pull;
}

async function expectBadgesReadable(page: Page) {
  for (const theme of ["light", "dark"] as const) {
    await page.evaluate((value) => {
      document.documentElement.dataset.theme = value;
    }, theme);
    const ratios = await page.evaluate(() => {
      const parse = (color: string) => {
        const match = color.match(/rgba?\(([^)]+)\)/);
        if (!match) return null;
        const parts = match[1].split(",").map((part) => Number(part.trim()));
        if (parts.length < 3 || parts.some((part) => !Number.isFinite(part))) return null;
        return [parts[0], parts[1], parts[2], parts.length > 3 ? parts[3] : 1] as [number, number, number, number];
      };
      const channel = (value: number) => {
        const s = value / 255;
        return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      };
      const rel = (rgb: [number, number, number]) => 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2]);
      const over = (fg: [number, number, number, number], bg: [number, number, number]) =>
        [fg[0] * fg[3] + bg[0] * (1 - fg[3]), fg[1] * fg[3] + bg[1] * (1 - fg[3]), fg[2] * fg[3] + bg[2] * (1 - fg[3])] as [number, number, number];
      const backdrop = (el: Element) => {
        const layers: [number, number, number, number][] = [];
        let node: Element | null = el;
        while (node) {
          const bg = parse(getComputedStyle(node).backgroundColor);
          if (bg && bg[3] > 0) layers.push(bg);
          if (bg && bg[3] >= 1) break;
          node = node.parentElement;
        }
        let acc: [number, number, number] = [255, 255, 255];
        for (let i = layers.length - 1; i >= 0; i--) acc = over(layers[i], acc);
        return acc;
      };
      return [...document.querySelectorAll("[data-testid='github-pull-state']")].map((el) => {
        const fg = parse(getComputedStyle(el).color);
        const bg = backdrop(el);
        if (!fg) return 0;
        const color = over(fg, bg);
        const lighter = Math.max(rel(color), rel(bg));
        const darker = Math.min(rel(color), rel(bg));
        return (lighter + 0.05) / (darker + 0.05);
      });
    });
    expect(ratios.length, theme).toBeGreaterThan(0);
    for (const ratio of ratios) expect(ratio, theme).toBeGreaterThanOrEqual(4.5);
  }
}

async function postIssueWebhook(page: Page, number: number, action: string, senderLogin?: string) {
  const repo = widgets();
  const body: Record<string, unknown> = { action, issue: { number }, repository: { id: repo.id, full_name: repo.full_name } };
  if (senderLogin) body.sender = { login: senderLogin };
  return postWebhook(page.request, {
    event: "issues",
    body: JSON.stringify(body),
  });
}

async function postCommentWebhook(page: Page, number: number, comment: { id: number; body: string; user: { login: string }; created_at: string }) {
  const repo = widgets();
  return postWebhook(page.request, {
    event: "issue_comment",
    body: JSON.stringify({
      action: "created",
      issue: { number },
      comment: {
        id: comment.id,
        body: comment.body,
        html_url: `https://github.com/acme/widgets/issues/${number}#issuecomment-${comment.id}`,
        created_at: comment.created_at,
        user: comment.user,
      },
      repository: { id: repo.id, full_name: repo.full_name },
      sender: comment.user,
    }),
  });
}

async function threadOf(page: Page, ws: string, issueId: string): Promise<{ comments: Comment[]; activities: Activity[] }> {
  const res = await page.request.get(`/api/issues/${issueId}/thread?ws=${encodeURIComponent(ws)}`);
  expect(res.ok()).toBeTruthy();
  return (await res.json()) as { comments: Comment[]; activities: Activity[] };
}

async function activityActions(page: Page, ws: string, issueId: string): Promise<string[]> {
  const thread = await threadOf(page, ws, issueId);
  return thread.activities.filter((item) => item.type === "github").map((item) => String(item.data.action ?? ""));
}

async function labelNames(page: Page, ws: string, ids: string[]): Promise<string[]> {
  const labels = (await bootstrap(page, ws)).labels;
  return ids.map((id) => labels.find((label) => label.id === id)?.name ?? "");
}

function stateId(data: BootstrapPayload, teamId: string, type: StateType, name: string): string {
  const state = data.states.find((item) => item.teamId === teamId && item.type === type && item.name === name);
  if (!state) throw new Error(`ステータス「${name}」が見つかりません`);
  return state.id;
}
