import type {
  Activity,
  AppNotification,
  Comment,
  Cycle,
  Issue,
  Label,
  Me,
  Project,
  Role,
  Team,
  User,
  UserSettings,
  WorkflowState,
  Workspace,
} from "../shared/types";
import type { WorkspaceRow } from "./env";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Row = Record<string, any>;

function json<T>(v: unknown, fallback: T): T {
  if (typeof v !== "string") return fallback;
  try {
    return JSON.parse(v) as T;
  } catch {
    return fallback;
  }
}

export const toWorkspace = (r: WorkspaceRow): Workspace => ({
  id: r.id,
  name: r.name,
  urlKey: r.url_key,
  inviteCode: r.invite_code,
  createdAt: r.created_at,
});

export const toUser = (r: Row): User => ({
  id: r.id,
  name: r.name,
  email: r.email,
  avatarColor: r.avatar_color,
  role: (r.role ?? "member") as Role,
  createdAt: r.created_at,
});

export const toMe = (r: Row): Me => ({
  ...toUser(r),
  settings: json<UserSettings>(r.settings, {}),
});

export const toTeam = (r: Row): Team => ({
  id: r.id,
  name: r.name,
  key: r.key,
  color: r.color,
  cycleDuration: r.cycle_duration,
  cyclesEnabled: !!r.cycles_enabled,
  createdAt: r.created_at,
});

export const toState = (r: Row): WorkflowState => ({
  id: r.id,
  teamId: r.team_id,
  name: r.name,
  type: r.type,
  color: r.color,
  position: r.position,
});

export const toLabel = (r: Row): Label => ({ id: r.id, name: r.name, color: r.color });

export const toProject = (r: Row): Project => ({
  id: r.id,
  name: r.name,
  description: r.description,
  status: r.status,
  leadId: r.lead_id,
  teamIds: json<string[]>(r.team_ids, []),
  startDate: r.start_date,
  targetDate: r.target_date,
  color: r.color,
  icon: r.icon,
  sortOrder: r.sort_order,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  archivedAt: r.archived_at,
});

export const toCycle = (r: Row): Cycle => ({
  id: r.id,
  teamId: r.team_id,
  number: r.number,
  name: r.name,
  startsAt: r.starts_at,
  endsAt: r.ends_at,
});

export const toIssue = (r: Row): Issue => ({
  id: r.id,
  teamId: r.team_id,
  number: r.number,
  title: r.title,
  description: r.description,
  stateId: r.state_id,
  priority: r.priority,
  assigneeId: r.assignee_id,
  creatorId: r.creator_id,
  projectId: r.project_id,
  cycleId: r.cycle_id,
  parentId: r.parent_id,
  labelIds: json<string[]>(r.label_ids, []),
  subscriberIds: json<string[]>(r.subscriber_ids, []),
  estimate: r.estimate,
  dueDate: r.due_date,
  sortOrder: r.sort_order,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  startedAt: r.started_at,
  completedAt: r.completed_at,
  canceledAt: r.canceled_at,
  archivedAt: r.archived_at,
});

export const toComment = (r: Row): Comment => ({
  id: r.id,
  issueId: r.issue_id,
  userId: r.user_id,
  body: r.body,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  editedAt: r.edited_at,
});

export const toActivity = (r: Row): Activity => ({
  id: r.id,
  issueId: r.issue_id,
  actorId: r.actor_id,
  type: r.type,
  data: json<Record<string, unknown>>(r.data, {}),
  createdAt: r.created_at,
});

export const toNotification = (r: Row): AppNotification => ({
  id: r.id,
  issueId: r.issue_id,
  actorId: r.actor_id,
  type: r.type,
  data: json<Record<string, unknown>>(r.data, {}),
  createdAt: r.created_at,
  readAt: r.read_at,
  archivedAt: r.archived_at,
  snoozedUntil: r.snoozed_until,
});
