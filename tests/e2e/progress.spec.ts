import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { addDays, isValidYmd, todayYmd } from "../../shared/dates";
import { summarizeProgress, type ProgressActivity, type ReportInput } from "../../shared/progress";
import type { BootstrapPayload, Mutation, ProgressStartedResponse, SheetSyncStatus, StateType } from "../../shared/types";
import { devSignIn, newUserPage, seedDemo, signupViaUi } from "./helpers";

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

test("進行中にしてからバックログに戻すと、startedAt は消えても着手日は今日を返す", async ({ page }) => {
  const { ws } = await signupViaUi(page, { workspace: "進捗の確認" });
  const bootRes = await page.request.get(`/api/bootstrap?ws=${encodeURIComponent(ws)}`);
  if (!bootRes.ok()) throw new Error(`bootstrap が失敗しました (${bootRes.status()}): ${await bootRes.text()}`);
  const data = (await bootRes.json()) as BootstrapPayload;
  const team = data.teams.find((item) => item.key === "ENG") ?? data.teams[0];
  if (!team) throw new Error("チームがありません");
  const project = data.projects[0];
  if (!project) throw new Error("プロジェクトがありません");

  const sheets = await page.request.get(`/api/sheets/status?ws=${encodeURIComponent(ws)}`);
  expect(sheets.ok()).toBeTruthy();
  expect(((await sheets.json()) as SheetSyncStatus).enabled).toBe(false);

  const id = randomUUID();
  await mutate(page, ws, [
    {
      type: "issue.create",
      args: {
        id,
        teamId: team.id,
        projectId: project.id,
        title: "着手してから戻した課題",
        stateId: stateId(data, team.id, "unstarted", "未着手"),
      },
    },
    { type: "issue.update", args: { id, patch: { stateId: stateId(data, team.id, "started", "進行中") } } },
    { type: "issue.update", args: { id, patch: { stateId: stateId(data, team.id, "backlog", "バックログ") } } },
  ]);

  const afterRes = await page.request.get(`/api/bootstrap?ws=${encodeURIComponent(ws)}`);
  if (!afterRes.ok()) throw new Error(`bootstrap が失敗しました (${afterRes.status()}): ${await afterRes.text()}`);
  const after = (await afterRes.json()) as BootstrapPayload;
  expect(after.issues.find((issue) => issue.id === id)?.startedAt).toBeNull();

  const res = await page.request.get(`/api/progress/started?ws=${encodeURIComponent(ws)}`);
  expect(res.ok()).toBeTruthy();
  const body = (await res.json()) as ProgressStartedResponse;
  expect(body.startedOn[id]).toBe(todayYmd(540));
});

test("ほかのワークスペースのメンバーでないユーザーは着手日を読めない", async ({ page, browser }) => {
  const { ws } = await signupViaUi(page, { workspace: "進捗の認可" });
  const { context, page: other } = await newUserPage(browser);
  await devSignIn(other, { name: "部外 者" });

  const denied = await other.request.get(`/api/progress/started?ws=${encodeURIComponent(ws)}`);
  expect(denied.status()).toBe(403);

  const missing = await other.request.get("/api/progress/started?ws=no-such-workspace");
  expect(missing.status()).toBe(404);

  await context.close();
});

function reportInputFromBootstrap(data: BootstrapPayload): ReportInput {
  const projects = data.projects.filter((project) => !project.archivedAt).sort((a, b) => a.sortOrder - b.sortOrder || a.createdAt - b.createdAt);
  const projectIds = new Set(projects.map((project) => project.id));
  const teamKey = new Map(data.teams.map((team) => [team.id, team.key]));
  const stateById = new Map(data.states.map((state) => [state.id, state]));
  const userName = new Map(data.users.map((user) => [user.id, user.name]));
  const labelName = new Map(data.labels.map((label) => [label.id, label.name]));
  return {
    workspaceName: data.workspace.name,
    urlKey: data.workspace.urlKey,
    origin: null,
    today: todayYmd(540),
    now: Date.now(),
    projects: projects.map((project) => ({ id: project.id, name: project.name })),
    issues: data.issues
      .filter((issue) => !issue.archivedAt && issue.projectId && projectIds.has(issue.projectId))
      .map((issue) => {
        const state = stateById.get(issue.stateId);
        const key = teamKey.get(issue.teamId);
        return {
          id: issue.id,
          identifier: key ? `${key}-${issue.number}` : String(issue.number),
          title: issue.title,
          descriptionText: "",
          projectId: issue.projectId!,
          stateName: state?.name ?? "",
          stateType: state?.type ?? "unstarted",
          priority: issue.priority ?? 0,
          assigneeName: issue.assigneeId ? (userName.get(issue.assigneeId) ?? null) : null,
          labelNames: issue.labelIds.flatMap((id) => {
            const name = labelName.get(id);
            return name ? [name] : [];
          }),
          dueDate: isValidYmd(issue.dueDate) ? issue.dueDate : null,
          startedOn: issue.startedAt != null ? todayYmd(540, issue.startedAt) : null,
          completedOn: issue.completedAt != null ? todayYmd(540, issue.completedAt) : null,
        };
      }),
  };
}

async function loadSummary(page: Page, ws: string) {
  const bootRes = await page.request.get(`/api/bootstrap?ws=${encodeURIComponent(ws)}`);
  if (!bootRes.ok()) throw new Error(`bootstrap が失敗しました (${bootRes.status()}): ${await bootRes.text()}`);
  const data = (await bootRes.json()) as BootstrapPayload;
  return { data, summary: summarizeProgress(reportInputFromBootstrap(data)) };
}

async function expectActivityRow(page: Page, activity: ProgressActivity) {
  const row = page.locator(`[data-testid=progress-activity-row][data-project-id="${activity.projectId}"]`);
  await expect(row).toBeVisible();
  await expect(row.getByTestId("progress-rate")).toContainText(activity.completionRate);
  await expect(row.getByTestId("progress-status")).toHaveText(activity.status);
  const due = row.getByTestId("progress-due");
  if (!activity.nextDueDate) {
    await expect(due).toHaveText(activity.nextDue);
    return;
  }
  await expect(due).toContainText(activity.nextDueDate.replaceAll("-", "/"));
  if (activity.nextDueUnset > 0) await expect(due).toContainText(`未設定 ${activity.nextDueUnset} 件`);
  else await expect(due).toHaveText(activity.nextDueDate.replaceAll("-", "/"));
}

