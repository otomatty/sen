import { create } from "zustand";
import type {
  Activity,
  AppNotification,
  Comment,
  Cycle,
  GitHubLink,
  GitHubPull,
  GitHubRepo,
  Issue,
  Label,
  Me,
  Project,
  Team,
  User,
  WorkflowState,
  Workspace,
} from "../../shared/types";

export type SyncStatus = "synced" | "syncing" | "offline";

export interface DataState {
  status: "idle" | "loading" | "ready" | "error";
  error: string | null;
  meId: string | null;
  workspace: Workspace | null;
  users: Record<string, User | Me>;
  teams: Record<string, Team>;
  states: Record<string, WorkflowState>;
  labels: Record<string, Label>;
  projects: Record<string, Project>;
  cycles: Record<string, Cycle>;
  issues: Record<string, Issue>;
  comments: Record<string, Comment>;
  activities: Record<string, Activity>;
  notifications: Record<string, AppNotification>;
  githubRepos: Record<string, GitHubRepo>;
  githubLinks: Record<string, GitHubLink>;
  githubPulls: Record<string, GitHubPull>;
  threads: Record<string, "loading" | "loaded">;
  syncStatus: SyncStatus;
  pendingCount: number;
  realtime: boolean;
}

export const initialData: DataState = {
  status: "idle",
  error: null,
  meId: null,
  workspace: null,
  users: {},
  teams: {},
  states: {},
  labels: {},
  projects: {},
  cycles: {},
  issues: {},
  comments: {},
  activities: {},
  notifications: {},
  githubRepos: {},
  githubLinks: {},
  githubPulls: {},
  threads: {},
  syncStatus: "synced",
  pendingCount: 0,
  realtime: false,
};

export const useData = create<DataState>(() => ({ ...initialData }));

export function useMe(): Me | null {
  return useData((s) => (s.meId ? (s.users[s.meId] as Me | undefined) ?? null : null));
}

export const getData = () => useData.getState();
