import type { Route } from "playwright";
import { googleMock, TUTORIAL_SPREADSHEET_ID, type MockCell, type MockSpreadsheet, type MockTab } from "../lib/google-mock";
import type { Director } from "../lib/director";
import { defineScenario } from "../lib/types";

export const sheets = true;

const PROJECT = "モバイルアプリ v2.0";
const ISSUE_TITLE = "iOS でプッシュ通知が届かないことがある";
const ACTIVITY = "活動一覧";
const WBS = "WBS";
const SETUP_URL = "https://setup.sen-tutorial.invalid/";
const SHEET_URL = `https://docs.google.com/spreadsheets/d/${TUTORIAL_SPREADSHEET_ID}/edit`;

const SHEETS_SECTION = "section.settings-section";

export default defineScenario({
  id: "sheets",
  order: 16,
  screen: "settings",
  title: "スプレッドシート連携",
  summary: "プロジェクトと課題を、Google スプレッドシートの「活動一覧」「WBS」へ自動で書き出します。",
  start: "/settings/workspace",
  async run(t) {
    await installRoutes(t);
    await t.page.goto(SETUP_URL);
    await t.expect("[data-testid=setup]");
    await t.wait(500);
    // 新しいページでは、マウスを動かすまで収録用のカーソルが出ない
    await t.page.mouse.move(1180, 36);
    t.setMouse(1180, 36);

    await t.caption("はじめに一度だけ、Google と Worker の準備をします");
    await t.wait(400);

    await t.caption("Google Cloud で Sheets API を有効にし、サービスアカウントの鍵を作ります");
    await t.highlight("[data-testid=setup-step-1]", 1600);

    await t.caption("シートを作り、サービスアカウントを「編集者」で共有します");
    await t.highlight("[data-testid=setup-step-2]", 1600);

    await t.caption("ワークスペース名・シートの ID・鍵を、Worker の secret に登録します");
    await t.highlight("[data-testid=setup-step-3]", 1600);

    await t.goto("/settings/workspace");
    const section = await focusSheetsSection(t);
    await t.expect("[data-testid=sheets-last-sync]", { text: "まだ反映していません" });
    await t.caption("準備ができると、設定の「全般」に「スプレッドシート連携」が表示されます");
    await t.highlight(section, 1600);

    await t.caption("「今すぐ反映」を押すと、その場でシートに書き出されます");
    await t.click("[data-testid=sheets-sync-now]");
    await t.expect("[data-testid=toast]", { text: "スプレッドシートに反映しました", timeout: 20_000 });
    await t.expect("[data-testid=sheets-last-sync]", { text: /\d/ });
    const synced = (await t.page.locator("[data-testid=sheets-last-sync]").innerText()).trim();
    if (synced.includes("まだ反映していません")) throw new Error("最終反映が更新されていません");
    await t.highlight("[data-testid=sheets-last-sync]", 1400);
    assertWritten(googleMock.snapshot());

    await t.caption("「スプレッドシートを開く」で、書き出された内容を確かめます");
    await openSheet(t);
    await t.expect(`[data-testid=sheet-grid][data-tab='${ACTIVITY}'] tr[data-key='${PROJECT}']`);
    await t.page.mouse.move(1100, 44);
    t.setMouse(1100, 44);
    await t.wait(200);
    await t.poster();

    await t.caption("「活動一覧」には、プロジェクトごとの完了率と状況がまとまります");
    await t.expect(`[data-testid=sheet-col][data-tab='${ACTIVITY}'][data-header='完了率']`);
    await t.highlight(`[data-testid=sheet-col][data-tab='${ACTIVITY}'][data-header='完了率']`, 1500);
    await t.highlight(`[data-testid=sheet-col][data-tab='${ACTIVITY}'][data-header='活動状況']`, 1500);

    await t.caption("「WBS」タブには、課題が担当・期限・状態つきで並びます");
    await t.click(`[data-testid=sheet-tab][data-title='${WBS}']`);
    await t.expect(`[data-testid=sheet-grid][data-tab='${WBS}']`, { text: ISSUE_TITLE });
    await t.expect(`[data-testid=sheet-col][data-tab='${WBS}'][data-header='状態']`);
    await t.highlight(`[data-testid=sheet-col][data-tab='${WBS}'][data-header='状態']`, 1600);

    const beforeRate = cellByHeader(googleMock.snapshot(), ACTIVITY, PROJECT, "完了率");
    if (!beforeRate) throw new Error("反映前の完了率が空です");

    await t.goto("/issue/ENG-1");
    await t.expect("[data-testid=issue-detail][data-identifier='ENG-1']");
    await t.caption("Sen で課題を更新すると、シートも自動で書き直されます");
    await t.click("[data-testid=prop-status]");
    await t.click("[data-testid=picker-status] [role=option]:has-text('完了')", { pause: 600 });
    await t.expect("[data-testid=prop-status]", { text: "完了" });

    // 「完了」の表示は楽観的な更新。/api/mutate の送信と反映の予約（scheduleSheetSync。waitUntil で非同期）はそのあと。
    // 設定画面の最初の状態取得が予約より先だと pending は false になり、次の取り直しは 30 秒後なので反映待ちを取り逃がす。
    await waitForPendingSync(t);

    // 収録では保存から反映までの待ちを TUTORIAL_SHEETS_DELAY_MS に縮めている（本番は約 30 秒）。
    // 反映待ちが消える前に設定へ戻す。
    await t.goto("/settings/workspace");
    await focusSheetsSection(t);
    await t.expect("[data-testid=sheets-pending]", { timeout: 8_000 });
    await t.caption("保存すると「反映待ち」になり、約 30 秒後に自動で反映されます");
    // 字幕を出しているあいだに反映待ちが消えていたら、壊れた動画を残さず収録を失敗させる
    await t.expect("[data-testid=sheets-pending]");
    await t.highlight("[data-testid=sheets-pending]", 1400);
    await t.expect("[data-testid=sheets-pending]", { hidden: true, timeout: 25_000 });
    await t.highlight("[data-testid=sheets-last-sync]", 1400);

    await openSheet(t);
    await t.page.mouse.move(1100, 44);
    t.setMouse(1100, 44);
    const afterRate = cellByHeader(googleMock.snapshot(), ACTIVITY, PROJECT, "完了率");
    if (afterRate === beforeRate) throw new Error(`完了率が変わっていません（${beforeRate}）`);
    const rateCell = `[data-testid=sheet-grid][data-tab='${ACTIVITY}'] tr[data-key='${PROJECT}'] td[data-col='完了率']`;
    await t.expect(rateCell, { text: afterRate });
    await t.caption("完了率も、新しい状態に書き直されています");
    await t.highlight(rateCell, 1600);

    await t.caption("シートは Sen が上書きするので、変更は Sen で行ってください", { hold: 2200 });
    await t.highlight(`[data-testid=sheet-grid][data-tab='${ACTIVITY}'] tr[data-row='3']`, 1800);
  },
});

