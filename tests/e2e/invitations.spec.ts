import { randomUUID } from "node:crypto";
import { expect, test, type APIRequestContext, type Browser, type Page } from "@playwright/test";
import type { InvitationCreateResponse, Mutation } from "../../shared/types";
import { devSignIn, dismissWelcome, inviteByEmail, invitePath, inviteToken, joinByInvite, seedDemo, signupViaUi, uniqueEmail } from "./helpers";

const CLIENT = { "x-sen-client": "1" };

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

function domainSection(page: Page) {
  return page.locator(".settings-section", { has: page.getByRole("heading", { name: "利用できるドメイン", exact: true }) });
}

function memberRow(page: Page, email: string) {
  return page.locator(".member-row:not([data-testid=invitation-row])", { hasText: email });
}

function invitationRow(page: Page, email: string) {
  return page.locator(`[data-testid="invitation-row"][data-email="${email}"]`);
}

async function pendingEmails(page: Page, ws: string): Promise<string[]> {
  const res = await page.request.get(`/api/invitations?ws=${encodeURIComponent(ws)}`, { headers: CLIENT });
  const text = await res.text();
  expect(res.ok(), text).toBeTruthy();
  const body = JSON.parse(text) as { invitations: { email: string }[] };
  return body.invitations.map((i) => i.email);
}

async function workspaceKeys(page: Page): Promise<string[]> {
  const res = await page.request.get("/api/me", { headers: CLIENT });
  expect(res.ok()).toBeTruthy();
  const me = (await res.json()) as { workspaces?: { urlKey: string }[] };
  return (me.workspaces ?? []).map((w) => w.urlKey);
}

async function postMcp(request: APIRequestContext, secret: string) {
  return request.post("/api/mcp", {
    headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
    data: INIT_BODY,
  });
}

async function issueToken(page: Page, ws: string): Promise<string> {
  const res = await page.request.post(`/api/tokens?ws=${encodeURIComponent(ws)}`, {
    headers: CLIENT,
    data: { client: "cursor", scope: "read", expiresInDays: 30 },
  });
  const text = await res.text();
  expect(res.ok(), text).toBeTruthy();
  return (JSON.parse(text) as { secret: string }).secret;
}

function waitForMutate(page: Page) {
  return page.waitForResponse((r) => r.url().includes("/api/mutate") && r.request().method() === "POST");
}

async function expectMutateOk(pending: ReturnType<typeof waitForMutate>) {
  const res = await pending;
  const text = await res.text();
  expect(res.ok(), text).toBeTruthy();
  const body = JSON.parse(text) as { results: { ok: boolean; error?: string }[] };
  expect(body.results.filter((r) => !r.ok).map((r) => r.error), text).toEqual([]);
}