test("サイドバーから進捗を開き、活動一覧が集計と一致する", async ({ page }) => {
  const { ws } = await signupViaUi(page, { workspace: "進捗の画面" });
  await seedDemo(page.request, ws);
  await page.goto(`/${ws}/my-issues`);
  await expect(page.getByTestId("app")).toBeVisible();
  await page.keyboard.press("g");
  await page.keyboard.press("r");
  await expect(page).toHaveURL(new RegExp(`/${ws}/progress$`));

  await page.goto(`/${ws}/my-issues`);
  await page.getByTestId("nav-progress").click();
  await expect(page.getByTestId("progress-page")).toBeVisible();
  await expect(page.getByTestId("progress-open-sheet")).toHaveCount(0);
  await expect(page.getByText("自動で最新の状態に更新")).toBeVisible();

  const { summary } = await loadSummary(page, ws);
  const mobile = summary.activities.find((activity) => activity.name === "モバイルアプリ v2.0");
  expect(mobile?.completionRate).toBe("28%（2/7）");
  expect(mobile?.status).toBe("保留あり");
  await expect(page.getByTestId("progress-activity-row")).toHaveCount(summary.activities.length);
  for (const activity of summary.activities) await expectActivityRow(page, activity);
});

test("課題を完了にすると、リロードせずに完了率が更新される", async ({ page }) => {
  const { ws } = await signupViaUi(page);
  await seedDemo(page.request, ws);
  await page.goto(`/${ws}/progress`);
  const mobile = page.locator("[data-testid=progress-activity-row]", { hasText: "モバイルアプリ v2.0" });
  await expect(mobile.getByTestId("progress-rate")).toContainText("28%（2/7）");

  await page.getByTestId("progress-tab-wbs").click();
  await page.locator("[data-testid=wbs-row][data-identifier='ENG-1']").click();
  await expect(page.getByTestId("issue-detail")).toBeVisible();
  await page.getByTestId("prop-status").click();
  await expect(page.getByTestId("picker-status")).toBeVisible();
  await page.keyboard.type("完了");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("prop-status")).toContainText("完了");

  await page.getByTestId("nav-progress").click();
  await expect(mobile.getByTestId("progress-rate")).toContainText("42%（3/7）");
});

test("活動状況で絞り込むと行が減る", async ({ page }) => {
  const { ws } = await signupViaUi(page);
  await seedDemo(page.request, ws);
  await page.goto(`/${ws}/progress`);
  const { summary } = await loadSummary(page, ws);
  const counts = new Map<string, number>();
  for (const activity of summary.activities) counts.set(activity.status, (counts.get(activity.status) ?? 0) + 1);
  const status = (["期限超過", "保留あり", "進行中", "未着手", "完了", "タスク未登録"] as const).find((item) => (counts.get(item) ?? 0) < summary.activities.length);
  expect(status).toBeTruthy();
  const expected = counts.get(status!) ?? 0;
  await page.getByTestId(`progress-filter-${status}`).click();
  await expect(page.getByTestId(`progress-filter-${status}`)).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("progress-activity-row")).toHaveCount(expected);
  if (expected === 0) await expect(page.getByText("この状況の活動はありません")).toBeVisible();
  else {
    for (const row of await page.getByTestId("progress-activity-row").all()) {
      await expect(row.getByTestId("progress-status")).toHaveText(status!);
    }
  }
});

