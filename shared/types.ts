// クライアントとサーバーで共有するエンティティ型。
// サーバーは DB 行をこの形（camelCase）に変換してから同期ログに書き出す。

export type StateType = "backlog" | "unstarted" | "started" | "completed" | "canceled";
export type ProjectStatus = "backlog" | "planned" | "started" | "paused" | "completed" | "canceled";
export type Role = "admin" | "member";

export interface UserSettings {
  theme?: "system" | "light" | "dark";
  welcomeDismissed?: boolean;
  favorites?: Favorite[];
}

export interface Favorite {
  type: "project" | "issue" | "cycle" | "view";
  id: string;
}

export interface User {
  id: string;
  name: string;
  email: string;
  avatarColor: string;
  role: Role;
  /** プロフィールに登録した GitHub のユーザー名（小文字）。未登録は null */
  githubLogin: string | null;
  createdAt: number;
}

export interface Me extends User {
  settings: UserSettings;
}

export interface Workspace {
  id: string;
  name: string;
  urlKey: string;
  /** 利用できるメールドメイン。空なら制限なし */
  allowedDomains: string[];
  createdAt: number;
}

export interface WorkspaceSummary {
  id: string;
  name: string;
  urlKey: string;
}

/** このブラウザでログインしているアカウント（複数アカウント） */
export interface DeviceAccount {
  id: string;
  name: string;
  email: string;
  avatarColor: string;
  /** 今使っているアカウント */
  current: boolean;
}

export interface Team {
  id: string;
  name: string;
  key: string;
  color: string;
  cycleDuration: number;
  cyclesEnabled: boolean;
  createdAt: number;
}

export interface WorkflowState {
  id: string;
  teamId: string;
  name: string;
  type: StateType;
  color: string;
  position: number;
}

export interface Label {
  id: string;
  name: string;
  color: string;
}

/** チームと GitHub リポジトリの対応。id は teamId（同期エンジンが id で引く） */
export interface GitHubRepo {
  id: string;
  teamId: string;
  /** owner/name */
  repo: string;
  linkedAt: number;
  hook: "auto" | "manual";
  prDraftStateId: string | null;
  prOpenStateId: string | null;
  prMergedStateId: string | null;
}

/** 課題と GitHub Issue の紐づけ。id は issueId */
export interface GitHubLink {
  id: string;
  issueId: string;
  /** owner/name */
  repo: string;
  number: number;
  url: string;
  syncedAt: number | null;
  lastError: string | null;
}

export type GitHubPullState = "draft" | "open" | "merged" | "closed";

/** 課題とプルリクエストの紐づけ */
export interface GitHubPull {
  id: string;
  issueId: string;
  /** owner/name */
  repo: string;
  number: number;
  title: string;
  url: string;
  state: GitHubPullState;
  author: string | null;
}

export interface Project {
  id: string;
  name: string;
  description: string;
  status: ProjectStatus;
  leadId: string | null;
  teamIds: string[];
  startDate: string | null;
  targetDate: string | null;
  color: string;
  icon: string | null;
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
}

export interface Cycle {
  id: string;
  teamId: string;
  number: number;
  name: string | null;
  startsAt: string;
  endsAt: string;
}

export interface Issue {
  id: string;
  teamId: string;
  number: number;
  title: string;
  description: string;
  stateId: string;
  priority: number;
  assigneeId: string | null;
  creatorId: string;
  projectId: string | null;
  cycleId: string | null;
  parentId: string | null;
  labelIds: string[];
  subscriberIds: string[];
  /** この課題から他の課題への関係（逆向きは相手側から計算する） */
  relations: IssueRelation[];
  estimate: number | null;
  dueDate: string | null;
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
  startedAt: number | null;
  completedAt: number | null;
  canceledAt: number | null;
  archivedAt: number | null;
}