async function addDomain(page: Page, domain: string) {
  await page.getByTestId("allowed-domains-input").fill(domain);
  await page.getByTestId("allowed-domains-add").click();
  const exact = new RegExp(`^${domain.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
  await expect(page.locator(".chip-text", { hasText: exact })).toBeVisible();
}

/** 許可外になるメンバーがいる保存。確認ダイアログを通して、サーバーが保存し終えるまで待つ */
async function restrictToExampleCom(page: Page, blockedEmail: string) {
  await addDomain(page, "example.com");
  await page.getByTestId("allowed-domains-save").click();
  const dialog = page.getByTestId("confirm-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("次の人はこのワークスペースを使えなくなります");
  await expect(dialog).toContainText(blockedEmail);
  const pending = waitForMutate(page);
  await page.getByTestId("confirm-ok").click();
  await expectMutateOk(pending);
  await expect(dialog).toBeHidden();
}

async function joinOutsideMember(page: Page, browser: Browser) {
  const { ws } = await signupViaUi(page, { name: "管理 花子" });
  const email = uniqueEmail("out", "other.example.com");
  const link = await inviteByEmail(page, ws, email);
  const guest = await joinByInvite(browser, link, { email, name: "部外 太郎" });
  try {
    await page.goto(`/${ws}/settings/members`);
    await expect(memberRow(page, email)).toBeVisible();
    return { ws, email, guest };
  } catch (e) {
    await guest.context.close();
    throw e;
  }
}

async function expectInvalidInvite(browser: Browser, link: string) {
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await page.goto(invitePath(link));
    await expect(page.getByRole("heading", { name: "この招待リンクは使えません" })).toBeVisible();
  } finally {
    await context.close();
  }
}

test("メールで招待すると、そのアドレスと権限で参加でき、招待中の一覧から消える", async ({ page, browser }) => {
  test.setTimeout(90_000);
  const { ws } = await signupViaUi(page, { name: "管理 花子" });
  const email = uniqueEmail("admin-invite");
  const link = await inviteByEmail(page, ws, email, "admin");
  const guest = await joinByInvite(browser, link, { email, name: "新任 管理者" });
  try {
    const boot = await guest.page.request.get(`/api/bootstrap?ws=${encodeURIComponent(ws)}`, { headers: CLIENT });
    expect(boot.ok()).toBeTruthy();
    const data = (await boot.json()) as { me: { email: string; role: string } };
    expect(data.me.email).toBe(email);
    expect(data.me.role).toBe("admin");

    await page.reload();
    await expect(invitationRow(page, email)).toHaveCount(0);
    await expect(memberRow(page, email).locator("select")).toHaveValue("admin");
  } finally {
    await guest.context.close();
  }
});

test("招待したアドレスと違うアカウントでは参加できない", async ({ page, browser }) => {
  const { ws } = await signupViaUi(page, { name: "管理 花子" });
  const invited = uniqueEmail("invited");
  const token = inviteToken(await inviteByEmail(page, ws, invited));
  const other = uniqueEmail("other");

  const ctx = await browser.newContext();
  const p2 = await ctx.newPage();
  try {
    await devSignIn(p2, { email: other, name: "別人 次郎" });
    await p2.goto(`/invite/${token}`);
    await expect(p2.getByTestId("invite-wrong-account")).toContainText(other);
    await expect(p2.getByTestId("invite-accept")).toHaveCount(0);

    const accept = await p2.request.post(`/api/invite/${token}/accept`, { headers: CLIENT, data: {} });
    expect(accept.status()).toBe(403);
    expect(((await accept.json()) as { error?: string }).error).toContain("あてです");
    expect(await workspaceKeys(p2)).toEqual([]);
  } finally {
    await ctx.close();
  }
});

test("招待リンクは参加後にもう一度開けない", async ({ page, browser }) => {
  test.setTimeout(90_000);
  const { ws } = await signupViaUi(page, { name: "管理 花子" });
  const email = uniqueEmail("once");
  const link = await inviteByEmail(page, ws, email);
  const guest = await joinByInvite(browser, link, { email, name: "一度 参加" });
  try {
    await guest.page.goto(invitePath(link));
    await expect(guest.page.getByRole("heading", { name: "この招待リンクは使えません" })).toBeVisible();
  } finally {
    await guest.context.close();
  }
});

test("取り消した招待のリンクは無効になる", async ({ page, browser }) => {
  const { ws } = await signupViaUi(page, { name: "管理 花子" });
  const email = uniqueEmail("revoke");
  const link = await inviteByEmail(page, ws, email);
  const row = invitationRow(page, email);
  await row.getByTestId("invitation-revoke").click();
  await expect(page.getByTestId("confirm-dialog")).toContainText(email);
  await page.getByTestId("confirm-ok").click();
  await expect(row).toHaveCount(0);
  expect(await pendingEmails(page, ws)).not.toContain(email);
  await expectInvalidInvite(browser, link);
});

test("再送すると古いリンクは無効になり、新しいリンクで参加できる", async ({ page, browser }) => {
  test.setTimeout(90_000);
  const { ws } = await signupViaUi(page, { name: "管理 花子" });
  const email = uniqueEmail("resend");
  const oldLink = await inviteByEmail(page, ws, email);
  await invitationRow(page, email).getByTestId("invitation-resend").click();
  await expect(page.getByTestId("confirm-dialog")).toContainText("今のリンクは使えなくなります");
  await page.getByTestId("confirm-ok").click();
  const dialog = page.getByTestId("invite-dialog");
  const result = dialog.locator(`[data-testid="invite-result"][data-email="${email}"]`);
  await expect(result.getByTestId("invite-result-link")).not.toHaveValue(oldLink);
  const newLink = await result.getByTestId("invite-result-link").inputValue();
  expect(inviteToken(newLink)).not.toBe(inviteToken(oldLink));

  await expectInvalidInvite(browser, oldLink);
  const guest = await joinByInvite(browser, newLink, { email, name: "再送 参加者" });
  try {
    await expect(guest.page).toHaveURL(new RegExp(`/${ws}/`));
    expect(await workspaceKeys(guest.page)).toContain(ws);
  } finally {
    await guest.context.close();
  }
});

test("管理者でないメンバーは招待できず、招待の API は 403 になる", async ({ page, browser }) => {
  test.setTimeout(90_000);
  const { ws } = await signupViaUi(page, { name: "管理 花子" });
  const email = uniqueEmail("member");
  const link = await inviteByEmail(page, ws, email, "member");
  const guest = await joinByInvite(browser, link, { email, name: "一般 メンバー" });
  try {
    await guest.page.goto(`/${ws}/settings/members`);
    await expect(guest.page.getByTestId("invite-open")).toHaveCount(0);
    await expect(guest.page.getByText("メンバーの招待は管理者が行います。")).toBeVisible();

    const target = uniqueEmail("nope");
    const post = await guest.page.request.post(`/api/invitations?ws=${encodeURIComponent(ws)}`, {
      headers: CLIENT,
      data: { emails: [target], role: "member" },
    });
    expect(post.status()).toBe(403);
    expect(((await post.json()) as { error?: string }).error).toBe("管理者のみ実行できます");

    const get = await guest.page.request.get(`/api/invitations?ws=${encodeURIComponent(ws)}`, { headers: CLIENT });
    expect(get.status()).toBe(403);
    expect(((await get.json()) as { error?: string }).error).toBe("管理者のみ実行できます");
  } finally {
    await guest.context.close();
  }
});

test("既にメンバーのアドレスは招待できない", async ({ page }) => {
  const { email, ws } = await signupViaUi(page, { name: "管理 花子" });
  await page.goto(`/${ws}/settings/members`);
  await page.getByTestId("invite-open").click();
  const dialog = page.getByTestId("invite-dialog");
  await dialog.getByTestId("invite-emails").fill(email);
  await dialog.getByTestId("invite-emails").press("Enter");
  await expect(dialog.locator(`[data-testid="invite-chip"][data-email="${email}"]`)).toHaveAttribute("data-status", "member");
  await expect(dialog.getByTestId("invite-chip-message")).toHaveText(`${email} は、すでにメンバーです。`);
  await expect(dialog.getByTestId("invite-submit")).toBeDisabled();
  await expect(page.getByTestId("invitation-row")).toHaveCount(0);

  const res = await page.request.post(`/api/invitations?ws=${encodeURIComponent(ws)}`, {
    headers: CLIENT,
    data: { emails: [email], role: "member" },
  });
  expect(res.status()).toBe(400);
  expect(((await res.json()) as { error?: string }).error).toContain(`${email}（既にメンバーです）`);
  expect(await pendingEmails(page, ws)).toEqual([]);
});

test("形式の正しくないアドレスは招待できない", async ({ page }) => {
  const { ws } = await signupViaUi(page, { name: "管理 花子" });
  await page.goto(`/${ws}/settings/members`);
  await page.getByTestId("invite-open").click();
  const dialog = page.getByTestId("invite-dialog");
  await dialog.getByTestId("invite-emails").fill("not-an-email");
  await dialog.getByTestId("invite-emails").press("Enter");
  await expect(dialog.locator('[data-testid="invite-chip"][data-email="not-an-email"]')).toHaveAttribute("data-status", "invalid");
  await expect(dialog.getByTestId("invite-chip-message")).toHaveText("not-an-email は、メールアドレスの形式が正しくありません。");
  await expect(dialog.getByTestId("invite-submit")).toBeDisabled();
  await expect(page.getByTestId("invitation-row")).toHaveCount(0);

  const res = await page.request.post(`/api/invitations?ws=${encodeURIComponent(ws)}`, {
    headers: CLIENT,
    data: { emails: ["not-an-email"], role: "member" },
  });
  expect(res.status()).toBe(400);
  expect(((await res.json()) as { error?: string }).error).toContain("not-an-email（形式が正しくありません）");
  expect(await pendingEmails(page, ws)).toEqual([]);
});

test("カンマ区切りのアドレスはチップになり、招待中のアドレスは分かる", async ({ page }) => {
  const { ws } = await signupViaUi(page, { name: "管理 花子" });
  const pending = uniqueEmail("chip-pending");
  await inviteByEmail(page, ws, pending);

  await page.getByTestId("invite-open").click();
  const dialog = page.getByTestId("invite-dialog");
  const input = dialog.getByTestId("invite-emails");
  const a = uniqueEmail("chip-a");
  const b = uniqueEmail("chip-b");
  await input.fill(`${a}, ${b}`);
  await input.press("Enter");
  await expect(dialog.getByTestId("invite-chip")).toHaveCount(2);
  await expect(dialog.getByTestId("invite-submit")).toHaveText("2 人を招待");

  await input.fill(pending);
  await input.press("Enter");
  const chip = dialog.locator(`[data-testid="invite-chip"][data-email="${pending}"]`);
  await expect(chip).toHaveAttribute("data-status", "pending");
  await expect(chip).toContainText("招待中");
  await expect(dialog.getByTestId("invite-chip-message")).toHaveText(`${pending} は招待中です。新しいリンクで招待し直します。`);
});

test("ワークスペースを持たない人は、作成画面から招待に参加できる", async ({ page, browser }) => {
  const { ws } = await signupViaUi(page, { name: "管理 花子", workspace: "招待先のチーム" });
  const email = uniqueEmail("nows");
  await inviteByEmail(page, ws, email);

  const ctx = await browser.newContext();
  const p2 = await ctx.newPage();
  try {
    await devSignIn(p2, { email, name: "未参加 花子" });
    await p2.goto("/");
    await expect(p2.getByRole("heading", { name: "招待が届いています" })).toBeVisible();
    await expect(p2.getByTestId("new-workspace-form")).toHaveCount(0);
    await p2.getByTestId("new-workspace-toggle").click();
    await expect(p2.getByTestId("new-workspace-form")).toBeVisible();
    const card = p2.getByTestId("pending-invitation");
    await expect(card).toContainText("招待先のチーム");
    await card.getByTestId("pending-invitation-accept").click();
    await expect(p2.getByTestId("app")).toBeVisible();
    await dismissWelcome(p2);
    await expect(p2).toHaveURL(new RegExp(`/${ws}/`));
    expect(await workspaceKeys(p2)).toContain(ws);
  } finally {
    await ctx.close();
  }
});

test("招待の結果に「メールを送りました」と出る", async ({ page }) => {
  const { ws } = await signupViaUi(page, { name: "管理 花子" });
  const email = uniqueEmail("mail");
  await page.goto(`/${ws}/settings/members`);
  await page.getByTestId("invite-open").click();
  const dialog = page.getByTestId("invite-dialog");
  await dialog.getByTestId("invite-emails").fill(email);
  await dialog.getByTestId("invite-submit").click();
  const result = dialog.locator(`[data-testid="invite-result"][data-email="${email}"]`);
  await expect(result).toContainText("メールを送りました");
});

test("招待メールは、招待した人ごとに 1 日 50 通まで（ワークスペースを分けても超えられない）", async ({ page, browser }) => {
  test.setTimeout(90_000);
  const { ws } = await signupViaUi(page, { name: "管理 花子" });

  const invite = async (workspace: string, emails: string[]) => {
    const res = await page.request.post(`/api/invitations?ws=${encodeURIComponent(workspace)}`, {
      headers: CLIENT,
      data: { emails, role: "member" },
    });
    const text = await res.text();
    expect(res.ok(), text).toBeTruthy();
    return JSON.parse(text) as InvitationCreateResponse;
  };

  let n = 0;
  for (const count of [20, 20, 10]) {
    const body = await invite(
      ws,
      Array.from({ length: count }, () => uniqueEmail(`cap-${n++}`)),
    );
    expect(body.results).toHaveLength(count);
    for (const result of body.results) expect(result.emailSent).toBe(true);
  }

  const created = await page.request.post("/api/workspaces", {
    headers: CLIENT,
    data: { name: "二つ目のワークスペース" },
  });
  const createdText = await created.text();
  expect(created.ok(), createdText).toBeTruthy();
  const wsB = (JSON.parse(createdText) as { workspaceKey: string }).workspaceKey;

  const over = await invite(wsB, [uniqueEmail("over")]);
  expect(over.results).toHaveLength(1);
  expect(over.results[0]?.link).toContain("/invite/");
  expect(over.results[0]?.emailSent).toBe(false);
  expect(over.results[0]?.emailError).toContain("上限（50通）");

  const ctx = await browser.newContext();
  const p2 = await ctx.newPage();
  try {
    const { ws: wsC } = await signupViaUi(p2, { name: "別の管理者" });
    const res = await p2.request.post(`/api/invitations?ws=${encodeURIComponent(wsC)}`, {
      headers: CLIENT,
      data: { emails: [uniqueEmail("other-admin")], role: "member" },
    });
    const text = await res.text();
    expect(res.ok(), text).toBeTruthy();
    const body = JSON.parse(text) as InvitationCreateResponse;
    expect(body.results[0]?.emailSent).toBe(true);
  } finally {
    await ctx.close();
  }
});

test("利用できるドメインを保存すると、確認に許可外の人が出て、一覧に印が付く", async ({ page, browser }) => {
  test.setTimeout(90_000);
  const { email, guest } = await joinOutsideMember(page, browser);
  try {
    await restrictToExampleCom(page, email);
    await expect(memberRow(page, email).getByTestId("member-domain-blocked")).toBeVisible();
    await expect(memberRow(page, email).getByTestId("member-domain-blocked")).toContainText("許可外のドメイン");
  } finally {
    await guest.context.close();
  }
});

test("許可外のメンバーは bootstrap が 403 で、ワークスペース一覧と MCP から外れる", async ({ page, browser }) => {
  test.setTimeout(90_000);
  const { ws, email, guest } = await joinOutsideMember(page, browser);
  try {
    const secret = await issueToken(guest.page, ws);
    await restrictToExampleCom(page, email);

    const boot = await guest.page.request.get(`/api/bootstrap?ws=${encodeURIComponent(ws)}`, { headers: CLIENT });
    expect(boot.status()).toBe(403);
    expect(((await boot.json()) as { error?: string }).error).toBe("このワークスペースは example.com のメールアドレスだけが利用できます");
    expect(await workspaceKeys(guest.page)).not.toContain(ws);

    const mcp = await postMcp(guest.page.request, secret);
    expect(mcp.status()).toBe(401);
    expect(mcp.headers()["www-authenticate"]).toBeTruthy();
  } finally {
    await guest.context.close();
  }
});

test("許可外のドメインは招待できず、保存前の招待は取り消される", async ({ page }) => {
  const { ws } = await signupViaUi(page, { name: "管理 花子" });
  const pending = uniqueEmail("pending", "other.example.com");
  await inviteByEmail(page, ws, pending);
  await addDomain(page, "example.com");
  const saved = waitForMutate(page);
  await page.getByTestId("allowed-domains-save").click();
  await expectMutateOk(saved);
  await expect(invitationRow(page, pending)).toHaveCount(0);
  expect(await pendingEmails(page, ws)).not.toContain(pending);

  const rejected = uniqueEmail("rejected", "other.example.com");
  await page.getByTestId("invite-open").click();
  const dialog = page.getByTestId("invite-dialog");
  await dialog.getByTestId("invite-emails").fill(rejected);
  await dialog.getByTestId("invite-emails").press("Enter");
  await expect(dialog.locator(`[data-testid="invite-chip"][data-email="${rejected}"]`)).toHaveAttribute("data-status", "blocked");
  await expect(dialog.getByTestId("invite-chip-message")).toHaveText(`${rejected} は、利用できるドメインのアドレスではありません。`);
  await expect(dialog.getByTestId("invite-submit")).toBeDisabled();
  await expect(invitationRow(page, rejected)).toHaveCount(0);

  const apiEmail = uniqueEmail("api", "other.example.com");
  const res = await page.request.post(`/api/invitations?ws=${encodeURIComponent(ws)}`, {
    headers: CLIENT,
    data: { emails: [apiEmail], role: "member" },
  });
  expect(res.status()).toBe(400);
  expect(((await res.json()) as { error?: string }).error).toContain(`${apiEmail}（利用できるドメインではありません）`);
  expect(await pendingEmails(page, ws)).not.toContain(apiEmail);
});

test("自分のドメインを含めないと、利用できるドメインは保存できない", async ({ page }) => {
  const { email, ws } = await signupViaUi(page, { name: "管理 花子" });
  const mine = email.split("@")[1];
  await page.goto(`/${ws}/settings/members`);
  await addDomain(page, "other.example.com");
  await page.getByTestId("allowed-domains-save").click();
  await expect(domainSection(page).locator(".form-error")).toHaveText(`あなたのメールアドレスのドメイン（${mine}）を含めてください`);

  await page.reload();
  await expect(page.getByText("制限していません")).toBeVisible();
  await expect(page.getByTestId("allowed-domain")).toHaveCount(0);

  const mutation: Mutation = { type: "workspace.setAllowedDomains", args: { domains: ["other.example.com"] } };
  const res = await page.request.post(`/api/mutate?ws=${encodeURIComponent(ws)}`, {
    headers: CLIENT,
    data: { ops: [{ clientId: randomUUID(), mutation }] },
  });
  expect(res.ok(), await res.text()).toBeTruthy();
  const body = (await res.json()) as { results: { ok: boolean; error?: string }[] };
  expect(body.results[0]?.ok).toBe(false);
  expect(body.results[0]?.error).toBe(`あなたのメールアドレスのドメイン（${mine}）を含めてください`);

  const boot = await page.request.get(`/api/bootstrap?ws=${encodeURIComponent(ws)}`, { headers: CLIENT });
  expect(boot.ok()).toBeTruthy();
  expect(((await boot.json()) as { workspace: { allowedDomains: string[] } }).workspace.allowedDomains).toEqual([]);
});

test("利用できるドメインを追加すると未保存の案内が出て、元に戻すと消える", async ({ page }) => {
  const { ws } = await signupViaUi(page, { name: "管理 花子" });
  await page.goto(`/${ws}/settings/members`);
  await addDomain(page, "example.com");
  const section = domainSection(page);
  const chip = section.getByTestId("allowed-domain");
  await expect(chip).toContainText("（未保存）");
  await expect(section.getByText("まだ保存していない変更があります")).toBeVisible();
  await section.getByTestId("allowed-domains-reset").click();
  await expect(chip).toHaveCount(0);
  await expect(section.getByText("まだ保存していない変更があります")).toHaveCount(0);
});

test("利用できるドメインの制限を外すと、その人はまた使える", async ({ page, browser }) => {
  test.setTimeout(90_000);
  const { ws, email, guest } = await joinOutsideMember(page, browser);
  try {
    const secret = await issueToken(guest.page, ws);
    await restrictToExampleCom(page, email);
    const blocked = await guest.page.request.get(`/api/bootstrap?ws=${encodeURIComponent(ws)}`, { headers: CLIENT });
    expect(blocked.status()).toBe(403);

    await page.getByRole("button", { name: "example.com を外す" }).click();
    const saved = waitForMutate(page);
    await page.getByTestId("allowed-domains-save").click();
    await expectMutateOk(saved);
    await expect(page.getByText("制限していません")).toBeVisible();
    await expect(memberRow(page, email).getByTestId("member-domain-blocked")).toHaveCount(0);

    const boot = await guest.page.request.get(`/api/bootstrap?ws=${encodeURIComponent(ws)}`, { headers: CLIENT });
    expect(boot.ok(), await boot.text()).toBeTruthy();
    expect(await workspaceKeys(guest.page)).toContain(ws);
    const mcp = await postMcp(guest.page.request, secret);
    expect(mcp.ok(), await mcp.text()).toBeTruthy();

    await guest.page.goto(`/${ws}/my-issues`);
    await expect(guest.page.getByTestId("app")).toBeVisible();
  } finally {
    await guest.context.close();
  }
});

test("メンバーを外すと、そのアドレス宛ての未承諾の招待も取り消される", async ({ page, browser }) => {
  test.setTimeout(90_000);
  const { ws } = await signupViaUi(page, { name: "管理 花子" });
  // 招待 API は既存メンバーを拒む。デモ投入はメンバー追加だけを行い、未承諾の招待は残す。
  const email = "hanako@example.com";
  const link = await inviteByEmail(page, ws, email);
  await seedDemo(page.request, ws);
  expect(await pendingEmails(page, ws)).toContain(email);

  await page.goto(`/${ws}/settings/members`);
  const row = memberRow(page, email);
  await expect(row).toBeVisible();
  await expect(invitationRow(page, email)).toBeVisible();
  await row.getByRole("button", { name: "メンバーを削除" }).click();
  await page.getByTestId("confirm-ok").click();
  await expect(row).toHaveCount(0);

  await page.reload();
  await expect(invitationRow(page, email)).toHaveCount(0);
  expect(await pendingEmails(page, ws)).not.toContain(email);
  await expectInvalidInvite(browser, link);
});