/** 見出し行（frozenRowCount 行目）の列名から、最初の文字が rowKey の行の文字を読む */
function cellByHeader(snapshot: MockSpreadsheet, tabTitle: string, rowKey: string, header: string): string {
  const tab = snapshot.tabs.find((item) => item.title === tabTitle);
  if (!tab) throw new Error(`タブ「${tabTitle}」がありません`);
  const headerRow = tab.rows[tab.frozenRowCount - 1];
  if (!headerRow) throw new Error(`「${tabTitle}」に見出し行がありません`);
  const col = headerRow.findIndex((cell) => cell.text === header);
  if (col < 0) throw new Error(`「${tabTitle}」に列「${header}」がありません`);
  const row = tab.rows.find((cells, index) => index > tab.frozenRowCount - 1 && firstText(cells) === rowKey);
  if (!row) throw new Error(`「${tabTitle}」に「${rowKey}」の行がありません`);
  return row[col]?.text ?? "";
}

function firstText(cells: MockCell[]): string {
  return cells.find((cell) => cell.text)?.text ?? "";
}

function assertWritten(snapshot: MockSpreadsheet) {
  if (snapshot.batchCount < 1) throw new Error(`シートへの書き込みがありません（batchCount=${snapshot.batchCount}）`);
  const titles = snapshot.tabs.map((tab) => tab.title);
  if (!titles.includes(ACTIVITY) || !titles.includes(WBS)) {
    throw new Error(`活動一覧と WBS がありません（${titles.join("、")}）`);
  }
}

