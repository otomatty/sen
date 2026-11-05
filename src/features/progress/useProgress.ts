import { useEffect, useMemo, useRef, useState } from "react";
import { isValidYmd, todayYmd } from "../../../shared/dates";
import { summarizeProgress, type ProgressActivity } from "../../../shared/progress";
import type { Issue, Me, ProgressStartedResponse, Project, SheetSyncStatus, User, WorkflowState } from "../../../shared/types";
import { api } from "../../lib/api";
import { useData } from "../../store/data";
import { useMembers } from "../../store/selectors";

export interface ProgressModel {
  activities: ProgressActivity[];
  today: string;
  sheetUrl: string | null;
  meId: string | null;
  members: User[];
  projects: Record<string, Project>;
  issues: Record<string, Issue>;
  states: Record<string, WorkflowState>;
  users: Record<string, User | Me>;
  /** 課題 ID → 担当者 ID（未割り当ては null） */
  assigneeIdByIssue: Map<string, string | null>;
}

/**
 * ストアから活動一覧・WBS を作る。
 * 対象と並びはサーバーの loadReportInput と同じ。数字は summarizeProgress だけが数える。
 * 着手日は API の値と課題の startedAt（日本時間の日付）の早いほう。API が取れなければ startedAt だけ。
 */
export function useProgress(): ProgressModel {
  const wsKey = useData((s) => s.workspace?.urlKey ?? "");
  const workspace = useData((s) => s.workspace);
  const projects = useData((s) => s.projects);
  const issues = useData((s) => s.issues);
  const states = useData((s) => s.states);
  const teams = useData((s) => s.teams);
  const users = useData((s) => s.users);
  const labels = useData((s) => s.labels);
  const meId = useData((s) => s.meId);
  const members = useMembers();
  const startedOn = useStartedOn(wsKey, issues);
  const sheetUrl = useSheetUrl(wsKey);

  return useMemo(() => {
    const projectList = Object.values(projects)
      .filter((project) => !project.archivedAt)
      .sort((a, b) => a.sortOrder - b.sortOrder || a.createdAt - b.createdAt);
    const projectIds = new Set(projectList.map((project) => project.id));
    const today = todayYmd(540);
    const assigneeIdByIssue = new Map<string, string | null>();
    const reportIssues = Object.values(issues)
      .filter((issue) => !issue.archivedAt && issue.projectId && projectIds.has(issue.projectId))
      .map((issue) => {
        assigneeIdByIssue.set(issue.id, issue.assigneeId);
        const state = states[issue.stateId];
        const team = teams[issue.teamId];
        const fromIssue = issue.startedAt != null ? todayYmd(540, issue.startedAt) : null;
        return {
          id: issue.id,
          identifier: team ? `${team.key}-${issue.number}` : String(issue.number),
          title: issue.title,
          descriptionText: "",
          projectId: issue.projectId!,
          stateName: state?.name ?? "",
          stateType: state?.type ?? "unstarted",
          priority: issue.priority ?? 0,
          assigneeName: issue.assigneeId ? (users[issue.assigneeId]?.name ?? null) : null,
          labelNames: issue.labelIds.flatMap((id) => {
            const name = labels[id]?.name;
            return name ? [name] : [];
          }),
          dueDate: isValidYmd(issue.dueDate) ? issue.dueDate : null,
          startedOn: earlierYmd(fromIssue, startedOn[issue.id] ?? null),
          completedOn: issue.completedAt != null ? todayYmd(540, issue.completedAt) : null,
        };
      });
    const summary = summarizeProgress({
      workspaceName: workspace?.name ?? "",
      urlKey: workspace?.urlKey ?? "",
      origin: null,
      today,
      now: Date.now(),
      projects: projectList.map((project) => ({ id: project.id, name: project.name })),
      issues: reportIssues,
    });
    return {
      activities: summary.activities,
      today,
      sheetUrl,
      meId,
      members,
      projects,
      issues,
      states,
      users,
      assigneeIdByIssue,
    };
  }, [workspace, projects, issues, states, teams, users, labels, meId, members, startedOn, sheetUrl]);
}

function earlierYmd(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return a <= b ? a : b;
}

/** ページを開いたときに取り、課題が変わったら 1.5 秒待って取り直す。ワークスペースが違う応答は捨てる */
function useStartedOn(wsKey: string, issues: Record<string, Issue>): Record<string, string> {
  const [map, setMap] = useState<Record<string, string>>({});
  const loadedWs = useRef<string | null>(null);

  useEffect(() => {
    if (!wsKey) return;
    const key = wsKey;
    const immediate = loadedWs.current !== key;
    if (immediate) setMap((prev) => (Object.keys(prev).length ? {} : prev));
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void api<ProgressStartedResponse>(`/api/progress/started?ws=${encodeURIComponent(key)}`)
        .then((res) => {
          if (cancelled || useData.getState().workspace?.urlKey !== key) return;
          loadedWs.current = key;
          setMap(res.startedOn ?? {});
        })
        .catch(() => {
          // 取れなくても課題の startedAt だけで表示する
        });
    }, immediate ? 0 : 1500);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [wsKey, issues]);

  return map;
}

/** 連携が有効なときだけスプレッドシートの URL。デモ版・失敗時は出さない */
function useSheetUrl(wsKey: string): string | null {
  const demo = typeof __SEN_DEMO__ !== "undefined" && __SEN_DEMO__;
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (demo || !wsKey) {
      setUrl(null);
      return;
    }
    const key = wsKey;
    let cancelled = false;
    setUrl(null);
    void api<SheetSyncStatus>(`/api/sheets/status?ws=${encodeURIComponent(key)}`)
      .then((status) => {
        if (cancelled || useData.getState().workspace?.urlKey !== key) return;
        setUrl(status.enabled && status.spreadsheetUrl ? status.spreadsheetUrl : null);
      })
      .catch(() => {
        if (!cancelled) setUrl(null);
      });
    return () => {
      cancelled = true;
    };
  }, [demo, wsKey]);

  return url;
}
