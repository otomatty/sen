// E2E 用の模擬 GitHub。必要な REST をメモリ上で再現し、受けたリクエストを記録する。
// 次の段階の課題・コメントの同期テストからも使える。

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

export const GITHUB_PORT = Number(process.env.E2E_GITHUB_PORT ?? 4339);
export const GITHUB_TOKEN = "e2e-github-token";

export interface MockRepo {
  id: number;
  full_name: string;
  has_issues: boolean;
}

export interface MockHook {
  id: number;
  fullName: string;
  url: string;
  events: string[];
  secret: string;
  contentType: string;
  active: boolean;
}

export interface MockIssue {
  id: number;
  number: number;
  fullName: string;
  title: string;
  body: string | null;
  state: "open" | "closed";
  state_reason: string | null;
  labels: { name: string }[];
  assignees: { login: string }[];
  created_at: string;
  updated_at: string;
  /** PR を Issue の一覧に出すときだけ。無い Issue の応答には含めない */
  draft?: boolean;
  pull_request?: unknown;
  /** POST で作ったときはトークンのユーザー。テストが足した Issue は省略できる */
  user?: { login: string };
}

export interface MockComment {
  id: number;
  fullName: string;
  number: number;
  body: string;
  user: { login: string };
  created_at: string;
  updated_at: string;
}

export interface MockPull {
  id: number;
  number: number;
  fullName: string;
  title: string;
  body: string | null;
  state: "open" | "closed";
  draft: boolean;
  merged: boolean;
  user: { login: string } | null;
  headRef: string;
  updated_at: string;
  /** true のときだけ、Issue の一覧にも pull_request 付きで出す */
  asIssue?: boolean;
}

export interface RecordedRequest {
  method: string;
  path: string;
  search: string;
  body: unknown;
}

export interface OnceRule {
  method: string;
  suffix: string;
}

/** 一致するリクエストの応答を、gate が解決するまで止める */
export interface GitHubHold {
  method: string;
  path: string;
  entered: () => void;
  gate: Promise<void>;
}

/** 一致するリクエストを、一度だけこの応答にする */
export interface ForcedResponse {
  method: string;
  suffix: string;
  status: number;
  headers?: Record<string, string>;
  body?: unknown;
}

export const githubMock = {
  login: "sen-bot",
  repos: new Map<string, MockRepo>(),
  hooks: [] as MockHook[],
  issues: [] as MockIssue[],
  pulls: [] as MockPull[],
  comments: [] as MockComment[],
  labels: new Map<string, { name: string }[]>(),
  requests: [] as RecordedRequest[],
  /** POST /hooks が返すステータス。201 以外（403 など）のときは作らない */
  hookStatus: 201,
  /** 担当者を含む作成・更新を 422 で断る */
  rejectAssignees: false,
  /** 次の一致するリクエストを 500 で一度だけ断る。資源は作らない */
  failOnce: null as OnceRule | null,
  /** 次の一致する成功応答の本文を一度だけ空にする。資源は作る */
  loseOnce: null as OnceRule | null,
  /** 次の一致するリクエストを、gate まで止める。一致したら外れる */
  hold: null as GitHubHold | null,
  /** 次の一致するリクエストを、一度だけこのステータスとヘッダーで返す */
  respondOnce: null as ForcedResponse | null,
  nextRepoId: 1000,
  nextHookId: 1,
  nextIssueId: 1,
  nextPullId: 1,
  nextCommentId: 1,
};

export function resetGitHubMock() {
  githubMock.login = "sen-bot";
  githubMock.repos.clear();
  githubMock.hooks = [];
  githubMock.issues = [];
  githubMock.pulls = [];
  githubMock.comments = [];
  githubMock.labels.clear();
  githubMock.requests = [];
  githubMock.hookStatus = 201;
  githubMock.rejectAssignees = false;
  githubMock.failOnce = null;
  githubMock.loseOnce = null;
  githubMock.hold = null;
  githubMock.respondOnce = null;
  githubMock.nextRepoId = 1000;
  githubMock.nextHookId = 1;
  githubMock.nextIssueId = 1;
  githubMock.nextPullId = 1;
  githubMock.nextCommentId = 1;
  addGitHubRepo("acme/widgets");
}

export function addGitHubRepo(fullName: string, opts: { hasIssues?: boolean; id?: number } = {}): MockRepo {
  const repo: MockRepo = {
    id: opts.id ?? githubMock.nextRepoId++,
    full_name: fullName,
    has_issues: opts.hasIssues !== false,
  };
  githubMock.repos.set(fullName.toLowerCase(), repo);
  return repo;
}