/** 反映が予約されるまで状態を 100ms おきに見る。予約済みならすぐ戻る（最大 8 秒） */
async function waitForPendingSync(t: Director): Promise<void> {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const pending = await t.page.evaluate(async (ws) => {
      const res = await fetch("/api/sheets/status?ws=" + encodeURIComponent(ws), {
        headers: { "x-sen-client": "1" },
        credentials: "same-origin",
      });
      if (!res.ok) return false;
      const body = await res.json();
      return body != null && body.pending === true;
    }, t.ws);
    if (pending) return;
    await t.page.waitForTimeout(100);
  }
  throw new Error("反映の予約を確認できませんでした");
}

async function focusSheetsSection(t: Director) {
  const section = t.page.locator(SHEETS_SECTION).filter({
    has: t.page.locator("h2", { hasText: /^スプレッドシート連携$/ }),
  });
  await section.evaluate((el) => el.scrollIntoView({ block: "center", inline: "nearest" }));
  await t.wait(300);
  return section;
}

async function openSheet(t: Director) {
  // <a target="_blank"> は新しいタブで開く。録画は今のタブしか映さないので、同じタブで開く。
  await t.page.locator("[data-testid=sheets-open]").evaluate((el) => el.removeAttribute("target"));
  await t.click("[data-testid=sheets-open]");
  await t.expect("[data-testid=sheet]", { timeout: 15_000 });
  await t.expect(`[data-testid=sheet-tab][data-title='${ACTIVITY}'][data-active='true']`);
}

async function installRoutes(t: Director) {
  const context = t.page.context();
  await context.route(/^https:\/\/setup\.sen-tutorial\.invalid\/?$/, (route) => serve(route, () => setupPage()));
  const sheetRe = new RegExp(`^${SHEET_URL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`);
  await context.route(sheetRe, (route) => serve(route, () => sheetPage(googleMock.snapshot())));
}

async function serve(route: Route, build: () => string) {
  try {
    await route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: build() });
  } catch (e) {
    console.error(e);
    try {
      await route.fulfill({ status: 500, contentType: "text/html; charset=utf-8", body: "<!doctype html><title>error</title>" });
    } catch (err) {
      console.error(err);
    }
  }
}

