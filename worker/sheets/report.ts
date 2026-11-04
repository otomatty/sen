// 活動一覧と WBS の中身、および Sheets API の batchUpdate リクエストを作る純粋関数。
// DB・fetch には依存しない（Playwright から直接 import して確かめる）。

import { dateToYmd } from "../../shared/dates";
import { PRIORITIES } from "../../shared/constants";
import type { StateType } from "../../shared/types";

const DESCRIPTION_MAX = 50_000;
const JST_OFFSET_MS = 540 * 60_000;
const PROCESS_PREFIX = /^工程[:：](.*)$/;

const ACTIVITY_TAB = "活動一覧";
const WBS_TAB = "WBS";
const ACTIVITY_SHEET_ID = 1001;
const WBS_SHEET_ID = 1002;
const HEADER_ROW_COUNT = 5;

const ACTIVITY_HEADERS = ["活動", "直近期限", "完了率", "活動状況", "ID（連携用）"];
const WBS_HEADERS = ["活動", "工程", "作業", "説明", "担当", "着手日", "完了予定", "状態", "完了日", "優先度", "ID（連携用）"];
const ACTIVITY_WIDTHS = [320, 160, 120, 110];
const WBS_WIDTHS = [200, 110, 300, 320, 100, 100, 100, 90, 100, 70];

const NOTE = "このシートは Sen から自動で作られます。変更は Sen で行ってください。";

export interface ReportInput {
  workspaceName: string;
  urlKey: string;
  /** アプリの公開 URL（リンク用）。null ならリンクなしの文字列にする */
  origin: string | null;
  /** 日本時間の今日 'YYYY-MM-DD' */
  today: string;
  /** 反映日時（UNIX ミリ秒） */
  now: number;
  /** 表示順に並んだ、アーカイブされていないプロジェクト */
  projects: { id: string; name: string }[];
  issues: ReportIssueInput[];
}

export interface ReportIssueInput {
  id: string;
  /** 'ENG-12' */
  identifier: string;
  title: string;
  /** 説明を平文にしたもの */
  descriptionText: string;
  projectId: string;
  stateName: string;
  stateType: StateType;
  priority: number;
  assigneeName: string | null;
  labelNames: string[];
  /** 'YYYY-MM-DD' */
  dueDate: string | null;
  /** 着手日 'YYYY-MM-DD'（日本時間） */
  startedOn: string | null;
  /** 完了日 'YYYY-MM-DD'（日本時間） */
  completedOn: string | null;
}

export interface ReportLink {
  text: string;
  url: string | null;
}

export type ActivityStatus = "タスク未登録" | "完了" | "期限超過" | "保留あり" | "進行中" | "未着手";

export interface ActivityRow {
  /** プロジェクト名。origin があればプロジェクトへのリンク */
  activity: ReportLink;
  nextDue: string;
  completionRate: string;
  status: ActivityStatus;
  id: string;
}

export interface TaskRow {
  activity: string;
  /** `工程:` / `工程：` ラベルを名前順に `／` でつないだもの。無ければ空 */
  process: string;
  work: ReportLink;
  description: string;
  assignee: string;
  startedOn: string;
  dueDate: string;
  state: string;
  completedOn: string;
  priority: string;
  id: string;
}

export interface Report {
  activities: ActivityRow[];
  tasks: TaskRow[];
  workspaceName: string;
  /** 反映日時（UNIX ミリ秒） */
  now: number;
}

export interface ExistingSheet {
  sheetId: number;
  title: string;
}

/** プロジェクトの表示順 → 完了予定（未設定は後ろ）→ チームキー → 番号 */
export function buildReport(input: ReportInput): Report {
  const projectOrder = new Map(input.projects.map((p, i) => [p.id, i]));
  const projectName = new Map(input.projects.map((p) => [p.id, p.name]));
  const issues = input.issues.filter((issue) => projectOrder.has(issue.projectId) && issue.stateType !== "canceled");
  issues.sort((a, b) => compareIssues(a, b, projectOrder));

  const byProject = new Map<string, ReportIssueInput[]>();
  for (const project of input.projects) byProject.set(project.id, []);
  for (const issue of issues) byProject.get(issue.projectId)?.push(issue);

  return {
    workspaceName: input.workspaceName,
    now: input.now,
    activities: input.projects.map((project) =>
      activityRow(project, byProject.get(project.id) ?? [], input.origin, input.urlKey, input.today),
    ),
    tasks: issues.map((issue) => taskRow(issue, projectName.get(issue.projectId) ?? "", input.origin, input.urlKey)),
  };
}

