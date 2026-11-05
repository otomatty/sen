// 活動一覧・WBS と同じ進捗集計。シートの書式（セル・列幅・リンク）には依存しない。
// ブラウザ（src/）と Worker の両方から使う。DB・fetch・実行環境固有の API には依存しない。

import { PRIORITIES } from "./constants";
import type { StateType } from "./types";

const PROCESS_PREFIX = /^工程[:：](.*)$/;

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

export type ActivityStatus = "タスク未登録" | "完了" | "期限超過" | "保留あり" | "進行中" | "未着手";

export interface ProgressTask extends ReportIssueInput {
  /** `工程:` / `工程：` ラベルの工程名。名前順・重複なし */
  processes: string[];
  /** 工程名を名前順に `／` でつないだもの。無ければ空。表示とシート用 */
  process: string;
  /** シートの優先度列と同じ短い表示名（なし / 緊急 / 高 / 中 / 低） */
  priorityLabel: string;
}

export interface ProgressActivity {
  projectId: string;
  name: string;
  /** 並び順はシートの WBS と同じ */
  tasks: ProgressTask[];
  total: number;
  done: number;
  /** 対象タスクが無いときは null。あるときは floor(done*100/total) */
  percent: number | null;
  /** シートと同じ文字列。'28%（2/7）' / 'タスクなし' */
  completionRate: string;
  /** 保留でない未完了のうち一番早い完了予定 'YYYY-MM-DD'。無ければ null */
  nextDueDate: string | null;
  /** 保留でない未完了のうち期限が無い件数 */
  nextDueUnset: number;
  /** シートと同じ文字列。'2026/11/07（未設定2件）' / '期限未設定' / '—' */
  nextDue: string;
  status: ActivityStatus;
}

/** floor(done*100/total)。total が 0 以下のときは 0 */
export function completionPercent(done: number, total: number): number {
  if (total <= 0) return 0;
  return Math.floor((done * 100) / total);
}

/** プロジェクトの表示順 → 完了予定（未設定は後ろ）→ チームキー → 番号。キャンセルは除く */
export function summarizeProgress(input: ReportInput): { activities: ProgressActivity[]; tasks: ProgressTask[] } {
  const projectOrder = new Map(input.projects.map((project, index) => [project.id, index]));
  const issues = input.issues.filter((issue) => projectOrder.has(issue.projectId) && issue.stateType !== "canceled");
  issues.sort((a, b) => compareIssues(a, b, projectOrder));

  const tasks: ProgressTask[] = issues.map((issue) => ({
    ...issue,
    processes: processNames(issue.labelNames),
    process: processLabel(issue.labelNames),
    priorityLabel: PRIORITIES.find((item) => item.value === issue.priority)?.short ?? "なし",
  }));

  const byProject = new Map<string, ProgressTask[]>();
  for (const project of input.projects) byProject.set(project.id, []);
  for (const task of tasks) byProject.get(task.projectId)?.push(task);

  return {
    activities: input.projects.map((project) => activityOf(project, byProject.get(project.id) ?? [], input.today)),
    tasks,
  };
}

function activityOf(project: { id: string; name: string }, tasks: ProgressTask[], today: string): ProgressActivity {
  const { open, active, done } = partition(tasks);
  const dated = active.flatMap((task) => (task.dueDate ? [task.dueDate] : []));
  dated.sort();
  const nextDueDate = dated[0] ?? null;
  const nextDueUnset = active.length - dated.length;
  const total = tasks.length;
  return {
    projectId: project.id,
    name: project.name,
    tasks,
    total,
    done,
    percent: total === 0 ? null : completionPercent(done, total),
    completionRate: total === 0 ? "タスクなし" : `${completionPercent(done, total)}%（${done}/${total}）`,
    nextDueDate,
    nextDueUnset,
    nextDue: formatNextDue(total, open.length, active.length, nextDueDate, nextDueUnset),
    status: activityStatus(tasks, today),
  };
}

function formatNextDue(total: number, open: number, active: number, nextDueDate: string | null, nextDueUnset: number): string {
  if (total === 0 || open === 0 || active === 0) return "—";
  if (!nextDueDate) return "期限未設定";
  const text = nextDueDate.replaceAll("-", "/");
  return nextDueUnset > 0 ? `${text}（未設定${nextDueUnset}件）` : text;
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

/** `工程:` または `工程：` の接頭辞を除いた工程名。空は除く */
function processBodies(labelNames: string[]): string[] {
  const names: string[] = [];
  for (const name of labelNames) {
    const matched = PROCESS_PREFIX.exec(name);
    if (!matched) continue;
    const body = matched[1].trim();
    if (body) names.push(body);
  }
  return names;
}

function byProcessName(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** 名前順・重複なし。絞り込みの候補と、選んだ工程が作業に含まれるかの判定に使う */
function processNames(labelNames: string[]): string[] {
  return [...new Set(processBodies(labelNames))].sort(byProcessName);
}

/** 名前順に `／` でつなぐ。重複も残す（シートの工程列はこの文字列のまま） */
function processLabel(labelNames: string[]): string {
  return processBodies(labelNames).sort(byProcessName).join("／");
}

/** 完了以外が未完了。保留は backlog。active は未完了のうち保留でないもの */
function partition(tasks: ReportIssueInput[]) {
  const open = tasks.filter((task) => task.stateType !== "completed");
  const active = open.filter((task) => task.stateType !== "backlog");
  const done = tasks.length - open.length;
  return { open, active, done };
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
