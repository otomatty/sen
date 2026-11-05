// Webhook から Durable Object へ渡す出来事。
// 次の段階で使うフィールドだけを残す（Durable Object の値の上限と、本文に secret が無いことの両方のため）。

export interface GitHubCommentEvent {
  action: "created";
  comment: { id: number; body: string; html_url: string; created_at: string; user: { login: string } | null };
  issue: { number: number };
  repository: { id: number; full_name: string };
  sender: { login: string } | null;
}

export interface GitHubPullEvent {
  action: string;
  pull_request: {
    number: number;
    title: string;
    body: string | null;
    html_url: string;
    state: string;
    draft: boolean;
    merged: boolean;
    user: { login: string } | null;
    head: { ref: string };
  };
  repository: { id: number; full_name: string };
  sender: { login: string } | null;
}

export type GitHubIncoming =
  | { type: "issue"; repoId: number; number: number }
  | { type: "comment"; repoId: number; number: number; githubCommentId: number; payload: GitHubCommentEvent }
  | { type: "pull"; repoId: number; number: number; payload: GitHubPullEvent };
