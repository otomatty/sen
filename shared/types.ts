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
  createdAt: number;
}

export interface Me extends User {
  settings: UserSettings;
}

export interface Workspace {
  id: string;
  name: string;
  urlKey: string;
  inviteCode: string;
  createdAt: number;
}

export interface WorkspaceSummary {
  id: string;
  name: string;
  urlKey: string;
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
  | "relation";

export interface Activity {
  id: string;
  issueId: string;
  actorId: string;
  type: ActivityType;
  data: Record<string, unknown>;
  createdAt: number;
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
  | "notification";

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
  workspaces: WorkspaceSummary[];
  users: User[];
  teams: Team[];
  states: WorkflowState[];
  labels: Label[];
  projects: Project[];
  cycles: Cycle[];
  issues: Issue[];
  notifications: AppNotification[];
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
  | { type: "workspace.regenerateInvite"; args: Record<string, never> }
  | { type: "user.update"; args: { name?: string; avatarColor?: string; settings?: UserSettings } }
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