/**
 * 課題どうしの関係。関係は「元」の課題にだけ保存する。
 * - blocks: この課題が issueId をブロックしている（相手から見ると「ブロックされている」）
 * - related: 関連（向きなし）
 * - duplicate: この課題は issueId の重複
 */
export type RelationType = "blocks" | "related" | "duplicate";

export interface IssueRelation {
  type: RelationType;
  issueId: string;
}

export interface Comment {
  id: string;
  issueId: string;
  userId: string;
  body: string;
  createdAt: number;
  updatedAt: number;
  editedAt: number | null;
  /** AI ツールから行った操作のとき、そのツールの名前（例: "Claude Code"） */
  via?: string | null;
  /** GitHub から来たコメントで、書いた人がメンバーに結び付かないときの GitHub ユーザー名 */
  githubAuthor?: string | null;
}

export type ActivityType =
  | "created"
  | "state"
  | "priority"
  | "assignee"
  | "labels"
  | "project"
  | "cycle"
  | "title"
  | "dueDate"
  | "estimate"
  | "parent"
  | "team"
  | "archived"
  | "restored"
  | "relation"
  | "github";

export interface Activity {
  id: string;
  issueId: string;
  actorId: string;
  type: ActivityType;
  data: Record<string, unknown>;
  createdAt: number;
  /** AI ツールから行った操作のとき、そのツールの名前（例: "Claude Code"） */
  via?: string | null;
}

export type NotificationType = "assigned" | "comment" | "mention" | "state" | "created";

export interface AppNotification {
  id: string;
  issueId: string;
  actorId: string;
  type: NotificationType;
  data: Record<string, unknown>;
  createdAt: number;
  readAt: number | null;
  archivedAt: number | null;
  snoozedUntil: number | null;
  /** AI ツールから行った操作のとき、そのツールの名前（例: "Claude Code"） */
  via?: string | null;
}

export type EntityName =
  | "workspace"
  | "user"
  | "team"
  | "state"
  | "label"
  | "project"
  | "cycle"
  | "issue"
  | "comment"
  | "activity"
  | "notification"
  | "githubRepo"
  | "githubLink"
  | "githubPull";

export interface SyncChange {
  id: number;
  entity: EntityName;
  entityId: string;
  op: "upsert" | "delete";
  data: unknown;
}

export interface BootstrapPayload {
  me: Me;
  workspace: Workspace;
  /** 今のクライアントは /api/me の一覧を使う。古い版のクライアントのために残している */
  workspaces: WorkspaceSummary[];
  users: User[];
  teams: Team[];
  states: WorkflowState[];
  labels: Label[];
  projects: Project[];
  cycles: Cycle[];
  issues: Issue[];
  notifications: AppNotification[];
  /** 連携の対象でないワークスペースでは空 */
  githubRepos: GitHubRepo[];
  githubLinks: GitHubLink[];
  githubPulls: GitHubPull[];
  lastSyncId: number;
}

// ---- ミューテーション ----
export type IssuePatch = Partial<
  Pick<
    Issue,
    | "title"
    | "description"
    | "stateId"
    | "priority"
    | "assigneeId"
    | "projectId"
    | "cycleId"
    | "parentId"
    | "labelIds"
    | "subscriberIds"
    | "estimate"
    | "dueDate"
    | "sortOrder"
    | "teamId"
  >
>;