function setupPage(): string {
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<title>スプレッドシート連携の準備</title>
<link rel="icon" href="data:,">
<style>
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; overflow: hidden; }
  body {
    background:
      radial-gradient(ellipse 90% 46% at 50% -12%, rgba(100, 112, 232, .22), transparent 62%),
      #0f1012;
    color: #e8e9ed;
    font-family: "Inter", "Noto Sans CJK JP", "Noto Sans JP", sans-serif;
  }
  [data-testid="setup"] {
    height: 660px;
    overflow: hidden;
    padding: 32px 48px 0;
  }
  .badge {
    display: inline-flex;
    align-items: center;
    height: 26px;
    padding: 0 12px;
    border-radius: 999px;
    background: rgba(100, 112, 232, .16);
    color: #9aa3f5;
    border: 1px solid rgba(100, 112, 232, .4);
    font-size: 12px;
    font-weight: 700;
    letter-spacing: .06em;
  }
  h1 { margin: 14px 0 8px; font-size: 32px; font-weight: 700; letter-spacing: .01em; line-height: 1.25; }
  .lead { margin: 0 0 22px; color: #8b8f98; font-size: 15px; line-height: 1.6; }
  .steps { display: grid; grid-template-columns: 1fr 1fr; gap: 14px 16px; }
  article {
    margin: 0;
    background: #17181c;
    border: 1px solid rgba(255, 255, 255, .08);
    border-radius: 12px;
    padding: 16px 18px 18px;
  }
  [data-testid="setup-step-3"] { grid-column: 1 / -1; }
  .head { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
  .num {
    width: 26px; height: 26px; border-radius: 50%;
    background: #6470e8; color: #fff;
    display: inline-flex; align-items: center; justify-content: center;
    font-size: 14px; font-weight: 700; flex-shrink: 0;
  }
  h2 { margin: 0; font-size: 16px; font-weight: 700; }
  p { margin: 0; font-size: 14.5px; line-height: 1.65; }
  .code {
    margin: 12px 0 10px;
    padding: 10px 14px;
    border-radius: 8px;
    background: #0f1012;
    border: 1px solid rgba(255, 255, 255, .08);
    color: #e8e9ed;
    font-family: ui-monospace, "SFMono-Regular", Menlo, monospace;
    font-size: 13.5px;
    line-height: 1.7;
    white-space: pre;
    overflow: hidden;
  }
  .note { margin-top: 4px; color: #8b8f98; font-size: 13px; line-height: 1.7; }
  .note + .note { margin-top: 0; }
  .k { color: #e8e9ed; font-weight: 650; }
  .url { font-family: ui-monospace, "SFMono-Regular", Menlo, monospace; font-size: 12.5px; color: #c5c8d0; }
  .id {
    background: #6470e8;
    color: #fff;
    border-radius: 4px;
    padding: 1px 5px;
    font-weight: 700;
  }
</style>
</head>
<body>
  <div data-testid="setup">
    <div class="badge">最初に一度だけ</div>
    <h1>スプレッドシート連携の準備</h1>
    <p class="lead">Google 側でシートと書き込み用のアカウントを用意し、Worker に登録します。</p>
    <div class="steps">
      <article data-testid="setup-step-1">
        <div class="head"><span class="num">1</span><h2>Google Cloud</h2></div>
        <p>Google Sheets API を有効にし、サービスアカウントを作って JSON の鍵を発行します。</p>
      </article>
      <article data-testid="setup-step-2">
        <div class="head"><span class="num">2</span><h2>スプレッドシート</h2></div>
        <p>書き込み先のシートを作り、サービスアカウントのメールアドレス（鍵の client_email）を「編集者」で共有します。報告を読む人には「閲覧者」で共有します。</p>
      </article>
      <article data-testid="setup-step-3">
        <div class="head"><span class="num">3</span><h2>Worker の secret</h2></div>
        <p>連携するワークスペース、シートの ID、鍵を登録します。</p>
        <div class="code">bunx wrangler secret put SHEETS_WORKSPACE
bunx wrangler secret put SHEETS_SPREADSHEET_ID
bunx wrangler secret put GOOGLE_SERVICE_ACCOUNT_KEY &lt; key.json</div>
        <p class="note"><span class="k">SHEETS_WORKSPACE</span> … ワークスペースの URL の名前（例：ses）</p>
        <p class="note"><span class="k">SHEETS_SPREADSHEET_ID</span> … シートの URL の /d/ と /edit の間 <span class="url">https://docs.google.com/spreadsheets/d/<span class="id">1AbC…xYz</span>/edit</span></p>
      </article>
    </div>
  </div>
</body>
</html>`;
}

function sheetPage(snapshot: MockSpreadsheet): string {
  const tabs = [...snapshot.tabs].sort((a, b) => a.index - b.index);
  const active = tabs.find((tab) => tab.title === ACTIVITY) ?? tabs[0];
  const activeTitle = active?.title ?? "";
  const buttons = tabs
    .map((tab) => {
      const on = tab.title === activeTitle;
      return `<button type="button" data-testid="sheet-tab" data-title="${esc(tab.title)}" data-active="${on ? "true" : "false"}">${esc(tab.title)}</button>`;
    })
    .join("");
  const grids = tabs.map((tab) => renderGrid(tab, tab.title === activeTitle)).join("");
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<title>活動報告</title>
<link rel="icon" href="data:,">
<style>
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; overflow: hidden; }
  body {
    background:
      radial-gradient(ellipse 90% 46% at 50% -12%, rgba(100, 112, 232, .18), transparent 62%),
      #0f1012;
    font-family: "Inter", "Noto Sans CJK JP", "Noto Sans JP", sans-serif;
  }
  .window {
    position: absolute;
    left: 16px; right: 16px; top: 20px;
    height: 640px;
    background: #fff;
    border-radius: 12px;
    box-shadow: 0 18px 50px rgba(0, 0, 0, .45);
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .titlebar {
    height: 48px;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 0 16px;
    border-bottom: 1px solid #e3e3e3;
    color: #202124;
    font-size: 15px;
    font-weight: 600;
  }
  .grids { flex: 1; min-height: 0; position: relative; }
  .grid {
    position: absolute;
    inset: 0;
    overflow-x: hidden;
    overflow-y: auto;
    scrollbar-gutter: stable;
  }
  .grid[hidden] { display: none !important; }
  table {
    border-collapse: collapse;
    table-layout: fixed;
    color: #202124;
    font-size: 13px;
  }
  th, td {
    height: 24px;
    padding: 0 6px;
    border: 1px solid #e3e3e3;
    font-weight: 400;
    text-align: left;
    white-space: nowrap;
    overflow: hidden;
    line-height: 24px;
  }
  th.rownum, th.letter {
    background: #f8f9fa;
    color: #5f6368;
    text-align: center;
    padding: 0;
    font-size: .92em;
  }
  td.span { overflow: visible; }
  td.link { color: #1a0dab; text-decoration: underline; }
  tr.frozen > th, tr.frozen > td { border-bottom: 2px solid #c4c7c5; }
  .tabs {
    height: 36px;
    flex-shrink: 0;
    background: #f1f3f4;
    display: flex;
    align-items: flex-end;
    gap: 2px;
    padding: 0 8px;
    border-top: 1px solid #e3e3e3;
  }
  .tabs button {
    height: 28px;
    margin: 0;
    padding: 0 14px;
    border: 1px solid transparent;
    border-bottom: 0;
    border-radius: 8px 8px 0 0;
    background: transparent;
    color: #5f6368;
    font: 13px "Inter", "Noto Sans CJK JP", "Noto Sans JP", sans-serif;
    cursor: pointer;
  }
  .tabs button[data-active="true"] {
    background: #fff;
    color: #202124;
    border-color: #dadce0;
    font-weight: 600;
  }
</style>
</head>
<body>
  <div class="window" data-testid="sheet">
    <div class="titlebar">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <rect x="3.5" y="3.5" width="17" height="17" rx="2" stroke="#4b5563" stroke-width="1.7"/>
        <path d="M3.5 9.5h17M3.5 15.5h17M9.5 3.5v17M15.5 3.5v17" stroke="#4b5563" stroke-width="1.7"/>
      </svg>
      活動報告
    </div>
    <div class="grids">${grids}</div>
    <div class="tabs">${buttons}</div>
  </div>
  <script>${sheetScript()}<\/script>
</body>
</html>`;
}

interface VisibleCol {
  index: number;
  letter: string;
  width: number;
  header: string;
}

function renderGrid(tab: MockTab, active: boolean): string {
  const hidden = new Set(tab.hiddenColumns);
  const lastIndex = Math.max(
    -1,
    ...tab.rows.map((row) => row.length - 1),
    ...Object.keys(tab.columnWidths).map((key) => Number(key)),
    ...tab.hiddenColumns,
  );
  const headerAt = tab.frozenRowCount > 0 ? tab.frozenRowCount - 1 : -1;
  const headerRow = headerAt >= 0 ? (tab.rows[headerAt] ?? []) : [];
  const cols: VisibleCol[] = [];
  for (let index = 0; index <= lastIndex; index++) {
    if (hidden.has(index)) continue;
    cols.push({
      index,
      letter: columnLetter(index),
      width: tab.columnWidths[index] ?? 100,
      header: headerRow[index]?.text ?? "",
    });
  }
  const natural = 40 + cols.reduce((sum, col) => sum + col.width, 0);
  const body = tab.rows.map((row, index) => renderRow(row, index, cols, headerAt)).join("");
  const head = `<tr><th class="rownum" data-w="40"></th>${cols
    .map((col) => `<th class="letter" data-w="${col.width}">${esc(col.letter)}</th>`)
    .join("")}</tr>`;
  return `<div class="grid" data-testid="sheet-grid" data-tab="${esc(tab.title)}" data-frozen="${tab.frozenRowCount}"${active ? "" : " hidden"}>
    <table data-natural="${natural}">
      <colgroup>
        <col data-w="40" style="width:40px">
        ${cols.map((col) => `<col data-w="${col.width}" style="width:${col.width}px">`).join("")}
      </colgroup>
      <thead>${head}</thead>
      <tbody>${body}</tbody>
    </table>
  </div>`;
}

function renderRow(row: MockCell[], index: number, cols: VisibleCol[], headerAt: number): string {
  const rowNo = index + 1;
  const key = firstText(row);
  const frozen = headerAt >= 0 && index === headerAt;
  const below = headerAt >= 0 && index > headerAt;
  const cls = frozen ? ` class="frozen"` : "";
  if (isSpanningRow(row) && cols.length > 0) {
    const cell = row[0] ?? { text: "" };
    return `<tr data-row="${rowNo}" data-key="${esc(key)}"${cls}><th class="rownum">${rowNo}</th><td class="span${cell.link ? " link" : ""}" colspan="${cols.length}" ${cellAttrs(cell)}>${esc(cell.text)}</td></tr>`;
  }
  const tds = cols
    .map((col) => {
      const cell = row[col.index] ?? { text: "" };
      const extra = [
        frozen ? `data-header="${esc(col.header)}"` : "",
        below ? `data-col="${esc(col.header)}"` : "",
      ]
        .filter(Boolean)
        .join(" ");
      return `<td class="${cell.link ? "link" : ""}" ${extra} ${cellAttrs(cell)}>${esc(cell.text)}</td>`;
    })
    .join("");
  return `<tr data-row="${rowNo}" data-key="${esc(key)}"${cls}><th class="rownum">${rowNo}</th>${tds}</tr>`;
}

function isSpanningRow(row: MockCell[]): boolean {
  if (!row[0]?.text) return false;
  return row.slice(1).every((cell) => !cell?.text);
}

function cellAttrs(cell: MockCell): string {
  const style: string[] = [];
  if (cell.bold) style.push("font-weight:700");
  if (!cell.link && cell.color && /^#[0-9a-fA-F]{6}$/.test(cell.color)) style.push(`color:${cell.color}`);
  if (cell.background && /^#[0-9a-fA-F]{6}$/.test(cell.background)) style.push(`background:${cell.background}`);
  const pt = typeof cell.fontSize === "number" && Number.isFinite(cell.fontSize) ? ` data-pt="${cell.fontSize}"` : "";
  return `style="${style.join(";")}"${pt}`;
}

function columnLetter(index: number): string {
  let n = index + 1;
  let out = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

function esc(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
    .replaceAll("\n", " ")
    .replaceAll("\r", " ");
}

/** ページ内のスクリプト。< は \\u003c にして </script> では抜けられないようにする */
function sheetScript(): string {
  const code = `
function fitAll() {
  var host = document.querySelector(".grids");
  if (!host) return;
  var sample = document.querySelector("[data-testid=sheet-grid]:not([hidden])");
  var available = sample && sample.clientWidth > 0 ? sample.clientWidth : host.clientWidth;
  var grids = document.querySelectorAll("[data-testid=sheet-grid]");
  for (var i = 0; grids.length > i; i++) {
    var table = grids[i].querySelector("table");
    if (!table) continue;
    var natural = Number(table.getAttribute("data-natural")) || 0;
    var scale = natural > available && available > 0 ? (available - 1) / natural : 1;
    table.style.width = (natural * scale) + "px";
    table.style.fontSize = (13 * scale) + "px";
    var sized = table.querySelectorAll("[data-w]");
    for (var j = 0; sized.length > j; j++) {
      sized[j].style.width = (Number(sized[j].getAttribute("data-w")) * scale) + "px";
    }
    var pts = table.querySelectorAll("[data-pt]");
    for (var k = 0; pts.length > k; k++) {
      pts[k].style.fontSize = ((Number(pts[k].getAttribute("data-pt")) * 4) / 3 * scale) + "px";
    }
  }
}
function placeCols() {
  var old = document.querySelectorAll("[data-testid=sheet-col]");
  for (var i = 0; old.length > i; i++) old[i].remove();
  var grid = document.querySelector("[data-testid=sheet-grid]:not([hidden])");
  if (!grid) return;
  var tab = grid.getAttribute("data-tab") || "";
  var frozen = Number(grid.getAttribute("data-frozen")) || 0;
  if (!(frozen > 0)) return;
  var header = grid.querySelector('tr[data-row="' + frozen + '"]');
  if (!header) return;
  var gridRect = grid.getBoundingClientRect();
  var rows = grid.querySelectorAll("tr[data-row]");
  var last = null;
  for (var r = 0; rows.length > r; r++) {
    var rect = rows[r].getBoundingClientRect();
    if (rect.bottom > gridRect.top + 1 && gridRect.bottom > rect.top + 1) last = rows[r];
  }
  if (!last) return;
  var lastRect = last.getBoundingClientRect();
  var cells = header.querySelectorAll("td[data-header]");
  for (var c = 0; cells.length > c; c++) {
    var headRect = cells[c].getBoundingClientRect();
    var top = Math.max(headRect.top, gridRect.top);
    var bottom = Math.min(lastRect.bottom, gridRect.bottom);
    var left = Math.max(headRect.left, gridRect.left);
    var right = Math.min(headRect.right, gridRect.right);
    if (!(bottom > top) || !(right > left)) continue;
    var mark = document.createElement("div");
    mark.setAttribute("data-testid", "sheet-col");
    mark.setAttribute("data-tab", tab);
    mark.setAttribute("data-header", cells[c].getAttribute("data-header") || "");
    mark.style.position = "fixed";
    mark.style.top = top + "px";
    mark.style.left = left + "px";
    mark.style.width = (right - left) + "px";
    mark.style.height = (bottom - top) + "px";
    mark.style.pointerEvents = "none";
    mark.style.background = "transparent";
    document.body.appendChild(mark);
  }
}
function show(title) {
  var tabs = document.querySelectorAll("[data-testid=sheet-tab]");
  for (var i = 0; tabs.length > i; i++) {
    var btn = tabs[i];
    btn.setAttribute("data-active", btn.getAttribute("data-title") === title ? "true" : "false");
  }
  var grids = document.querySelectorAll("[data-testid=sheet-grid]");
  for (var g = 0; grids.length > g; g++) {
    var on = grids[g].getAttribute("data-tab") === title;
    if (on) grids[g].removeAttribute("hidden");
    else grids[g].setAttribute("hidden", "");
  }
  fitAll();
  placeCols();
}
var buttons = document.querySelectorAll("[data-testid=sheet-tab]");
for (var n = 0; buttons.length > n; n++) {
  buttons[n].addEventListener("click", function () {
    show(this.getAttribute("data-title") || "");
  });
}
function layout(tries) {
  var host = document.querySelector(".grids");
  var width = host ? host.clientWidth : 0;
  if (!(width > 0) && tries > 0) {
    requestAnimationFrame(function () { layout(tries - 1); });
    return;
  }
  fitAll();
  placeCols();
}
layout(8);
window.addEventListener("load", function () { fitAll(); placeCols(); });
window.addEventListener("resize", function () { fitAll(); placeCols(); });
`;
  return code.replaceAll("<", "\\u003c");
}
