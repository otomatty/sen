import { useEffect } from "react";
import { useParams } from "react-router";
import { useData } from "../store/data";
import { useTeams } from "../store/selectors";

export function useWsKey(): string {
  const { ws } = useParams();
  return ws ?? "";
}

export function useWsPath() {
  const ws = useWsKey();
  return (p: string) => `/${ws}${p.startsWith("/") ? p : `/${p}`}`;
}

/** 今いる画面のチーム（なければ最初のチーム） */
export function useCurrentTeamId(): string | undefined {
  const { teamKey } = useParams();
  const teams = useTeams();
  const fromRoute = teams.find((t) => t.key.toLowerCase() === teamKey?.toLowerCase());
  return fromRoute?.id ?? teams[0]?.id;
}

export function useIsAdmin(): boolean {
  return useData((s) => (s.meId ? s.users[s.meId]?.role === "admin" : false));
}

/** ブラウザのタブに表示するタイトル */
export function useDocumentTitle(title: string | null | undefined) {
  const unread = useData((s) => {
    let n = 0;
    for (const x of Object.values(s.notifications)) if (!x.readAt && !x.archivedAt) n++;
    return n;
  });
  useEffect(() => {
    if (!title) return;
    document.title = `${unread ? `(${unread}) ` : ""}${title} – Sen`;
  }, [title, unread]);
}