export type Mutation =
  | {
      type: "issue.create";
      args: {
        id: string;
        teamId: string;
        title: string;
        description?: string;
        stateId?: string;
        priority?: number;
        assigneeId?: string | null;
        projectId?: string | null;
        cycleId?: string | null;
        parentId?: string | null;
        labelIds?: string[];
        estimate?: number | null;
        dueDate?: string | null;
        sortOrder?: number;
      };
    }
  | { type: "issue.update"; args: { id: string; patch: IssuePatch } }
  | { type: "issue.relate"; args: { id: string; type: RelationType; targetId: string } }
  | { type: "issue.unrelate"; args: { id: string; type: RelationType; targetId: string } }
  | { type: "issue.archive"; args: { id: string } }
  | { type: "issue.restore"; args: { id: string } }
  | { type: "comment.create"; args: { id: string; issueId: string; body: string } }
  | { type: "comment.update"; args: { id: string; body: string } }
  | { type: "comment.delete"; args: { id: string } }
  | { type: "label.create"; args: { id: string; name: string; color: string } }
  | { type: "label.update"; args: { id: string; name?: string; color?: string } }
  | { type: "label.delete"; args: { id: string } }
  | {
      type: "project.create";
      args: {
        id: string;
        name: string;
        description?: string;
        status?: Project["status"];
        leadId?: string | null;
        teamIds?: string[];
        startDate?: string | null;
        targetDate?: string | null;
        color?: string;
        icon?: string | null;
      };
    }
  | {
      type: "project.update";
      args: {
        id: string;
        patch: Partial<
          Pick<
            Project,
            "name" | "description" | "status" | "leadId" | "teamIds" | "startDate" | "targetDate" | "color" | "icon" | "sortOrder"
          >
        >;
      };
    }
  | { type: "project.archive"; args: { id: string } }
  | { type: "cycle.create"; args: { id: string; teamId: string; name?: string | null; startsAt?: string; endsAt?: string } }
  | { type: "cycle.update"; args: { id: string; patch: Partial<Pick<Cycle, "name" | "startsAt" | "endsAt">> } }
  | { type: "cycle.delete"; args: { id: string } }
  | { type: "team.create"; args: { id: string; name: string; key: string; color?: string } }
  | {
      type: "team.update";
      args: { id: string; patch: Partial<Pick<Team, "name" | "key" | "color" | "cycleDuration" | "cyclesEnabled">> };
    }
  | { type: "state.create"; args: { id: string; teamId: string; name: string; type: StateType; color: string } }
  | { type: "state.update"; args: { id: string; patch: Partial<Pick<WorkflowState, "name" | "color" | "position">> } }
  | { type: "state.delete"; args: { id: string; moveToStateId: string } }
  | {
      type: "notification.update";
      args: { id: string; patch: Partial<Pick<AppNotification, "readAt" | "archivedAt" | "snoozedUntil">> };
    }
  | { type: "notification.markAllRead"; args: Record<string, never> }
  | { type: "workspace.update"; args: { name?: string } }
  | { type: "workspace.setAllowedDomains"; args: { domains: string[] } }
  | { type: "user.update"; args: { name?: string; avatarColor?: string; settings?: UserSettings; githubLogin?: string | null } }
  | {
      type: "user.updateSettings";
      args: {
        set?: Partial<Omit<UserSettings, "favorites">>;
        addFavorite?: Favorite;
        removeFavorite?: Favorite;
      };
    }
  | { type: "member.update"; args: { userId: string; role: Role } }
  | { type: "member.remove"; args: { userId: string } };

export type MutationType = Mutation["type"];

export interface MutateRequest {
  ops: { clientId: string; mutation: Mutation }[];
}

export interface MutateResponse {
  results: { clientId: string; ok: boolean; error?: string }[];
  lastSyncId: number;
}

// ---- メール指定の招待 ----
export interface InvitationSummary {
  id: string;
  email: string;
  role: Role;
  invitedBy: { id: string; name: string } | null;
  createdAt: number;
  expiresAt: number;
  emailSentAt: number | null;
  status: "pending" | "expired";
}

export interface InvitationListResponse {
  invitations: InvitationSummary[];
  emailEnabled: boolean;
}

export interface InvitationCreateRequest {
  emails: string[];
  role: Role;
}

export interface InvitationIssued {
  invitation: InvitationSummary;
  link: string;
  emailSent: boolean;
  emailError?: string;
}

export interface InvitationCreateResponse {
  results: InvitationIssued[];
}