export function startGitHubMock(): Promise<Server> {
  const server = createServer((req, res) => {
    void handle(req, res).catch((err) => {
      console.error("mock github failed", err instanceof Error ? err.name : "error");
      if (!res.headersSent) sendJson(res, 500, { message: "mock failure" });
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(GITHUB_PORT, "127.0.0.1", () => {
      server.off("error", reject);
      resolve(server);
    });
  });
}

async function handle(req: IncomingMessage, res: ServerResponse) {
  const method = req.method ?? "GET";
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${GITHUB_PORT}`);
  const send = (status: number, body: unknown) => sendJson(res, status, body, { method, path: url.pathname });
  const bodyText = await readBody(req);
  let body: unknown = null;
  if (bodyText) {
    try {
      body = JSON.parse(bodyText) as unknown;
    } catch {
      body = bodyText;
    }
  }
  githubMock.requests.push({ method: req.method ?? "GET", path: url.pathname, search: url.search, body });

  if (req.headers.authorization !== `Bearer ${GITHUB_TOKEN}`) {
    send(401, { message: "Bad credentials" });
    return;
  }
  if (req.headers.accept !== "application/vnd.github+json") {
    send(400, { message: "accept" });
    return;
  }
  if (consumeOnce(githubMock.failOnce, method, url.pathname)) {
    githubMock.failOnce = null;
    send(500, { message: "temporary" });
    return;
  }
  const forced = githubMock.respondOnce;
  if (forced && forced.method === method && url.pathname.endsWith(forced.suffix)) {
    githubMock.respondOnce = null;
    sendJson(res, forced.status, forced.body ?? { message: "forced" }, undefined, forced.headers);
    return;
  }

  if (req.method === "GET" && url.pathname === "/user") {
    send(200, { login: githubMock.login });
    return;
  }

  const repoMatch = /^\/repos\/([^/]+)\/([^/]+)$/.exec(url.pathname);
  if (req.method === "GET" && repoMatch) {
    const repo = findRepo(repoMatch[1], repoMatch[2]);
    if (!repo) {
      send(404, { message: "Not Found" });
      return;
    }
    send(200, repo);
    return;
  }

  const sub = /^\/repos\/([^/]+)\/([^/]+)\/(.+)$/.exec(url.pathname);
  if (!sub) {
    send(404, { message: "Not Found" });
    return;
  }
  const repo = findRepo(sub[1], sub[2]);
  if (!repo) {
    send(404, { message: "Not Found" });
    return;
  }
  const fullName = repo.full_name;
  const rest = sub[3];

  if (req.method === "GET" && rest === "labels") {
    const labels = githubMock.labels.get(fullName.toLowerCase()) ?? [];
    const page = Number(url.searchParams.get("page") ?? "1");
    send(200, page > 1 ? [] : labels);
    return;
  }

  if (req.method === "POST" && rest === "hooks") {
    if (githubMock.hookStatus !== 201) {
      send(githubMock.hookStatus, { message: "Resource not accessible by integration" });
      return;
    }
    const input = body as { events?: string[]; config?: { url?: string; secret?: string; content_type?: string } };
    const hook: MockHook = {
      id: githubMock.nextHookId++,
      fullName,
      url: input.config?.url ?? "",
      events: input.events ?? [],
      secret: input.config?.secret ?? "",
      contentType: input.config?.content_type ?? "",
      active: true,
    };
    githubMock.hooks.push(hook);
    send(201, { id: hook.id, active: true, events: hook.events, config: input.config ?? {} });
    return;
  }

  const hookId = /^hooks\/(\d+)$/.exec(rest);
  if (req.method === "DELETE" && hookId) {
    const id = Number(hookId[1]);
    githubMock.hooks = githubMock.hooks.filter((hook) => !(hook.id === id && hook.fullName.toLowerCase() === fullName.toLowerCase()));
    res.writeHead(204);
    res.end();
    return;
  }

  if (rest === "issues" && req.method === "GET") {
    const since = url.searchParams.get("since");
    const creator = url.searchParams.get("creator");
    const name = fullName.toLowerCase();
    const list = [
      ...githubMock.issues.filter(
        (issue) =>
          issue.fullName.toLowerCase() === name &&
          updatedSince(issue.updated_at, since) &&
          (!creator || issue.user?.login.toLowerCase() === creator.toLowerCase()),
      ),
      ...githubMock.pulls
        .filter(
          (pull) =>
            pull.asIssue === true &&
            pull.fullName.toLowerCase() === name &&
            updatedSince(pull.updated_at, since) &&
            (!creator || pull.user?.login.toLowerCase() === creator.toLowerCase()),
        )
        .map(issueFromPull),
    ];
    send(200, pageSlice(sortByUpdated(list, url), url).map(issueJson));
    return;
  }
  if (rest === "issues" && req.method === "POST") {
    const input = body as { title?: string; body?: string; state?: "open" | "closed"; state_reason?: string | null; labels?: unknown; assignees?: unknown };
    if (rejectedAssignees(input.assignees)) {
      send(422, { message: "Validation Failed" });
      return;
    }
    const number = githubMock.issues.filter((issue) => issue.fullName.toLowerCase() === fullName.toLowerCase()).reduce((max, issue) => Math.max(max, issue.number), 0) + 1;
    const now = new Date().toISOString();
    const issue: MockIssue = {
      id: githubMock.nextIssueId++,
      number,
      fullName,
      title: input.title ?? "",
      body: input.body ?? null,
      state: input.state === "closed" ? "closed" : "open",
      state_reason: input.state_reason ?? null,
      labels: labelList(input.labels),
      assignees: assigneeList(input.assignees),
      created_at: now,
      updated_at: now,
      user: { login: githubMock.login },
    };
    githubMock.issues.push(issue);
    await pauseIfHeld(method, url.pathname);
    send(201, issueJson(issue));
    return;
  }

  const issueMatch = /^issues\/(\d+)$/.exec(rest);
  if (issueMatch && req.method === "GET") {
    await pauseIfHeld(method, url.pathname);
    const issue = findIssue(fullName, Number(issueMatch[1]));
    if (!issue) {
      send(404, { message: "Not Found" });
      return;
    }
    send(200, issueJson(issue));
    return;
  }
  if (issueMatch && req.method === "PATCH") {
    const issue = findIssue(fullName, Number(issueMatch[1]));
    if (!issue) {
      send(404, { message: "Not Found" });
      return;
    }
    const input = body as { title?: string; body?: string; state?: "open" | "closed"; state_reason?: string | null; labels?: unknown; assignees?: unknown };
    if (rejectedAssignees(input.assignees)) {
      send(422, { message: "Validation Failed" });
      return;
    }
    if (typeof input.title === "string") issue.title = input.title;
    if ("body" in input) issue.body = input.body ?? null;
    if (input.state) issue.state = input.state;
    if ("state_reason" in input) issue.state_reason = input.state_reason ?? null;
    if ("labels" in input) issue.labels = labelList(input.labels);
    if ("assignees" in input) issue.assignees = assigneeList(input.assignees);
    issue.updated_at = new Date().toISOString();
    send(200, issueJson(issue));
    return;
  }

  const commentPost = /^issues\/(\d+)\/comments$/.exec(rest);
  if (commentPost && req.method === "GET") {
    const since = url.searchParams.get("since");
    const number = Number(commentPost[1]);
    const list = sortByUpdated(
      githubMock.comments.filter(
        (comment) =>
          comment.fullName.toLowerCase() === fullName.toLowerCase() &&
          comment.number === number &&
          updatedSince(comment.updated_at, since),
      ),
      url,
    );
    send(200, pageSlice(list, url).map(commentJson));
    return;
  }
  if (commentPost && req.method === "POST") {
    const input = body as { body?: string };
    const now = new Date().toISOString();
    const comment: MockComment = {
      id: githubMock.nextCommentId++,
      fullName,
      number: Number(commentPost[1]),
      body: input.body ?? "",
      user: { login: githubMock.login },
      created_at: now,
      updated_at: now,
    };
    githubMock.comments.push(comment);
    send(201, { ...comment, html_url: `https://github.com/${fullName}/issues/${comment.number}#issuecomment-${comment.id}` });
    return;
  }

  const pullMatch = /^pulls\/(\d+)$/.exec(rest);
  if (pullMatch && req.method === "GET") {
    const pull = githubMock.pulls.find((item) => item.fullName.toLowerCase() === fullName.toLowerCase() && item.number === Number(pullMatch[1]));
    if (!pull) {
      send(404, { message: "Not Found" });
      return;
    }
    send(200, pullJson(pull));
    return;
  }

  if (rest === "pulls" && req.method === "GET") {
    const list = sortByUpdated(
      githubMock.pulls.filter((pull) => pull.fullName.toLowerCase() === fullName.toLowerCase()),
      url,
      "desc",
    );
    send(200, pageSlice(list, url).map(pullJson));
    return;
  }

  if (rest === "issues/comments" && req.method === "GET") {
    const since = url.searchParams.get("since");
    const list = sortByUpdated(
      githubMock.comments.filter((comment) => comment.fullName.toLowerCase() === fullName.toLowerCase() && updatedSince(comment.updated_at, since)),
      url,
    );
    send(200, pageSlice(list, url).map(commentJson));
    return;
  }

  send(404, { message: "Not Found" });
}

function findRepo(owner: string, repo: string): MockRepo | undefined {
  return githubMock.repos.get(`${owner}/${repo}`.toLowerCase());
}

function findIssue(fullName: string, number: number): MockIssue | undefined {
  return githubMock.issues.find((issue) => issue.fullName.toLowerCase() === fullName.toLowerCase() && issue.number === number);
}

function rejectedAssignees(value: unknown): boolean {
  return githubMock.rejectAssignees && assigneeList(value).length > 0;
}

function labelList(value: unknown): { name: string }[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string").map((name) => ({ name }));
}

function assigneeList(value: unknown): { login: string }[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string").map((login) => ({ login }));
}

function pageSlice<T>(items: T[], url: URL): T[] {
  const page = Number(url.searchParams.get("page") ?? "1");
  const perPage = Number(url.searchParams.get("per_page") ?? "30");
  const size = Number.isFinite(perPage) && perPage > 0 ? Math.min(perPage, 100) : 30;
  const p = Number.isFinite(page) && page > 0 ? page : 1;
  return items.slice((p - 1) * size, (p - 1) * size + size);
}

function sortByUpdated<T extends { updated_at: string; number?: number; id?: number }>(items: T[], url: URL, fallback: "asc" | "desc" = "asc"): T[] {
  if (url.searchParams.get("sort") !== "updated" && url.searchParams.get("direction") == null && fallback === "asc") return items;
  const direction = url.searchParams.get("direction") === "desc" || (url.searchParams.get("direction") == null && fallback === "desc") ? -1 : 1;
  return [...items].sort((a, b) => {
    if (a.updated_at < b.updated_at) return -1 * direction;
    if (a.updated_at > b.updated_at) return 1 * direction;
    return ((a.number ?? a.id ?? 0) - (b.number ?? b.id ?? 0)) * direction;
  });
}

async function pauseIfHeld(method: string, path: string): Promise<void> {
  const hold = githubMock.hold;
  if (!hold || hold.method !== method || hold.path !== path) return;
  githubMock.hold = null;
  hold.entered();
  await hold.gate;
}

function updatedSince(updated: string, since: string | null): boolean {
  if (!since) return true;
  const from = Date.parse(since);
  const at = Date.parse(updated);
  if (!Number.isFinite(from)) return true;
  return Number.isFinite(at) && at >= from;
}

function commentJson(comment: MockComment) {
  return {
    ...comment,
    html_url: `https://github.com/${comment.fullName}/issues/${comment.number}#issuecomment-${comment.id}`,
    issue_url: `https://api.github.com/repos/${comment.fullName}/issues/${comment.number}`,
  };
}

function pullJson(pull: MockPull) {
  return {
    number: pull.number,
    title: pull.title,
    body: pull.body,
    html_url: `https://github.com/${pull.fullName}/pull/${pull.number}`,
    state: pull.state,
    draft: pull.draft,
    merged: pull.merged,
    merged_at: pull.merged ? pull.updated_at : null,
    user: pull.user,
    head: { ref: pull.headRef },
    updated_at: pull.updated_at,
  };
}

function issueFromPull(pull: MockPull): MockIssue {
  return {
    id: pull.id,
    number: pull.number,
    fullName: pull.fullName,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    state_reason: null,
    labels: [],
    assignees: [],
    created_at: pull.updated_at,
    updated_at: pull.updated_at,
    ...(pull.user ? { user: pull.user } : {}),
    draft: pull.draft,
    pull_request: { merged_at: pull.merged ? pull.updated_at : null },
  };
}

function issueJson(issue: MockIssue) {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    state_reason: issue.state_reason,
    html_url: `https://github.com/${issue.fullName}/issues/${issue.number}`,
    labels: issue.labels,
    assignees: issue.assignees,
    created_at: issue.created_at,
    updated_at: issue.updated_at,
    ...(issue.user ? { user: issue.user } : {}),
    ...(typeof issue.draft === "boolean" ? { draft: issue.draft } : {}),
    ...(issue.pull_request ? { pull_request: issue.pull_request } : {}),
  };
}

function consumeOnce(rule: OnceRule | null, method: string, path: string): boolean {
  return !!rule && rule.method === method && path.endsWith(rule.suffix);
}

function sendJson(res: ServerResponse, status: number, body: unknown, route?: { method: string; path: string }, headers?: Record<string, string>) {
  const head: Record<string, string> = { "content-type": "application/json; charset=utf-8", ...headers };
  if (route && status >= 200 && status < 300 && consumeOnce(githubMock.loseOnce, route.method, route.path)) {
    githubMock.loseOnce = null;
    res.writeHead(status, head);
    res.end();
    return;
  }
  res.writeHead(status, head);
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}
