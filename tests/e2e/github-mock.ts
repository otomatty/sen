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
  pull_request?: unknown;
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

export interface RecordedRequest {
  method: string;
  path: string;
  body: unknown;
}

export const githubMock = {
  login: "sen-bot",
  repos: new Map<string, MockRepo>(),
  hooks: [] as MockHook[],
  issues: [] as MockIssue[],
  comments: [] as MockComment[],
  labels: new Map<string, { name: string }[]>(),
  requests: [] as RecordedRequest[],
  /** POST /hooks が返すステータス。201 以外（403 など）のときは作らない */
  hookStatus: 201,
  nextRepoId: 1000,
  nextHookId: 1,
  nextIssueId: 1,
  nextCommentId: 1,
};

export function resetGitHubMock() {
  githubMock.login = "sen-bot";
  githubMock.repos.clear();
  githubMock.hooks = [];
  githubMock.issues = [];
  githubMock.comments = [];
  githubMock.labels.clear();
  githubMock.requests = [];
  githubMock.hookStatus = 201;
  githubMock.nextRepoId = 1000;
  githubMock.nextHookId = 1;
  githubMock.nextIssueId = 1;
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
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${GITHUB_PORT}`);
  const bodyText = await readBody(req);
  let body: unknown = null;
  if (bodyText) {
    try {
      body = JSON.parse(bodyText) as unknown;
    } catch {
      body = bodyText;
    }
  }
  githubMock.requests.push({ method: req.method ?? "GET", path: url.pathname, body });

  if (req.headers.authorization !== `Bearer ${GITHUB_TOKEN}`) {
    sendJson(res, 401, { message: "Bad credentials" });
    return;
  }
  if (req.headers.accept !== "application/vnd.github+json") {
    sendJson(res, 400, { message: "accept" });
    return;
  }

  if (req.method === "GET" && url.pathname === "/user") {
    sendJson(res, 200, { login: githubMock.login });
    return;
  }

  const repoMatch = /^\/repos\/([^/]+)\/([^/]+)$/.exec(url.pathname);
  if (req.method === "GET" && repoMatch) {
    const repo = findRepo(repoMatch[1], repoMatch[2]);
    if (!repo) {
      sendJson(res, 404, { message: "Not Found" });
      return;
    }
    sendJson(res, 200, repo);
    return;
  }

  const sub = /^\/repos\/([^/]+)\/([^/]+)\/(.+)$/.exec(url.pathname);
  if (!sub) {
    sendJson(res, 404, { message: "Not Found" });
    return;
  }
  const repo = findRepo(sub[1], sub[2]);
  if (!repo) {
    sendJson(res, 404, { message: "Not Found" });
    return;
  }
  const fullName = repo.full_name;
  const rest = sub[3];

  if (req.method === "GET" && rest === "labels") {
    const labels = githubMock.labels.get(fullName.toLowerCase()) ?? [];
    const page = Number(url.searchParams.get("page") ?? "1");
    sendJson(res, 200, page > 1 ? [] : labels);
    return;
  }

  if (req.method === "POST" && rest === "hooks") {
    if (githubMock.hookStatus !== 201) {
      sendJson(res, githubMock.hookStatus, { message: "Resource not accessible by integration" });
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
    sendJson(res, 201, { id: hook.id, active: true, events: hook.events, config: input.config ?? {} });
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
    const page = Number(url.searchParams.get("page") ?? "1");
    const list = page > 1 ? [] : githubMock.issues.filter((issue) => issue.fullName.toLowerCase() === fullName.toLowerCase());
    sendJson(res, 200, list.map(issueJson));
    return;
  }
  if (rest === "issues" && req.method === "POST") {
    const input = body as { title?: string; body?: string };
    const number = githubMock.issues.filter((issue) => issue.fullName.toLowerCase() === fullName.toLowerCase()).length + 1;
    const now = new Date().toISOString();
    const issue: MockIssue = {
      id: githubMock.nextIssueId++,
      number,
      fullName,
      title: input.title ?? "",
      body: input.body ?? null,
      state: "open",
      state_reason: null,
      labels: [],
      assignees: [],
      created_at: now,
      updated_at: now,
    };
    githubMock.issues.push(issue);
    sendJson(res, 201, issueJson(issue));
    return;
  }

  const issueMatch = /^issues\/(\d+)$/.exec(rest);
  if (issueMatch && req.method === "GET") {
    const issue = findIssue(fullName, Number(issueMatch[1]));
    if (!issue) {
      sendJson(res, 404, { message: "Not Found" });
      return;
    }
    sendJson(res, 200, issueJson(issue));
    return;
  }
  if (issueMatch && req.method === "PATCH") {
    const issue = findIssue(fullName, Number(issueMatch[1]));
    if (!issue) {
      sendJson(res, 404, { message: "Not Found" });
      return;
    }
    const input = body as { title?: string; body?: string; state?: "open" | "closed"; state_reason?: string | null };
    if (typeof input.title === "string") issue.title = input.title;
    if ("body" in input) issue.body = input.body ?? null;
    if (input.state) issue.state = input.state;
    if ("state_reason" in input) issue.state_reason = input.state_reason ?? null;
    issue.updated_at = new Date().toISOString();
    sendJson(res, 200, issueJson(issue));
    return;
  }

  const commentPost = /^issues\/(\d+)\/comments$/.exec(rest);
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
    sendJson(res, 201, { ...comment, html_url: `https://github.com/${fullName}/issues/${comment.number}#issuecomment-${comment.id}` });
    return;
  }

  if (rest === "issues/comments" && req.method === "GET") {
    const page = Number(url.searchParams.get("page") ?? "1");
    const list = page > 1 ? [] : githubMock.comments.filter((comment) => comment.fullName.toLowerCase() === fullName.toLowerCase());
    sendJson(res, 200, list);
    return;
  }

  sendJson(res, 404, { message: "Not Found" });
}

function findRepo(owner: string, repo: string): MockRepo | undefined {
  return githubMock.repos.get(`${owner}/${repo}`.toLowerCase());
}

function findIssue(fullName: string, number: number): MockIssue | undefined {
  return githubMock.issues.find((issue) => issue.fullName.toLowerCase() === fullName.toLowerCase() && issue.number === number);
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
    ...(issue.pull_request ? { pull_request: issue.pull_request } : {}),
  };
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}