test("WBS は説明列がなく、絞り込みと開閉と課題を開くことができる", async ({ page }) => {
  const { ws } = await signupViaUi(page);
  await seedDemo(page.request, ws);
  const { summary } = await loadSummary(page, ws);
  const mobile = summary.activities.find((activity) => activity.name === "モバイルアプリ v2.0");
  expect(mobile).toBeTruthy();
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`/${ws}/progress/wbs`);
  const title = page.locator("[data-testid=wbs-row][data-identifier='ENG-1'] .wbs-title");
  await expect(title).toHaveText("iOS でプッシュ通知が届かないことがある");
  const clipped = await title.evaluate((el) => el.scrollWidth - el.clientWidth);
  expect(clipped).toBeLessThanOrEqual(1);
  const aligned = await page.evaluate(() => {
    const head = [...document.querySelectorAll(".wbs-head > span")].map((el) => Math.round(el.getBoundingClientRect().left));
    const row = document.querySelector("[data-testid=wbs-row]");
    const cells = [...(row?.children ?? [])].map((el) => Math.round(el.getBoundingClientRect().left));
    return head.map((left, index) => Math.abs(left - (cells[index] ?? left)));
  });
  expect(aligned).toHaveLength(8);
  for (const delta of aligned) expect(delta).toBeLessThanOrEqual(1);
  await expect(page.getByTestId("wbs-group")).toHaveCount(summary.activities.length);
  await expect(page.getByTestId("wbs-row").first()).toBeVisible();
  const head = page.locator(".wbs-head");
  await expect(head).toContainText("工程");
  await expect(head).toContainText("作業");
  await expect(head).toContainText("完了予定");
  await expect(head).not.toContainText("説明");

  const before = await page.getByTestId("wbs-row").count();
  await page.getByTestId("wbs-toggle-done").click();
  await expect(page.locator("[data-testid=wbs-row][data-identifier='ENG-24']")).toHaveCount(0);
  await expect(page.locator("[data-testid=wbs-row][data-identifier='ENG-28']")).toHaveCount(0);
  await expect(page.locator("[data-testid=wbs-row][data-identifier='ENG-1']")).toBeVisible();
  expect(await page.getByTestId("wbs-row").count()).toBeLessThan(before);

  await page.getByTestId("wbs-filter-assignee").click();
  await page.getByRole("button", { name: "自分", exact: true }).click();
  await expect(page.locator("[data-testid=wbs-row][data-identifier='ENG-1']")).toBeVisible();
  await expect(page.locator("[data-testid=wbs-row][data-identifier='ENG-32']")).toHaveCount(0);

  await page.getByTestId("wbs-filter-assignee").click();
  await page.getByRole("button", { name: "すべて", exact: true }).click();
  const group = page.locator(`[data-testid=wbs-group][data-project-id="${mobile!.projectId}"]`);
  await expect(group.getByTestId("wbs-row").first()).toBeVisible();
  await group.getByTestId("wbs-group-toggle").click();
  await expect(group.getByTestId("wbs-group-toggle")).toHaveAttribute("aria-expanded", "false");
  await expect(group.getByTestId("wbs-row")).toHaveCount(0);
  await page.reload();
  await expect(group.getByTestId("wbs-row")).toHaveCount(0);
  await group.getByTestId("wbs-group-toggle").click();
  await group.locator("[data-testid=wbs-row][data-identifier='ENG-1']").click();
  await expect(page.getByTestId("issue-detail")).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/issue/ENG-1$`));
});

test("期限が昨日の課題は活動一覧で期限超過になり、WBS の完了予定が危険色になる", async ({ page }) => {
  const { ws } = await signupViaUi(page);
  await seedDemo(page.request, ws);
  const { data } = await loadSummary(page, ws);
  const team = data.teams.find((item) => item.key === "ENG") ?? data.teams[0];
  const project = data.projects.find((item) => item.name === "モバイルアプリ v2.0" && !item.archivedAt);
  if (!team || !project) throw new Error("デモのチームかプロジェクトがありません");
  await page.goto(`/${ws}/progress`);
  await mutate(page, ws, [
    {
      type: "issue.create",
      args: {
        id: randomUUID(),
        teamId: team.id,
        projectId: project.id,
        title: "昨日が期限の作業",
        stateId: stateId(data, team.id, "unstarted", "未着手"),
        dueDate: addDays(todayYmd(540), -1),
      },
    },
  ]);
  await page.reload();
  const activity = page.locator(`[data-testid=progress-activity-row][data-project-id="${project.id}"]`);
  await expect(activity.getByTestId("progress-status")).toHaveText("期限超過");

  await page.getByTestId("progress-tab-wbs").click();
  const row = page.locator("[data-testid=wbs-row]", { hasText: "昨日が期限の作業" });
  const due = row.locator(".wbs-due");
  await expect(due).toHaveAttribute("data-overdue", "true");
  const danger = await due.evaluate((el) => {
    const probe = document.createElement("span");
    probe.style.color = "var(--danger)";
    document.body.appendChild(probe);
    const expected = getComputedStyle(probe).color;
    probe.remove();
    return getComputedStyle(el).color === expected;
  });
  expect(danger).toBe(true);
});

test("期限が昨日のバックログの課題は、タイムラインで期限超過の色にならない", async ({ page }) => {
  const { ws } = await signupViaUi(page);
  await seedDemo(page.request, ws);
  const { data } = await loadSummary(page, ws);
  const team = data.teams.find((item) => item.key === "ENG") ?? data.teams[0];
  const project = data.projects.find((item) => item.name === "モバイルアプリ v2.0" && !item.archivedAt);
  if (!team || !project) throw new Error("デモのチームかプロジェクトがありません");
  const id = randomUUID();
  await mutate(page, ws, [
    {
      type: "issue.create",
      args: {
        id,
        teamId: team.id,
        projectId: project.id,
        title: "昨日が期限の保留",
        stateId: stateId(data, team.id, "unstarted", "未着手"),
        dueDate: addDays(todayYmd(540), -1),
      },
    },
    { type: "issue.update", args: { id, patch: { stateId: stateId(data, team.id, "started", "進行中") } } },
    { type: "issue.update", args: { id, patch: { stateId: stateId(data, team.id, "backlog", "バックログ") } } },
  ]);
  await page.goto(`/${ws}/progress/timeline`);
  const row = page.locator("[data-testid=timeline-row]", { hasText: "昨日が期限の保留" });
  const bar = row.getByTestId("timeline-bar");
  await bar.evaluate((el) => el.scrollIntoView({ inline: "center", block: "nearest" }));
  await expect(bar).toBeVisible();
  await expect(bar).not.toHaveClass(/is-overdue/);
  // 完了予定が着手より前なので ◆ は出る。保留は期限超過ではない。
  const mark = row.getByTestId("timeline-milestone");
  await expect(mark).toBeVisible();
  await expect(mark).not.toHaveClass(/is-overdue/);
});

test("工程が複数の作業は、選んだ工程を含むものだけが出て、組み合わせは候補に出ない", async ({ page }) => {
  const { ws } = await signupViaUi(page, { workspace: "工程の絞り込み" });
  const bootRes = await page.request.get(`/api/bootstrap?ws=${encodeURIComponent(ws)}`);
  if (!bootRes.ok()) throw new Error(`bootstrap が失敗しました (${bootRes.status()}): ${await bootRes.text()}`);
  const data = (await bootRes.json()) as BootstrapPayload;
  const team = data.teams.find((item) => item.key === "ENG") ?? data.teams[0];
  if (!team) throw new Error("チームがありません");
  const projectId = randomUUID();
  const designId = randomUUID();
  const implId = randomUUID();
  await mutate(page, ws, [
    { type: "label.create", args: { id: designId, name: "工程:設計", color: "#6470e8" } },
    { type: "label.create", args: { id: implId, name: "工程:実装", color: "#3fb27f" } },
    { type: "project.create", args: { id: projectId, name: "工程の絞り込み", teamIds: [team.id] } },
    {
      type: "issue.create",
      args: {
        id: randomUUID(),
        teamId: team.id,
        projectId,
        title: "設計と実装",
        stateId: stateId(data, team.id, "unstarted", "未着手"),
        labelIds: [designId, implId],
      },
    },
    {
      type: "issue.create",
      args: {
        id: randomUUID(),
        teamId: team.id,
        projectId,
        title: "設計だけ",
        stateId: stateId(data, team.id, "unstarted", "未着手"),
        labelIds: [designId],
      },
    },
  ]);
  await page.goto(`/${ws}/progress/wbs`);
  await page.getByTestId("wbs-filter-process").click();
  const menu = page.locator(".menu");
  await expect(menu.getByRole("button", { name: "設計", exact: true })).toBeVisible();
  await expect(menu.getByRole("button", { name: "実装", exact: true })).toBeVisible();
  await expect(menu.getByRole("button", { name: "設計／実装", exact: true })).toHaveCount(0);
  await expect(menu.getByRole("button", { name: "実装／設計", exact: true })).toHaveCount(0);
  await menu.getByRole("button", { name: "設計", exact: true }).click();
  await expect(page.locator("[data-testid=wbs-row]", { hasText: "設計と実装" })).toBeVisible();
  await expect(page.locator("[data-testid=wbs-row]", { hasText: "設計だけ" })).toBeVisible();
  await page.getByTestId("wbs-filter-process").click();
  await page.locator(".menu").getByRole("button", { name: "実装", exact: true }).click();
  await expect(page.locator("[data-testid=wbs-row]", { hasText: "設計と実装" })).toBeVisible();
  await expect(page.locator("[data-testid=wbs-row]", { hasText: "設計だけ" })).toHaveCount(0);
});

test("工程名が all と none でも、すべてと工程なしとは別の課題だけが出る", async ({ page }) => {
  const { ws } = await signupViaUi(page, { workspace: "工程名の衝突" });
  const bootRes = await page.request.get(`/api/bootstrap?ws=${encodeURIComponent(ws)}`);
  if (!bootRes.ok()) throw new Error(`bootstrap が失敗しました (${bootRes.status()}): ${await bootRes.text()}`);
  const data = (await bootRes.json()) as BootstrapPayload;
  const team = data.teams.find((item) => item.key === "ENG") ?? data.teams[0];
  if (!team) throw new Error("チームがありません");
  const projectId = randomUUID();
  const allId = randomUUID();
  const noneId = randomUUID();
  await mutate(page, ws, [
    { type: "label.create", args: { id: allId, name: "工程:all", color: "#6470e8" } },
    { type: "label.create", args: { id: noneId, name: "工程:none", color: "#3fb27f" } },
    { type: "project.create", args: { id: projectId, name: "工程名の衝突", teamIds: [team.id] } },
    {
      type: "issue.create",
      args: {
        id: randomUUID(),
        teamId: team.id,
        projectId,
        title: "工程が all の作業",
        stateId: stateId(data, team.id, "unstarted", "未着手"),
        labelIds: [allId],
      },
    },
    {
      type: "issue.create",
      args: {
        id: randomUUID(),
        teamId: team.id,
        projectId,
        title: "工程が none の作業",
        stateId: stateId(data, team.id, "unstarted", "未着手"),
        labelIds: [noneId],
      },
    },
    {
      type: "issue.create",
      args: {
        id: randomUUID(),
        teamId: team.id,
        projectId,
        title: "工程のない作業",
        stateId: stateId(data, team.id, "unstarted", "未着手"),
      },
    },
  ]);
  await page.goto(`/${ws}/progress/wbs`);

  await page.getByTestId("wbs-filter-process").click();
  await page.locator(".menu").getByRole("button", { name: "all", exact: true }).click();
  await expect(page.getByTestId("wbs-filter-process")).toContainText("工程：all");
  await expect(page.getByTestId("wbs-row")).toHaveCount(1);
  await expect(page.locator("[data-testid=wbs-row]", { hasText: "工程が all の作業" })).toBeVisible();

  await page.getByTestId("wbs-filter-process").click();
  await page.locator(".menu").getByRole("button", { name: "none", exact: true }).click();
  await expect(page.getByTestId("wbs-filter-process")).toContainText("工程：none");
  await expect(page.getByTestId("wbs-row")).toHaveCount(1);
  await expect(page.locator("[data-testid=wbs-row]", { hasText: "工程が none の作業" })).toBeVisible();

  await page.getByTestId("wbs-filter-process").click();
  await page.locator(".menu").getByRole("button", { name: "工程なし", exact: true }).click();
  await expect(page.getByTestId("wbs-filter-process")).toContainText("工程：工程なし");
  await expect(page.locator("[data-testid=wbs-row]", { hasText: "工程のない作業" })).toBeVisible();
  await expect(page.locator("[data-testid=wbs-row]", { hasText: "工程が none の作業" })).toHaveCount(0);
  await expect(page.locator("[data-testid=wbs-row]", { hasText: "工程が all の作業" })).toHaveCount(0);
});

test("工程名が「すべて」と「工程なし」でも、予約項目と見分けられる", async ({ page }) => {
  const { ws } = await signupViaUi(page, { workspace: "工程名の表示" });
  const bootRes = await page.request.get(`/api/bootstrap?ws=${encodeURIComponent(ws)}`);
  if (!bootRes.ok()) throw new Error(`bootstrap が失敗しました (${bootRes.status()}): ${await bootRes.text()}`);
  const data = (await bootRes.json()) as BootstrapPayload;
  const team = data.teams.find((item) => item.key === "ENG") ?? data.teams[0];
  if (!team) throw new Error("チームがありません");
  const projectId = randomUUID();
  const allId = randomUUID();
  const noneId = randomUUID();
  await mutate(page, ws, [
    { type: "label.create", args: { id: allId, name: "工程:すべて", color: "#6470e8" } },
    { type: "label.create", args: { id: noneId, name: "工程:工程なし", color: "#3fb27f" } },
    { type: "project.create", args: { id: projectId, name: "工程名の表示", teamIds: [team.id] } },
    {
      type: "issue.create",
      args: {
        id: randomUUID(),
        teamId: team.id,
        projectId,
        title: "工程がすべての作業",
        stateId: stateId(data, team.id, "unstarted", "未着手"),
        labelIds: [allId],
      },
    },
    {
      type: "issue.create",
      args: {
        id: randomUUID(),
        teamId: team.id,
        projectId,
        title: "工程が工程なしの作業",
        stateId: stateId(data, team.id, "unstarted", "未着手"),
        labelIds: [noneId],
      },
    },
    {
      type: "issue.create",
      args: {
        id: randomUUID(),
        teamId: team.id,
        projectId,
        title: "工程のない作業",
        stateId: stateId(data, team.id, "unstarted", "未着手"),
      },
    },
  ]);
  await page.goto(`/${ws}/progress/wbs`);
  await page.getByTestId("wbs-filter-process").click();
  const menu = page.locator(".menu");
  await expect(menu.getByRole("button", { name: "工程なし", exact: true })).toHaveCount(1);
  await expect(menu.getByRole("button", { name: "「工程なし」", exact: true })).toHaveCount(1);
  await expect(menu.getByRole("button", { name: "すべて", exact: true })).toHaveCount(1);
  await expect(menu.getByRole("button", { name: "「すべて」", exact: true })).toHaveCount(1);

  const order = await menu.locator(".menu-item, .menu-divider").evaluateAll((nodes) =>
    nodes.map((node) => (node.classList.contains("menu-divider") ? "divider" : (node.querySelector(".menu-item-label")?.textContent ?? ""))),
  );
  const dividerAt = order.indexOf("divider");
  expect(dividerAt).toBeGreaterThanOrEqual(0);
  expect(order.indexOf("すべて")).toBeLessThan(dividerAt);
  expect(order.indexOf("工程なし")).toBeLessThan(dividerAt);
  expect(order.indexOf("「すべて」")).toBeGreaterThan(dividerAt);
  expect(order.indexOf("「工程なし」")).toBeGreaterThan(dividerAt);

  await menu.getByRole("button", { name: "「工程なし」", exact: true }).click();
  await expect(page.getByTestId("wbs-filter-process")).toContainText("工程：「工程なし」");
  await expect(page.getByTestId("wbs-row")).toHaveCount(1);
  await expect(page.locator("[data-testid=wbs-row]", { hasText: "工程が工程なしの作業" })).toBeVisible();
  await expect(page.locator("[data-testid=wbs-row]", { hasText: "工程がすべての作業" })).toHaveCount(0);
  await expect(page.locator("[data-testid=wbs-row]", { hasText: "工程のない作業" })).toHaveCount(0);

  await page.getByTestId("wbs-filter-process").click();
  await page.locator(".menu").getByRole("button", { name: "工程なし", exact: true }).click();
  await expect(page.getByTestId("wbs-filter-process")).toContainText("工程：工程なし");
  await expect(page.locator("[data-testid=wbs-row]", { hasText: "工程のない作業" })).toBeVisible();
  await expect(page.locator("[data-testid=wbs-row]", { hasText: "工程が工程なしの作業" })).toHaveCount(0);
});

test("日本時間の 0 時を過ぎると、開いた日が期限の未完了の課題が期限超過になる", async ({ page }) => {
  const openedOn = "2026-11-05";
  const { ws } = await signupViaUi(page, { workspace: "日付をまたぐ進捗" });
  const bootRes = await page.request.get(`/api/bootstrap?ws=${encodeURIComponent(ws)}`);
  if (!bootRes.ok()) throw new Error(`bootstrap が失敗しました (${bootRes.status()}): ${await bootRes.text()}`);
  const data = (await bootRes.json()) as BootstrapPayload;
  const team = data.teams.find((item) => item.key === "ENG") ?? data.teams[0];
  if (!team) throw new Error("チームがありません");
  const projectId = randomUUID();
  await mutate(page, ws, [
    { type: "project.create", args: { id: projectId, name: "日付をまたぐ", teamIds: [team.id] } },
    {
      type: "issue.create",
      args: {
        id: randomUUID(),
        teamId: team.id,
        projectId,
        title: "その日が期限の作業",
        stateId: stateId(data, team.id, "unstarted", "未着手"),
        dueDate: openedOn,
      },
    },
  ]);
  // 23:59 JST。時計はコンテキスト全体に入るので、データを作ったあとに入れる。
  await page.clock.install({ time: new Date("2026-11-05T14:59:00.000Z") });
  await page.goto(`/${ws}/progress`);
  const activity = page.locator(`[data-testid=progress-activity-row][data-project-id="${projectId}"]`);
  await expect(activity.getByTestId("progress-status")).toHaveText("未着手");
  await expect(page.locator(".progress-stat-hint", { hasText: "今日の日付" })).toHaveText("今日の日付 2026/11/05");
  // setSystemTime は Date だけを進め、0 時に仕掛けた setTimeout は発火しない。
  // fastForward でそこまで進めると、同期の setInterval（15 秒ごとの差分取得と WebSocket の ping）も
  // まとめて動いて接続と競合する。休止したブラウザ向けに、表示が戻ったときも日付を確かめるので、ここではそれを使う。
  await page.clock.setSystemTime(new Date("2026-11-05T15:00:30.000Z"));
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(activity.getByTestId("progress-status")).toHaveText("期限超過");
  await expect(page.locator(".progress-stat-hint", { hasText: "今日の日付" })).toHaveText("今日の日付 2026/11/06");
});

test("1280×860 では WBS の優先度が横スクロールなしで見える", async ({ page }) => {
  const { ws } = await signupViaUi(page);
  await seedDemo(page.request, ws);
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto(`/${ws}/progress/wbs`);
  const priority = page.locator(".wbs-head").getByText("優先度", { exact: true });
  await expect(priority).toBeVisible();
  const placed = await priority.evaluate((el) => {
    const scroller = el.closest(".progress-scroll");
    if (!(scroller instanceof HTMLElement)) return { ok: false };
    const box = el.getBoundingClientRect();
    const view = scroller.getBoundingClientRect();
    const visibleRight = view.left + scroller.clientWidth;
    return {
      ok: box.left >= view.left - 1 && box.right <= visibleRight + 1 && scroller.scrollWidth <= scroller.clientWidth + 1,
      right: Math.round(box.right),
      visibleRight: Math.round(visibleRight),
      scroll: scroller.scrollWidth,
      client: scroller.clientWidth,
    };
  });
  expect(placed.ok, JSON.stringify(placed)).toBe(true);
});

test("スマホ幅でも進捗ページが横にはみ出さない", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { ws } = await signupViaUi(page);
  await seedDemo(page.request, ws);
  await page.goto(`/${ws}/progress`);
  await expect(page.getByTestId("progress-page")).toBeVisible();
  await expectNoHorizontalOverflow(page);
  const row = page.getByTestId("progress-activity-row").first();
  await expect(row.getByTestId("progress-rate")).toBeVisible();
  await expect(row.getByTestId("progress-status")).toBeVisible();
  await expectBoxInside(page, row.getByTestId("progress-rate"));
  await expectBoxInside(page, row.getByTestId("progress-status"));
  const overview = await page.locator(".progress-scroll").evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth }));
  expect(overview.scroll).toBeLessThanOrEqual(overview.client + 1);
  expect(overview.client).toBeLessThanOrEqual(390);

  await page.getByTestId("progress-tab-wbs").click();
  await expect(page.getByTestId("wbs-row").first()).toBeVisible();
  await expectNoHorizontalOverflow(page);
  const wbs = await page.locator(".progress-scroll").evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth }));
  expect(wbs.scroll).toBeGreaterThan(wbs.client);
  expect(wbs.client).toBeLessThanOrEqual(390);

  await page.getByTestId("progress-tab-timeline").click();
  await expect(page.getByTestId("timeline-today")).toBeVisible();
  await expectNoHorizontalOverflow(page);
});

test("タイムラインに棒とマイルストーンと今日の線が出る", async ({ page }) => {
  const { ws } = await signupViaUi(page);
  await seedDemo(page.request, ws);
  const { summary } = await loadSummary(page, ws);
  const barTask = summary.tasks.find((task) => task.startedOn && task.dueDate && task.stateType !== "completed");
  const milestoneTask = summary.tasks.find((task) => !task.startedOn && task.dueDate);
  expect(barTask?.identifier).toBeTruthy();
  expect(milestoneTask?.identifier).toBeTruthy();

  await page.goto(`/${ws}/progress/timeline`);
  await expect(page.getByTestId("progress-tab-timeline")).toHaveClass(/active/);
  const bar = page.locator(`[data-testid=timeline-row][data-identifier="${barTask!.identifier}"]`).getByTestId("timeline-bar");
  await expect(bar).toBeVisible();
  await expect(bar).toHaveAttribute("title", new RegExp(`${barTask!.identifier} .+ / 着手 \\d{4}/\\d{2}/\\d{2} → 完了予定 \\d{4}/\\d{2}/\\d{2}`));
  const milestone = page.locator(`[data-testid=timeline-row][data-identifier="${milestoneTask!.identifier}"]`).getByTestId("timeline-milestone");
  await expect(milestone).toBeVisible();
  await expect(milestone).toContainText("完了予定");
  await expect(page.getByTestId("timeline-today")).toBeVisible();
});

test("タイムラインの縮尺を週にすると棒が広がり、リロード後も週のまま", async ({ page }) => {
  const { ws } = await signupViaUi(page);
  await seedDemo(page.request, ws);
  await page.goto(`/${ws}/progress/timeline`);
  await expect(page.getByTestId("timeline-zoom-month")).toHaveAttribute("aria-pressed", "true");
  const bar = page.locator("[data-testid=timeline-row][data-identifier='ENG-1']").getByTestId("timeline-bar");
  await expect(bar).toBeVisible();
  const monthWidth = await bar.evaluate((el) => el.getBoundingClientRect().width);
  await page.getByTestId("timeline-zoom-week").click();
  await expect(page.getByTestId("timeline-zoom-week")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("timeline-zoom-month")).toHaveAttribute("aria-pressed", "false");
  const weekWidth = await bar.evaluate((el) => el.getBoundingClientRect().width);
  expect(weekWidth).toBeGreaterThan(monthWidth + 8);
  await page.reload();
  await expect(page.getByTestId("timeline-zoom-week")).toHaveAttribute("aria-pressed", "true");
  const again = await bar.evaluate((el) => el.getBoundingClientRect().width);
  expect(again).toBeGreaterThan(monthWidth + 8);
});

test("バックログに戻しても着手日の履歴でタイムラインの棒が残る", async ({ page }) => {
  const { ws } = await signupViaUi(page);
  await seedDemo(page.request, ws);
  const { data } = await loadSummary(page, ws);
  const team = data.teams.find((item) => item.key === "ENG") ?? data.teams[0];
  const issue = data.issues.find((item) => item.teamId === team?.id && item.number === 1);
  if (!team || !issue) throw new Error("ENG-1 がありません");
  await page.goto(`/${ws}/progress/timeline`);
  const bar = page.locator("[data-testid=timeline-row][data-identifier='ENG-1']").getByTestId("timeline-bar");
  await expect(bar).toBeVisible();

  await mutate(page, ws, [
    { type: "issue.update", args: { id: issue.id, patch: { stateId: stateId(data, team.id, "backlog", "バックログ") } } },
  ]);
  const afterRes = await page.request.get(`/api/bootstrap?ws=${encodeURIComponent(ws)}`);
  if (!afterRes.ok()) throw new Error(`bootstrap が失敗しました (${afterRes.status()}): ${await afterRes.text()}`);
  const after = (await afterRes.json()) as BootstrapPayload;
  expect(after.issues.find((item) => item.id === issue.id)?.startedAt).toBeNull();
  const started = await page.request.get(`/api/progress/started?ws=${encodeURIComponent(ws)}`);
  expect(started.ok()).toBeTruthy();
  const body = (await started.json()) as ProgressStartedResponse;
  expect(isValidYmd(body.startedOn[issue.id])).toBe(true);

  await page.reload();
  await expect(bar).toBeVisible();
  await expect(page.locator("[data-testid=timeline-row][data-identifier='ENG-1']").getByTestId("timeline-milestone")).toHaveCount(0);
});

test("完了予定が昨日の課題を今日進行中にすると、棒は着手日から始まり完了予定の日に印が出る", async ({ page }) => {
  const { ws } = await signupViaUi(page, { workspace: "期限後の着手" });
  const bootRes = await page.request.get(`/api/bootstrap?ws=${encodeURIComponent(ws)}`);
  if (!bootRes.ok()) throw new Error(`bootstrap が失敗しました (${bootRes.status()}): ${await bootRes.text()}`);
  const data = (await bootRes.json()) as BootstrapPayload;
  const team = data.teams.find((item) => item.key === "ENG") ?? data.teams[0];
  if (!team) throw new Error("チームがありません");
  const projectId = randomUUID();
  const issueId = randomUUID();
  const today = todayYmd(540);
  const yesterday = addDays(today, -1);
  await mutate(page, ws, [
    { type: "project.create", args: { id: projectId, name: "期限後の着手", teamIds: [team.id] } },
    {
      type: "issue.create",
      args: {
        id: issueId,
        teamId: team.id,
        projectId,
        title: "期限を過ぎてから着手した作業",
        stateId: stateId(data, team.id, "unstarted", "未着手"),
        dueDate: yesterday,
      },
    },
    { type: "issue.update", args: { id: issueId, patch: { stateId: stateId(data, team.id, "started", "進行中") } } },
  ]);
  await page.goto(`/${ws}/progress/timeline`);
  const row = page.locator("[data-testid=timeline-row]", { hasText: "期限を過ぎてから着手した作業" });
  const bar = row.getByTestId("timeline-bar");
  const mark = row.getByTestId("timeline-milestone");
  await bar.evaluate((el) => el.scrollIntoView({ inline: "center", block: "nearest" }));
  await expect(bar).toBeVisible();
  await expect(mark).toBeVisible();
  await expect(mark).toContainText("◆");
  const todaySlash = today.replaceAll("-", "/");
  const yesterdaySlash = yesterday.replaceAll("-", "/");
  await expect(bar).toHaveAttribute("title", new RegExp(`完了予定 ${yesterdaySlash}（着手より前） / 着手 ${todaySlash} → 今日`));
  const placed = await row.evaluate((el) => {
    const barEl = el.querySelector("[data-testid=timeline-bar]");
    const markEl = el.querySelector("[data-testid=timeline-milestone]");
    const track = el.querySelector(".timeline-track");
    const todayLine = document.querySelector("[data-testid=timeline-today]");
    const week = document.querySelector(".timeline-week");
    if (!(barEl instanceof HTMLElement) || !(markEl instanceof HTMLElement) || !(track instanceof HTMLElement) || !(todayLine instanceof HTMLElement) || !(week instanceof HTMLElement)) {
      return null;
    }
    const dayWidth = week.getBoundingClientRect().width / 7;
    const todayBox = todayLine.getBoundingClientRect();
    const trackBox = track.getBoundingClientRect();
    const todayCenter = todayBox.left + todayBox.width / 2 - trackBox.left;
    return {
      dayWidth,
      barFromTodayStart: barEl.getBoundingClientRect().left - trackBox.left - (todayCenter - dayWidth / 2),
      // offsetLeft は transform を含まない。印の left は完了予定の日の中央
      markFromYesterdayCenter: markEl.offsetLeft - (todayCenter - dayWidth),
    };
  });
  expect(placed, "棒と印の位置を測れません").toBeTruthy();
  expect(Math.abs(placed!.barFromTodayStart), JSON.stringify(placed)).toBeLessThanOrEqual(2);
  expect(Math.abs(placed!.markFromYesterdayCenter), JSON.stringify(placed)).toBeLessThanOrEqual(2);
});

test("日付のない作業の行を押すと WBS へ移り、棒を押すと課題が開く", async ({ page }) => {
  const { ws } = await signupViaUi(page);
  await seedDemo(page.request, ws);
  await page.goto(`/${ws}/progress/timeline`);
  const undated = page.getByTestId("timeline-undated").first();
  await expect(undated).toContainText(/日付のない作業 \d+ 件/);
  await undated.click();
  await expect(page).toHaveURL(new RegExp(`/${ws}/progress/wbs$`));
  await expect(page.getByTestId("wbs-row").first()).toBeVisible();

  await page.getByTestId("progress-tab-timeline").click();
  const bar = page.locator("[data-testid=timeline-row][data-identifier='ENG-1']").getByTestId("timeline-bar");
  await bar.evaluate((el) => el.scrollIntoView({ inline: "center", block: "nearest" }));
  await bar.click();
  await expect(page.getByTestId("issue-detail")).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/issue/ENG-1$`));
});