/** 招待リンクを開いた人に見せる内容（ログイン前でも見られるので最小限） */
export interface InvitePreview {
  workspaceName: string;
  invitedByName: string | null;
  maskedEmail: string;
  role: Role;
  expiresAt: number;
  /** ログイン中なら、そのアカウントが招待先と一致するか。ログインしていなければ null */
  forCurrentUser: boolean | null;
}

/** ログイン中の人あての招待（/api/me で返す） */
export interface PendingInvitation {
  id: string;
  workspaceName: string;
  invitedByName: string | null;
  role: Role;
  expiresAt: number;
}

// ---- AI ツール（MCP）の個人用トークン ----
export type ApiTokenClient = "claude-code" | "cursor" | "vscode" | "other";
export type ApiTokenScope = "read" | "write";

/** 画面に出すトークンの情報（トークンそのものは含まない） */
export interface ApiTokenSummary {
  id: string;
  name: string;
  client: ApiTokenClient;
  scope: ApiTokenScope;
  /** トークンの末尾 4 文字（見分ける用） */
  hint: string;
  createdAt: number;
  lastUsedAt: number | null;
  expiresAt: number | null;
}

export interface ApiTokenListResponse {
  tokens: ApiTokenSummary[];
  /** MCP サーバーの URL（例: https://sen.example.com/api/mcp） */
  mcpUrl: string;
}

export interface ApiTokenCreateRequest {
  client: ApiTokenClient;
  name?: string;
  scope: ApiTokenScope;
  /** null は無期限 */
  expiresInDays: 30 | 90 | 365 | null;
}

export interface ApiTokenCreateResponse {
  token: ApiTokenSummary;
  /** 発行したトークン（この応答でしか返さない） */
  secret: string;
  mcpUrl: string;
}

/** GET /api/oauth/requests/:id の応答（同意画面） */
export interface OAuthConsentInfo {
  clientName: string;
  destination: string;
  verifiedHost: string | null;
  /** AI ツールが求めた範囲。同意画面の初期値 */
  scope: ApiTokenScope;
  workspaces: { id: string; name: string; urlKey: string }[];
  defaultWorkspaceId: string | null;
}
export interface OAuthApproveRequest { workspaceId: string; scope: ApiTokenScope }
export interface OAuthRedirectResponse { redirectTo: string }
/** 設定画面に出す OAuth の接続 */
export interface OAuthGrantSummary {
  id: string;
  clientName: string;
  scope: ApiTokenScope;
  createdAt: number;
  lastUsedAt: number | null;
}
export interface AiConnectionsResponse {
  mcpUrl: string;
  grants: OAuthGrantSummary[];
  tokens: ApiTokenSummary[];
}

/** GET /api/github/status の応答。トークンと Webhook の secret は含めない */
export interface GitHubStatus {
  /** このワークスペースが連携の対象か */
  enabled: boolean;
  /** トークンの GitHub ユーザー名。まだ取得していない、または無効なときは null */
  login: string | null;
  /** トークンが無効、または利用制限に達しているときの説明。無ければ null */
  error: string | null;
  /** Webhook の受け口。対象でないときは空文字 */
  webhookUrl: string;
}

export interface GitHubRepoLinkRequest {
  teamId: string;
  /** owner/name */
  repo: string;
}

/** null は「変えない」。省略した項目は今の値のまま */
export interface GitHubRepoPatch {
  prDraftStateId?: string | null;
  prOpenStateId?: string | null;
  prMergedStateId?: string | null;
}

/** GET /api/progress/started の応答。課題 ID → 日本時間の着手日 'YYYY-MM-DD'（無い課題は含めない） */
export interface ProgressStartedResponse {
  startedOn: Record<string, string>;
}

/** 添付ファイルのアップロード結果 */
export interface AttachmentUploadResponse {
  id: string;
  url: string;
  name: string;
  kind: "image" | "file";
  size: number;
}
