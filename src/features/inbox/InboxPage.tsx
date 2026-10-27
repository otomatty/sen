import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { Archive, CheckCheck, Inbox, MailOpen, Mail } from "lucide-react";
import type { AppNotification } from "../../../shared/types";
import { useData } from "../../store/data";
import { useInbox } from "../../store/selectors";
import { archiveNotification, markAllNotificationsRead, setNotificationRead } from "../../store/actions";
import { SCOPE, useHotkeys } from "../../lib/hotkeys";
import { cx, identifier, shortTimeAgo } from "../../lib/utils";
import { Avatar, EmptyState, Kbd, Tooltip } from "../../components/ui";
import { PageHeader } from "../../components/PageHeader";
import { StateIcon } from "../../components/pickers";
import { IssueDetail } from "../issues/IssueDetail";
import { useDocumentTitle, useWsPath } from "../../app/hooks";

function describe(n: AppNotification, states: Record<string, { name: string }>): string {
  switch (n.type) {
    case "assigned":
      return "があなたに割り当てました";
    case "comment":
      return "がコメントしました";
    case "mention":
      return "があなたをメンションしました";
    case "state": {
      const to = states[String(n.data.to)]?.name;
      return to ? `がステータスを「${to}」に変更しました` : "がステータスを変更しました";
    }
    case "created":
      return "が課題を作成しました";
  }
}

export function InboxPage() {
  const all = useInbox();
  const issues = useData((s) => s.issues);
  const users = useData((s) => s.users);
  const teams = useData((s) => s.teams);
  const states = useData((s) => s.states);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const list = useMemo(() => (unreadOnly ? all.filter((n) => !n.readAt) : all), [all, unreadOnly]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const navigate = useNavigate();
  const p = useWsPath();
  useDocumentTitle("受信トレイ");

  const selected = list.find((n) => n.id === selectedId) ?? null;

  // 最初の通知を自動で選ぶ（削除後は次の通知へ）
  useEffect(() => {
    if (!selected && list.length && window.innerWidth > 900) setSelectedId(list[0].id);
  }, [selected, list]);

  // 開いた通知は既読にする
  useEffect(() => {
    if (selected && !selected.readAt) {
      const t = setTimeout(() => setNotificationRead(selected.id, true), 400);
      return () => clearTimeout(t);
    }
  }, [selected]);

  const move = (d: number) => {
    if (!list.length) return;
    const idx = selected ? list.indexOf(selected) : -1;
    const next = list[Math.max(0, Math.min(list.length - 1, idx + d))];
    setSelectedId(next.id);
    requestAnimationFrame(() => document.querySelector(`[data-notification-id="${next.id}"]`)?.scrollIntoView({ block: "nearest" }));
  };
  const archive = (n: AppNotification | null) => {
    if (!n) return;
    const idx = list.indexOf(n);
    const next = list[idx + 1] ?? list[idx - 1] ?? null;
    archiveNotification(n.id);
    setSelectedId(next?.id ?? null);
  };

  useHotkeys(["j", "arrowdown"], () => move(1), { scope: SCOPE.view });
  useHotkeys(["k", "arrowup"], () => move(-1), { scope: SCOPE.view });
  useHotkeys(["backspace", "delete", "e"], () => archive(selected), { scope: SCOPE.view });
  useHotkeys("u", () => selected && setNotificationRead(selected.id, !selected.readAt), { scope: SCOPE.view });
  useHotkeys(
    "enter",
    () => {
      const issue = selected && issues[selected.issueId];
      if (issue) navigate(p(`/issue/${identifier(issue, teams)}`));
    },
    { scope: SCOPE.view },
  );

  return (
    <div className="page inbox-page" data-testid="inbox-page">
      <div className="inbox-list-pane">
        <PageHeader
          title={
            <span className="page-title-text">
              <Inbox size={16} />
              受信トレイ
            </span>
          }
          screen="inbox"
          actions={
            <>
              <Tooltip label={unreadOnly ? "すべて表示" : "未読のみ表示"}>
                <button className={cx("icon-btn", unreadOnly && "on")} onClick={() => setUnreadOnly((v) => !v)} aria-label="未読のみ" data-testid="inbox-unread-only">
                  {unreadOnly ? <Mail size={15} /> : <MailOpen size={15} />}
                </button>
              </Tooltip>
              <Tooltip label="すべて既読にする">
                <button className="icon-btn" onClick={() => markAllNotificationsRead()} aria-label="すべて既読にする" data-testid="inbox-mark-all">
                  <CheckCheck size={15} />
                </button>
              </Tooltip>
            </>
          }
        />
        <div className="inbox-list" data-testid="inbox-list">
          {list.length === 0 && (
            <EmptyState icon={<Inbox size={26} />} title={unreadOnly ? "未読の通知はありません" : "受信トレイは空です"} description="割り当て・コメント・メンションがここに届きます。" />
          )}
          {list.map((n) => {
            const issue = issues[n.issueId];
            const actor = users[n.actorId];
            if (!issue) return null;
            return (
              <div
                key={n.id}
                className={cx("inbox-item", n.id === selected?.id && "active", !n.readAt && "unread")}
                onClick={() => setSelectedId(n.id)}
                data-notification-id={n.id}
                data-testid="inbox-item"
              >
                <div className="inbox-avatar">
                  <Avatar user={actor} size={28} />
                  {!n.readAt && <span className="unread-dot" />}
                </div>
                <div className="inbox-text">
                  <div className="inbox-line1">
                    <span className="row-id">{identifier(issue, teams)}</span>
                    <span className="inbox-title">{issue.title}</span>
                  </div>
                  <div className="inbox-line2">
                    <StateIcon stateId={issue.stateId} size={12} />
                    <span>
                      {actor?.name ?? "誰か"}
                      {describe(n, states)}
                      {typeof n.data.snippet === "string" && n.data.snippet ? `：${n.data.snippet}` : ""}
                    </span>
                  </div>
                </div>
                <div className="inbox-meta">
                  <span className="muted small">{shortTimeAgo(n.createdAt)}</span>
                  <button
                    className="icon-btn inbox-archive"
                    aria-label="通知を削除"
                    onClick={(e) => {
                      e.stopPropagation();
                      archive(n);
                    }}
                  >
                    <Archive size={14} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
        {list.length > 0 && (
          <div className="inbox-hints">
            <Kbd combo="j" /> <Kbd combo="k" /> 移動 <Kbd combo="backspace" /> 削除 <Kbd combo="u" /> 既読/未読 <Kbd combo="enter" /> 開く
          </div>
        )}
      </div>
      <div className={cx("inbox-detail-pane", selected && "has-selection")}>
        {selected && issues[selected.issueId] ? (
          <IssueDetail issueId={selected.issueId} embedded onClose={() => setSelectedId(null)} />
        ) : (
          <EmptyState icon={<Inbox size={30} />} title="通知を選択してください" description="左の一覧から通知を選ぶと、ここに課題が表示されます。" />
        )}
      </div>
    </div>
  );
}