test("遠い期日が1件あってもタイムラインはすぐ出て、棒と印は期間の端で切れる", async ({ page }) => {
  const { ws } = await signupViaUi(page, { workspace: "遠い期日" });
  const bootRes = await page.request.get(`/api/bootstrap?ws=${encodeURIComponent(ws)}`);
  if (!bootRes.ok()) throw new Error(`bootstrap が失敗しました (${bootRes.status()}): ${await bootRes.text()}`);
  const data = (await bootRes.json()) as BootstrapPayload;
  const team = data.teams.find((item) => item.key === "ENG") ?? data.teams[0];
  if (!team) throw new Error("チームがありません");
  const projectId = randomUUID();
  const milestoneId = randomUUID();
  const barId = randomUUID();
  await mutate(page, ws, [
    { type: "project.create", args: { id: projectId, name: "遠い期日", teamIds: [team.id] } },
    {
      type: "issue.create",
      args: {
        id: milestoneId,
        teamId: team.id,
        projectId,
        title: "期日だけ遠い課題",
        stateId: stateId(data, team.id, "unstarted", "未着手"),
        dueDate: "9999-12-31",
      },
    },
    {
      type: "issue.create",
      args: {
        id: barId,
        teamId: team.id,
        projectId,
        title: "着手して期日が遠い課題",
        stateId: stateId(data, team.id, "unstarted", "未着手"),
        dueDate: "9999-12-31",
      },
    },
    { type: "issue.update", args: { id: barId, patch: { stateId: stateId(data, team.id, "started", "進行中") } } },
  ]);

  await page.goto(`/${ws}/progress/timeline`);
  const markRow = page.locator("[data-testid=timeline-row]", { hasText: "期日だけ遠い課題" });
  const barRow = page.locator("[data-testid=timeline-row]", { hasText: "着手して期日が遠い課題" });
  const mark = markRow.getByTestId("timeline-milestone");
  const bar = barRow.getByTestId("timeline-bar");
  await expect(mark).toBeVisible();
  await expect(bar).toBeVisible();

  const width = await page.locator(".timeline-sheet").evaluate((el) => {
    const style = getComputedStyle(el);
    const chart = Number.parseFloat(style.getPropertyValue("--timeline-chart"));
    const week = Number.parseFloat(style.getPropertyValue("--timeline-week"));
    return { chart, day: week / 7, sheet: el.getBoundingClientRect().width };
  });
  // 前後 3 年に、週の端と「14日前〜28日後」の余白を足した分まで
  const maxDays = 365 * 3 * 2 + 14 + 28 + 14;
  expect(width.day).toBeGreaterThan(0);
  expect(width.chart, JSON.stringify(width)).toBeLessThanOrEqual(maxDays * width.day + 1);
  expect(width.sheet, JSON.stringify(width)).toBeLessThanOrEqual(maxDays * width.day + 400);
  expect(await page.locator(".timeline-week").count()).toBeLessThanOrEqual(Math.ceil(maxDays / 7) + 1);

  await expect(mark).toContainText("完了予定 9999/12/31（範囲外）");
  await expect(mark).toHaveAttribute("title", /9999\/12\/31/);
  await expect(bar).toHaveClass(/is-clip-end/);
  await expect(bar).toHaveAttribute("title", /9999\/12\/31/);

  const placed = await markRow.evaluate((row) => {
    const markEl = row.querySelector("[data-testid=timeline-milestone]");
    const track = row.querySelector(".timeline-track");
    const week = document.querySelector(".timeline-week");
    if (!(markEl instanceof HTMLElement) || !(track instanceof HTMLElement) || !(week instanceof HTMLElement)) return null;
    return { left: markEl.offsetLeft, track: track.clientWidth, day: week.getBoundingClientRect().width / 7 };
  });
  expect(placed, "印の位置を測れません").toBeTruthy();
  expect(Math.abs(placed!.left - (placed!.track - placed!.day / 2)), JSON.stringify(placed)).toBeLessThanOrEqual(2);

  const barPlaced = await barRow.evaluate((row) => {
    const barEl = row.querySelector("[data-testid=timeline-bar]");
    const track = row.querySelector(".timeline-track");
    if (!(barEl instanceof HTMLElement) || !(track instanceof HTMLElement)) return null;
    return { left: barEl.offsetLeft, right: barEl.offsetLeft + barEl.offsetWidth, track: track.clientWidth };
  });
  expect(barPlaced, "棒の位置を測れません").toBeTruthy();
  expect(barPlaced!.right - barPlaced!.left, JSON.stringify(barPlaced)).toBeGreaterThan(barPlaced!.track * 0.2);
  expect(Math.abs(barPlaced!.right - barPlaced!.track), JSON.stringify(barPlaced)).toBeLessThanOrEqual(1);
});

