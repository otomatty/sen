import { useState, type ReactNode } from "react";
import { MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import type { Activity, Comment } from "../../../shared/types";
import { priorityLabel } from "../../../shared/constants";
import { useData } from "../../store/data";
import { cycleName } from "../../store/selectors";
import { deleteComment, updateComment } from "../../store/actions";
import { formatDate, formatDateTime, identifier, isHtmlEmpty, timeAgo } from "../../lib/utils";
import { sanitizeHtml } from "../../lib/sanitize";
import { Avatar, Button, Menu } from "../../components/ui";
import { StateIcon } from "../../components/pickers";
import { Editor } from "../../components/Editor";
import { LabelDot, PriorityIcon } from "../../components/icons";

function Name({ id }: { id: string | null | undefined }) {
  const u = useData((s) => (id ? s.users[id] : undefined));
  return <b className="act-name">{u?.name ?? "（退出したメンバー）"}</b>;
}

export function ActivityLine({ a }: { a: Activity }) {
  const d = a.data as Record<string, unknown>;
  const states = useData((s) => s.states);
  const projects = useData((s) => s.projects);
  const cycles = useData((s) => s.cycles);
  const labels = useData((s) => s.labels);
  const issues = useData((s) => s.issues);
  const teams = useData((s) => s.teams);
  const actor = <Name id={a.actorId} />;
  let body: ReactNode = null;
  let icon: ReactNode = null;
  const stName = (id: unknown) => (typeof id === "string" && states[id] ? states[id].name : "（削除されたステータス）");
  switch (a.type) {
    case "created":
      body = <>{actor} が課題を作成しました</>;
      break;
    case "state":
      icon = typeof d.to === "string" && states[d.to] ? <StateIcon stateId={d.to} size={13} /> : null;
      body = (
        <>
          {actor} がステータスを <b>{stName(d.from)}</b> から <b>{stName(d.to)}</b> に変更しました
        </>
      );
      break;
    case "priority":
      icon = <PriorityIcon priority={Number(d.to)} size={13} />;
      body = (
        <>
          {actor} が優先度を <b>{priorityLabel(Number(d.to))}</b> に設定しました
        </>
      );
      break;
    case "assignee":
      body = !d.to ? (
        <>{actor} が担当者を外しました</>
      ) : d.to === a.actorId ? (
        <>{actor} が自分を担当者にしました</>
      ) : (
        <>
          {actor} が <Name id={String(d.to)} /> に割り当てました
        </>
      );
      break;
    case "labels": {
      const added = (d.added as string[] | undefined) ?? [];
      const removed = (d.removed as string[] | undefined) ?? [];
      const names = (ids: string[]) =>
        ids.map((id) => (
          <span key={id} className="act-label">
            <LabelDot color={labels[id]?.color ?? "#888"} />
            {labels[id]?.name ?? "（削除済み）"}
          </span>
        ));
      body = (
        <>
          {actor} が
          {added.length > 0 && <> ラベル {names(added)} を追加</>}
          {added.length > 0 && removed.length > 0 && "し、"}
          {removed.length > 0 && <> ラベル {names(removed)} を削除</>}
          しました
        </>
      );
      break;
    }
    case "project":
      body = d.to ? (
        <>
          {actor} がプロジェクトを <b>{projects[String(d.to)]?.name ?? "（削除済み）"}</b> に設定しました
        </>
      ) : (
        <>{actor} がプロジェクトから外しました</>
      );
      break;
    case "cycle":
      body = d.to ? (
        <>
          {actor} がサイクルを <b>{cycles[String(d.to)] ? cycleName(cycles[String(d.to)]) : "（削除済み）"}</b> に設定しました
        </>
      ) : (
        <>{actor} がサイクルから外しました</>
      );
      break;
    case "title":
      body = (
        <>
          {actor} がタイトルを「{String(d.from)}」から「{String(d.to)}」に変更しました
        </>
      );
      break;
    case "dueDate":
      body = d.to ? (
        <>
          {actor} が期日を <b>{formatDate(String(d.to), true)}</b> に設定しました
        </>
      ) : (
        <>{actor} が期日を削除しました</>
      );
      break;
    case "estimate":
      body = d.to === null ? (
        <>{actor} が見積もりを削除しました</>
      ) : (
        <>
          {actor} が見積もりを <b>{String(d.to)} ポイント</b> に設定しました
        </>
      );
      break;
    case "parent": {
      const parent = d.to ? issues[String(d.to)] : null;
      body = parent ? (
        <>
          {actor} が親課題を <b>{identifier(parent, teams)}</b> に設定しました
        </>
      ) : (
        <>{actor} が親課題を解除しました</>
      );
      break;
    }
    case "team":
      body = (
        <>
          {actor} が課題を <b>{teams[String(d.from)]?.name ?? "?"}</b> から <b>{teams[String(d.to)]?.name ?? "?"}</b> に移動しました
        </>
      );
      break;
    case "archived":
      body = <>{actor} が課題を削除しました</>;
      break;
    case "restored":
      body = <>{actor} が課題を復元しました</>;
      break;
  }
  return (
    <div className="activity-line" data-testid="activity-line">
      <span className="activity-dot">{icon ?? <span className="dot" />}</span>
      <span className="activity-text">
        {body}
        <span className="activity-time" title={formatDateTime(a.createdAt)}>
          ・{timeAgo(a.createdAt)}
        </span>
      </span>
    </div>
  );
}

export function CommentCard({ c }: { c: Comment }) {
  const user = useData((s) => s.users[c.userId]);
  const meId = useData((s) => s.meId);
  const isAdmin = useData((s) => (s.meId ? s.users[s.meId]?.role === "admin" : false));
  const [menu, setMenu] = useState<DOMRect | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(c.body);
  const mine = c.userId === meId;
  return (
    <div className="comment" data-testid="comment">
      <div className="comment-head">
        <Avatar user={user} size={20} />
        <b>{user?.name ?? "（退出したメンバー）"}</b>
        <span className="muted" title={formatDateTime(c.createdAt)}>
          {timeAgo(c.createdAt)}
          {c.editedAt ? "（編集済み）" : ""}
        </span>
        <span className="spacer" />
        {(mine || isAdmin) && !editing && (
          <button className="icon-btn" aria-label="コメントのメニュー" data-popover-anchor onClick={(e) => setMenu(menu ? null : e.currentTarget.getBoundingClientRect())}>
            <MoreHorizontal size={15} />
          </button>
        )}
      </div>
      {editing ? (
        <div className="comment-edit">
          <Editor value={draft} onChange={setDraft} autoFocus onSubmit={() => save()} />
          <div className="comment-edit-actions">
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
              キャンセル
            </Button>
            <Button size="sm" variant="primary" onClick={() => save()} disabled={isHtmlEmpty(draft)}>
              保存
            </Button>
          </div>
        </div>
      ) : (
        <div className="comment-body prose" dangerouslySetInnerHTML={{ __html: sanitizeHtml(c.body) }} />
      )}
      {menu && (
        <Menu
          anchor={menu}
          placement="bottom-end"
          onClose={() => setMenu(null)}
          items={[
            ...(mine
              ? [
                  {
                    label: "編集",
                    icon: <Pencil size={14} />,
                    onSelect: () => {
                      setDraft(c.body);
                      setEditing(true);
                    },
                  },
                ]
              : []),
            { label: "削除", icon: <Trash2 size={14} />, danger: true, onSelect: () => deleteComment(c.id) },
          ]}
        />
      )}
    </div>
  );

  function save() {
    if (isHtmlEmpty(draft)) return;
    updateComment(c.id, draft);
    setEditing(false);
  }
}
