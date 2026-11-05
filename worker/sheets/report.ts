// 活動一覧と WBS の中身、および Sheets API の batchUpdate リクエストを作る純粋関数。
// 集計は shared/progress.ts。ここはシートの書式（セル・列幅・リンク）を足す。
// DB・fetch には依存しない（Playwright から直接 import して確かめる）。

import { dateToYmd } from "../../shared/dates";
import { summarizeProgress, type ActivityStatus, type ProgressTask, type ReportInput } from "../../shared/progress";

export type { ActivityStatus, ReportInput, ReportIssueInput } from "../../shared/progress";

const DESCRIPTION_MAX = 50_000;
const JST_OFFSET_MS = 540 * 60_000;

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

export interface ReportLink {
  text: string;
  url: string | null;
}

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
  const summary = summarizeProgress(input);
  const projectName = new Map(summary.activities.map((activity) => [activity.projectId, activity.name]));
  return {
    workspaceName: input.workspaceName,
    now: input.now,
    activities: summary.activities.map((activity) => ({
      activity: {
        text: activity.name,
        url: input.origin ? `${input.origin}/${input.urlKey}/project/${activity.projectId}` : null,
      },
      nextDue: activity.nextDue,
      completionRate: activity.completionRate,
      status: activity.status,
      id: activity.projectId,
    })),
    tasks: summary.tasks.map((task) => taskRow(task, projectName.get(task.projectId) ?? "", input.origin, input.urlKey)),
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

function taskRow(issue: ProgressTask, projectName: string, origin: string | null, urlKey: string): TaskRow {
  return {
    activity: projectName,
    process: issue.process,
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
    priority: issue.priorityLabel,
    id: issue.id,
  };
}

function clipDescription(text: string): string {
  const chars = Array.from(text);
  if (chars.length <= DESCRIPTION_MAX) return text;
  return `${chars.slice(0, DESCRIPTION_MAX - 1).join("")}…`;
}

function slashDate(ymd: string | null): string {
  return ymd ? ymd.replaceAll("-", "/") : "";
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