test("課題の題名だけを変えても着手日は取り直さず、状態を変えると取り直す", async ({ page }) => {
  const { ws } = await signupViaUi(page, { workspace: "着手日の再取得" });
  const bootRes = await page.request.get(`/api/bootstrap?ws=${encodeURIComponent(ws)}`);
  if (!bootRes.ok()) throw new Error(`bootstrap が失敗しました (${bootRes.status()}): ${await bootRes.text()}`);
  const data = (await bootRes.json()) as BootstrapPayload;
  const team = data.teams.find((item) => item.key === "ENG") ?? data.teams[0];
  const project = data.projects.find((item) => !item.archivedAt);
  if (!team || !project) throw new Error("チームかプロジェクトがありません");
  const id = randomUUID();
  await mutate(page, ws, [
    {
      type: "issue.create",
      args: {
        id,
        teamId: team.id,
        projectId: project.id,
        title: "題名だけの変更",
        stateId: stateId(data, team.id, "unstarted", "未着手"),
      },
    },
  ]);

  let startedRequests = 0;
  page.on("request", (req) => {
    if (req.method() !== "GET") return;
    if (new URL(req.url()).pathname !== "/api/progress/started") return;
    startedRequests += 1;
  });

  await page.goto(`/${ws}/progress/wbs`);
  const row = page.locator("[data-testid=wbs-row]", { hasText: "題名だけの変更" });
  await expect(row).toBeVisible();
  await expect.poll(() => startedRequests).toBeGreaterThan(0);
  // 開いた直後の取り直し（1.5 秒）が収まってから数える
  await page.waitForTimeout(2000);
  const baseline = startedRequests;

  await mutate(page, ws, [{ type: "issue.update", args: { id, patch: { title: "題名だけ変えた" } } }]);
  const renamed = page.locator("[data-testid=wbs-row]", { hasText: "題名だけ変えた" });
  await expect(renamed).toBeVisible();
  await page.waitForTimeout(2000);
  expect(startedRequests).toBe(baseline);

  await mutate(page, ws, [
    { type: "issue.update", args: { id, patch: { stateId: stateId(data, team.id, "started", "進行中") } } },
  ]);
  await expect(renamed).toContainText("進行中");
  await expect.poll(() => startedRequests).toBeGreaterThan(baseline);
});

async function expectBoxInside(page: Page, locator: ReturnType<Page["locator"]>) {
  const box = await locator.boundingBox();
  const viewport = page.viewportSize();
  expect(box).toBeTruthy();
  expect(viewport).toBeTruthy();
  expect(box!.x).toBeGreaterThanOrEqual(-1);
  expect(box!.y).toBeGreaterThanOrEqual(-1);
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport!.width + 1);
  expect(box!.y + box!.height).toBeLessThanOrEqual(viewport!.height + 1);
}

async function expectNoHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => {
    const root = document.documentElement;
    const el = document.querySelector("[data-testid=progress-page]");
    const box = el?.getBoundingClientRect();
    return {
      doc: root.scrollWidth - root.clientWidth,
      right: box ? box.right : 0,
    };
  });
  expect(overflow.doc).toBeLessThanOrEqual(1);
  expect(overflow.right).toBeLessThanOrEqual(391);
}