/**
 * spreadsheets.batchUpdate の requests。
 * 活動一覧・WBS 以外のタブは変更しない。無ければ addSheet（index 0 と 1）する。
 * 空セルは {}。fields に userEnteredValue,userEnteredFormat を指定しているので、値と書式が消える。
 */
export function buildSheetRequests(report: Report, existing: ExistingSheet[]): object[] {
  const used = new Set(existing.map((sheet) => sheet.sheetId));
  const activity = resolveSheet(existing, ACTIVITY_TAB, ACTIVITY_SHEET_ID, used);
  const wbs = resolveSheet(existing, WBS_TAB, WBS_SHEET_ID, used);
  const requests: object[] = [];
  appendSheet(requests, {
    ...activity,
    tabTitle: ACTIVITY_TAB,
    index: 0,
    widths: ACTIVITY_WIDTHS,
    rows: sheetRows(report, `${report.workspaceName}｜活動報告`, ACTIVITY_HEADERS, activityCells(report), "プロジェクトがありません"),
  });
  appendSheet(requests, {
    ...wbs,
    tabTitle: WBS_TAB,
    index: 1,
    widths: WBS_WIDTHS,
    rows: sheetRows(report, `${report.workspaceName}｜WBS`, WBS_HEADERS, taskCells(report), "課題がありません"),
  });
  return requests;
}

function compareIssues(a: ReportIssueInput, b: ReportIssueInput, projectOrder: Map<string, number>): number {
  const byProject = (projectOrder.get(a.projectId) ?? 0) - (projectOrder.get(b.projectId) ?? 0);
  if (byProject !== 0) return byProject;
  const byDue = compareDue(a.dueDate, b.dueDate);
  if (byDue !== 0) return byDue;
  const ak = splitIdentifier(a.identifier);
  const bk = splitIdentifier(b.identifier);
  if (ak.key !== bk.key) return ak.key < bk.key ? -1 : 1;
  return ak.num - bk.num;
}

