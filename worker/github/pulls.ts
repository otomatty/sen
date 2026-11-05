// プルリクエストの参照の取り出し。DB も fetch も使わない（テストが移行 SQL を読まないように、書き込みは pull-sync.ts）。
// コードブロックと行内コード（字句解析の code / codespan）の中の参照は見ない。

import { createMarked } from "../../shared/markdown";
import type { GitHubPullState } from "../../shared/types";
import type { GhPull } from "./api";
import type { GitHubPullEvent } from "./events";

const ISSUE_ID = /(?<![A-Za-z0-9])([A-Za-z][A-Za-z0-9]{0,6})-(\d{1,9})(?![A-Za-z0-9])/g;
const GH_CROSS = /(?<![A-Za-z0-9])([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#(\d{1,9})(?!\d)/g;
const GH_SAME = /(?<![A-Za-z0-9])#(\d{1,9})(?!\d)/g;

export interface PullIssueRef {
  /** チームの識別子（大文字） */
  key: string;
  number: number;
}

export interface PullGitHubRef {
  /** null はプルリクエストと同じリポジトリ */
  repo: string | null;
  number: number;
}

interface MdToken {
  type: string;
  raw?: string;
  text?: string;
  tokens?: MdToken[];
  items?: MdToken[];
  header?: { tokens?: MdToken[] }[];
  rows?: { tokens?: MdToken[] }[][];
}

/** ブランチ名・タイトル・本文から課題 ID と GitHub の参照を取る。同じものは 1 つ */
export function extractPullReferences(
  input: { branch?: string | null; title?: string | null; body?: string | null },
  teamKeys: readonly string[],
): { issues: PullIssueRef[]; github: PullGitHubRef[] } {
  const keys = new Set(teamKeys.map((key) => key.trim().toUpperCase()).filter(Boolean));
  const issues: PullIssueRef[] = [];
  const seenIssues = new Set<string>();
  const addIssue = (text: string) => {
    for (const match of text.matchAll(ISSUE_ID)) {
      const key = match[1].toUpperCase();
      const number = Number(match[2]);
      if (!keys.has(key) || !Number.isInteger(number) || number < 1) continue;
      const id = `${key}-${number}`;
      if (seenIssues.has(id)) continue;
      seenIssues.add(id);
      issues.push({ key, number });
    }
  };
  addIssue(input.branch ?? "");
  const prose = [...searchableParts(input.title ?? ""), ...searchableParts(input.body ?? "")];
  for (const part of prose) addIssue(part);

  const github: PullGitHubRef[] = [];
  const seenGitHub = new Set<string>();
  const addGitHub = (ref: PullGitHubRef) => {
    if (!Number.isInteger(ref.number) || ref.number < 1) return;
    const id = `${ref.repo?.toLowerCase() ?? ""}#${ref.number}`;
    if (seenGitHub.has(id)) return;
    seenGitHub.add(id);
    github.push(ref);
  };
  for (const part of prose) {
    const found: { index: number; ref: PullGitHubRef }[] = [];
    for (const match of part.matchAll(GH_CROSS)) found.push({ index: match.index ?? 0, ref: { repo: `${match[1]}/${match[2]}`, number: Number(match[3]) } });
    for (const match of part.matchAll(GH_SAME)) found.push({ index: match.index ?? 0, ref: { repo: null, number: Number(match[1]) } });
    found.sort((a, b) => a.index - b.index);
    for (const item of found) addGitHub(item.ref);
  }
  return { issues, github };
}

/** open で draft → draft、open → open、closed で merged → merged、closed → closed */
export function pullLinkState(pull: { state?: string | null; draft?: boolean; merged?: boolean }): GitHubPullState {
  if ((pull.state ?? "").toLowerCase() === "closed") return pull.merged ? "merged" : "closed";
  return pull.draft ? "draft" : "open";
}

/** 一覧 API の PR を、Webhook と同じ形にする。番号が無ければ null */
export function toPullEvent(repo: { id: number; full_name: string }, pull: GhPull): GitHubPullEvent | null {
  if (!pull || !Number.isSafeInteger(pull.number) || pull.number < 1) return null;
  const login = typeof pull.user?.login === "string" && pull.user.login ? pull.user.login : "";
  const merged = pull.merged === true || (typeof pull.merged_at === "string" && pull.merged_at.length > 0);
  return {
    action: "edited",
    pull_request: {
      number: pull.number,
      title: typeof pull.title === "string" ? pull.title : "",
      body: typeof pull.body === "string" ? pull.body : null,
      html_url: typeof pull.html_url === "string" ? pull.html_url : "",
      state: typeof pull.state === "string" ? pull.state : "",
      draft: pull.draft === true,
      merged,
      user: login ? { login } : null,
      head: { ref: typeof pull.head?.ref === "string" ? pull.head.ref : "" },
    },
    repository: { id: repo.id, full_name: repo.full_name },
    sender: login ? { login } : null,
  };
}

/** コードの外だけ。見出しや箇条書きの記号は残し、コードの raw は渡さない */
function searchableParts(markdown: string): string[] {
  if (!markdown) return [];
  const out: string[] = [];
  walkTokens(createMarked().lexer(markdown) as MdToken[], out);
  return out;
}

function walkTokens(tokens: MdToken[] | undefined, out: string[]): void {
  if (!tokens) return;
  for (const token of tokens) {
    if (token.type === "code" || token.type === "codespan") continue;
    const children = token.tokens;
    const items = token.items;
    const header = token.header;
    const rows = token.rows;
    if (children?.length || items?.length || header?.length || rows?.length) {
      if (children?.length) walkTokens(children, out);
      if (items) for (const item of items) walkTokens(item.tokens, out);
      if (header) for (const cell of header) walkTokens(cell.tokens, out);
      if (rows) for (const row of rows) for (const cell of row) walkTokens(cell.tokens, out);
      continue;
    }
    const text = token.raw ?? token.text ?? "";
    if (text) out.push(text);
  }
}