function compareDue(a: string | null, b: string | null): number {
  if (!a && !b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** 'ENG-12' → チームキーと番号。番号の区切りは最後の '-' */
function splitIdentifier(identifier: string): { key: string; num: number } {
  const i = identifier.lastIndexOf("-");
  if (i < 0) return { key: identifier, num: 0 };
  const num = Number(identifier.slice(i + 1));
  return { key: identifier.slice(0, i), num: Number.isFinite(num) ? num : 0 };
}

function activityRow(
  project: { id: string; name: string },
  tasks: ReportIssueInput[],
  origin: string | null,
  urlKey: string,
  today: string,
): ActivityRow {
  return {
    activity: {
      text: project.name,
      url: origin ? `${origin}/${urlKey}/project/${project.id}` : null,
    },
    nextDue: nextDue(tasks),
    completionRate: completionRate(tasks),
    status: activityStatus(tasks, today),
    id: project.id,
  };
}

function taskRow(issue: ReportIssueInput, projectName: string, origin: string | null, urlKey: string): TaskRow {
  return {
    activity: projectName,
    process: processLabel(issue.labelNames),
    work: {
      text: `${issue.identifier} ${issue.title}`,
      url: origin ? `${origin}/${urlKey}/issue/${issue.identifier}` : null,
    },
    description: clipDescription(issue.descriptionText),
    assignee: issue.assigneeName ?? "",
    startedOn: slashDate(issue.startedOn),
    dueDate: slashDate(issue.dueDate),
    state: issue.stateName,
    completedOn: issue.stateType === "completed" ? slashDate(issue.completedOn) : "",
    priority: PRIORITIES.find((p) => p.value === issue.priority)?.short ?? "なし",
    id: issue.id,
  };
}

/** `工程:` または `工程：` で始まるラベルの接頭辞を除き、名前順に `／` でつなぐ */
function processLabel(labelNames: string[]): string {
  const names: string[] = [];
  for (const name of labelNames) {
    const matched = PROCESS_PREFIX.exec(name);
    if (!matched) continue;
    const body = matched[1].trim();
    if (body) names.push(body);
  }
  names.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return names.join("／");
}

function clipDescription(text: string): string {
  const chars = Array.from(text);
  if (chars.length <= DESCRIPTION_MAX) return text;
  return `${chars.slice(0, DESCRIPTION_MAX - 1).join("")}…`;
}

function slashDate(ymd: string | null): string {
  return ymd ? ymd.replaceAll("-", "/") : "";
}

/** 完了以外が未完了。保留は backlog。active は未完了のうち保留でないもの */
function partition(tasks: ReportIssueInput[]) {
  const open = tasks.filter((task) => task.stateType !== "completed");
  const active = open.filter((task) => task.stateType !== "backlog");
  const done = tasks.length - open.length;
  return { open, active, done };
}

function completionRate(tasks: ReportIssueInput[]): string {
  if (tasks.length === 0) return "タスクなし";
  const { done } = partition(tasks);
  const pct = Math.floor((done * 100) / tasks.length);
  return `${pct}%（${done}/${tasks.length}）`;
}

function nextDue(tasks: ReportIssueInput[]): string {
  const { open, active } = partition(tasks);
  if (tasks.length === 0 || open.length === 0 || active.length === 0) return "—";
  const dated = active.filter((task) => task.dueDate);
  if (dated.length === 0) return "期限未設定";
  const earliest = dated.map((task) => task.dueDate!).sort()[0];
  const unset = active.length - dated.length;
  const text = slashDate(earliest);
  return unset > 0 ? `${text}（未設定${unset}件）` : text;
}

function activityStatus(tasks: ReportIssueInput[], today: string): ActivityStatus {
  if (tasks.length === 0) return "タスク未登録";
  const { open, active } = partition(tasks);
  if (open.length === 0) return "完了";
  if (active.some((task) => task.dueDate && task.dueDate < today)) return "期限超過";
  if (open.some((task) => task.stateType === "backlog")) return "保留あり";
  if (open.some((task) => task.stateType === "started")) return "進行中";
  return "未着手";
}

// ---- Sheets API リクエスト ----

interface Rgb {
  red: number;
  green: number;
  blue: number;
}

interface CellFormat {
  textFormat?: { bold?: boolean; fontSize?: number; foregroundColor?: Rgb };
  backgroundColor?: Rgb;
  wrapStrategy?: "CLIP";
}

interface CellData {
  userEnteredValue?: { stringValue: string } | { formulaValue: string };
  userEnteredFormat?: CellFormat;
}

function rgb(hex: string): Rgb {
  const n = Number.parseInt(hex, 16);
  return { red: ((n >> 16) & 255) / 255, green: ((n >> 8) & 255) / 255, blue: (n & 255) / 255 };
}

const TITLE_FORMAT: CellFormat = { textFormat: { bold: true, fontSize: 14 } };
const GRAY_FORMAT: CellFormat = { textFormat: { foregroundColor: rgb("5f6368") } };
const HEADER_FORMAT: CellFormat = { textFormat: { bold: true }, backgroundColor: rgb("f1f3f4") };
const CLIP: CellFormat = { wrapStrategy: "CLIP" };
const OVERDUE_FORMAT: CellFormat = {
  wrapStrategy: "CLIP",
  textFormat: { bold: true, foregroundColor: rgb("d93025") },
};
const HOLD_FORMAT: CellFormat = {
  wrapStrategy: "CLIP",
  textFormat: { bold: true, foregroundColor: rgb("e37400") },
};

function blankCell(): CellData {
  return {};
}

function textCell(value: string, format: CellFormat): CellData {
  return { userEnteredValue: { stringValue: value }, userEnteredFormat: format };
}

function linkCell(link: ReportLink, format: CellFormat): CellData {
  if (!link.url) return textCell(link.text, format);
  const esc = (s: string) => s.replaceAll('"', '""');
  return {
    userEnteredValue: { formulaValue: `=HYPERLINK("${esc(link.url)}","${esc(link.text)}")` },
    userEnteredFormat: format,
  };
}

/** 日本時間の `YYYY/MM/DD HH:mm`。shared/dates と同じ UTC+9 */
function formatJstDateTime(now: number): string {
  const jst = new Date(now + JST_OFFSET_MS);
  const hh = String(jst.getUTCHours()).padStart(2, "0");
  const mm = String(jst.getUTCMinutes()).padStart(2, "0");
  return `${dateToYmd(jst).replaceAll("-", "/")} ${hh}:${mm}`;
}

function statusFormat(status: ActivityStatus): CellFormat {
  if (status === "期限超過") return OVERDUE_FORMAT;
  if (status === "保留あり") return HOLD_FORMAT;
  return CLIP;
}

function activityCells(report: Report): CellData[][] {
  return report.activities.map((row) => [
    linkCell(row.activity, CLIP),
    textCell(row.nextDue, CLIP),
    textCell(row.completionRate, CLIP),
    textCell(row.status, statusFormat(row.status)),
    textCell(row.id, CLIP),
  ]);
}

function taskCells(report: Report): CellData[][] {
  return report.tasks.map((row) => [
    textCell(row.activity, CLIP),
    textCell(row.process, CLIP),
    linkCell(row.work, CLIP),
    textCell(row.description, CLIP),
    textCell(row.assignee, CLIP),
    textCell(row.startedOn, CLIP),
    textCell(row.dueDate, CLIP),
    textCell(row.state, CLIP),
    textCell(row.completedOn, CLIP),
    textCell(row.priority, CLIP),
    textCell(row.id, CLIP),
  ]);
}

function sheetRows(report: Report, banner: string, headers: string[], data: CellData[][], emptyText: string): CellData[][] {
  const cols = headers.length;
  const preface: CellData[][] = [
    pad([textCell(banner, TITLE_FORMAT)], cols),
    pad([textCell(`最終反映 ${formatJstDateTime(report.now)}`, GRAY_FORMAT)], cols),
    pad([textCell(NOTE, GRAY_FORMAT)], cols),
    pad([], cols),
    pad(
      headers.map((header) => textCell(header, HEADER_FORMAT)),
      cols,
    ),
  ];
  const body = data.length === 0 ? [pad([textCell(emptyText, CLIP)], cols)] : data.map((row) => pad(row, cols));
  return [...preface, ...body];
}

function pad(cells: CellData[], cols: number): CellData[] {
  const out = cells.slice(0, cols);
  while (out.length < cols) out.push(blankCell());
  return out;
}

/** 同名のタブがあればその sheetId。無ければ希望 ID、使われていれば次の空き番号 */
function resolveSheet(
  existing: ExistingSheet[],
  title: string,
  preferred: number,
  used: Set<number>,
): { sheetId: number; create: boolean } {
  const found = existing.find((sheet) => sheet.title === title);
  if (found) return { sheetId: found.sheetId, create: false };
  let id = preferred;
  while (used.has(id)) id += 1;
  used.add(id);
  return { sheetId: id, create: true };
}

function appendSheet(
  requests: object[],
  sheet: {
    create: boolean;
    tabTitle: string;
    sheetId: number;
    index: number;
    widths: number[];
    rows: CellData[][];
  },
): void {
  if (sheet.create) {
    requests.push({
      addSheet: { properties: { sheetId: sheet.sheetId, title: sheet.tabTitle, index: sheet.index } },
    });
  }
  const columnCount = sheet.rows[0]?.length ?? sheet.widths.length + 1;
  requests.push({
    updateSheetProperties: {
      properties: {
        sheetId: sheet.sheetId,
        gridProperties: { rowCount: sheet.rows.length, columnCount, frozenRowCount: HEADER_ROW_COUNT },
      },
      fields: "gridProperties.rowCount,gridProperties.columnCount,gridProperties.frozenRowCount",
    },
  });
  requests.push({
    updateCells: {
      start: { sheetId: sheet.sheetId, rowIndex: 0, columnIndex: 0 },
      rows: sheet.rows.map((values) => ({ values })),
      fields: "userEnteredValue,userEnteredFormat",
    },
  });
  // endIndex は含まない。ID 列（最後）の幅は指定しない
  sheet.widths.forEach((pixelSize, startIndex) => {
    requests.push({
      updateDimensionProperties: {
        range: { sheetId: sheet.sheetId, dimension: "COLUMNS", startIndex, endIndex: startIndex + 1 },
        properties: { pixelSize },
        fields: "pixelSize",
      },
    });
  });
  const idColumn = columnCount - 1;
  requests.push({
    updateDimensionProperties: {
      range: { sheetId: sheet.sheetId, dimension: "COLUMNS", startIndex: idColumn, endIndex: idColumn + 1 },
      properties: { hiddenByUser: true },
      fields: "hiddenByUser",
    },
  });
}
