import { useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { Link, useNavigate } from "react-router";
import {
  Bell,
  BellOff,
  ChevronDown,
  ChevronUp,
  Copy,
  Link2,
  MoreHorizontal,
  Plus,
  Trash2,
  X,
  CornerLeftUp,
  ArrowRightLeft,
  RotateCcw,
} from "lucide-react";
import type { Issue } from "../../../shared/types";
import { priorityLabel } from "../../../shared/constants";
import { useData } from "../../store/data";
import { engine } from "../../store/engine";
import { archiveIssues, createIssue, restoreIssues, toggleSubscription, updateIssues } from "../../store/actions";
import { cycleName, useSubIssues, useThread } from "../../store/selectors";
import { openCreateIssue, openPicker, toast, useUI, type PickerKind } from "../../store/ui";
import { SCOPE, useHotkeys } from "../../lib/hotkeys";
import { appUrl, copyText, cx, dueStatus, formatDate, formatDateTime, identifier, timeAgo } from "../../lib/utils";
import { AutoTextarea, Avatar, Menu, Spinner, Tooltip } from "../../components/ui";
import { CycleIcon, LabelDot, PriorityIcon, ProjectIcon, TeamIcon } from "../../components/icons";
import { StateIcon } from "../../components/pickers";
import { Editor } from "../../components/Editor";
import { HelpVideoButton } from "../../components/PageHeader";
import { useWsPath } from "../../app/hooks";
import { ActivityLine, CommentCard } from "./Activity";
import { CommentComposer } from "./CommentComposer";

function PropRow({ label, children, kind, issueId, testId }: { label: string; children: ReactNode; kind: PickerKind; issueId: string; testId?: string }) {
  return (
    <div className="prop-row">
      <span className="prop-label">{label}</span>
      <button
        className="prop-value"
        data-popover-anchor
        data-testid={testId}
        onClick={(e: MouseEvent) => openPicker({ kind, issueIds: [issueId], anchor: e.currentTarget.getBoundingClientRect() })}
      >
        {children}
      </button>
    </div>
  );
}

function Properties({ issue }: { issue: Issue }) {
  const d = useData();
  const st = d.states[issue.stateId];
  const assignee = issue.assigneeId ? d.users[issue.assigneeId] : null;
  const project = issue.projectId ? d.projects[issue.projectId] : null;
  const cycle = issue.cycleId ? d.cycles[issue.cycleId] : null;
  const team = d.teams[issue.teamId];
  const creator = d.users[issue.creatorId];
  const parent = issue.parentId ? d.issues[issue.parentId] : null;
  const due = dueStatus(issue.dueDate);
  return (
    <aside className="detail-sidebar" data-testid="issue-properties">
      <PropRow label="ステータス" kind="status" issueId={issue.id} testId="prop-status">
        <StateIcon stateId={issue.stateId} />
        <span>{st?.name}</span>
      </PropRow>
      <PropRow label="優先度" kind="priority" issueId={issue.id} testId="prop-priority">
        <PriorityIcon priority={issue.priority} />
        <span className={cx(issue.priority === 0 && "muted")}>{priorityLabel(issue.priority)}</span>
      </PropRow>
      <PropRow label="担当者" kind="assignee" issueId={issue.id} testId="prop-assignee">
        <Avatar user={assignee} size={18} />
        <span className={cx(!assignee && "muted")}>{assignee?.name ?? "未割り当て"}</span>
      </PropRow>
      <div className="prop-row prop-row-wrap">
        <span className="prop-label">ラベル</span>
        <button
          className="prop-value wrap"
          data-popover-anchor
          data-testid="prop-labels"
          onClick={(e) => openPicker({ kind: "labels", issueIds: [issue.id], anchor: e.currentTarget.getBoundingClientRect() })}
        >
          {issue.labelIds.length ? (
            issue.labelIds.map((id) =>
              d.labels[id] ? (
                <span key={id} className="chip label-chip">
                  <LabelDot color={d.labels[id].color} />
                  {d.labels[id].name}
                </span>
              ) : null,
            )
          ) : (
            <span className="muted">ラベルを追加</span>
          )}
        </button>
      </div>
      <PropRow label="プロジェクト" kind="project" issueId={issue.id} testId="prop-project">
        {project ? <ProjectIcon color={project.color} status={project.status} /> : null}
        <span className={cx(!project && "muted")}>{project?.name ?? "プロジェクトに追加"}</span>
      </PropRow>
      {team?.cyclesEnabled && (
        <PropRow label="サイクル" kind="cycle" issueId={issue.id} testId="prop-cycle">
          <CycleIcon size={14} progress={cycle ? 0.5 : 0} />
          <span className={cx(!cycle && "muted")}>{cycle ? cycleName(cycle) : "サイクルに追加"}</span>
        </PropRow>
      )}
      <PropRow label="見積もり" kind="estimate" issueId={issue.id} testId="prop-estimate">
        <span className={cx(issue.estimate === null && "muted")}>{issue.estimate === null ? "見積もりなし" : `${issue.estimate} ポイント`}</span>
      </PropRow>
      <PropRow label="期日" kind="dueDate" issueId={issue.id} testId="prop-due">
        <span className={cx(!issue.dueDate && "muted", due === "overdue" && "text-danger", due === "soon" && "text-warn")}>
          {issue.dueDate ? formatDate(issue.dueDate, true) : "期日を設定"}
        </span>
      </PropRow>
      <PropRow label="親課題" kind="parent" issueId={issue.id} testId="prop-parent">
        <span className={cx(!parent && "muted")}>{parent ? `${identifier(parent, d.teams)} ${parent.title}` : "親課題を設定"}</span>
      </PropRow>
      <PropRow label="チーム" kind="team" issueId={issue.id} testId="prop-team">
        {team && <TeamIcon team={team} size={16} />}
        <span>{team?.name}</span>
      </PropRow>
      <div className="prop-meta">
        <div>
          作成者 <b>{creator?.name ?? "—"}</b>
        </div>
        <div title={formatDateTime(issue.createdAt)}>作成 {timeAgo(issue.createdAt)}</div>
        <div title={formatDateTime(issue.updatedAt)}>更新 {timeAgo(issue.updatedAt)}</div>
        {issue.completedAt && <div title={formatDateTime(issue.completedAt)}>完了 {timeAgo(issue.completedAt)}</div>}
      </div>
    </aside>
  );
}

function SubIssues({ issue }: { issue: Issue }) {
  const subs = useSubIssues(issue.id);
  const teams = useData((s) => s.teams);
  const states = useData((s) => s.states);
  const users = useData((s) => s.users);
  const navigate = useNavigate();
  const p = useWsPath();
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState("");
  const done = subs.filter((s) => states[s.stateId]?.type === "completed").length;
  const add = () => {
    const t = title.trim();
    if (!t) return;
    createIssue({ teamId: issue.teamId, title: t, parentId: issue.id, projectId: issue.projectId, cycleId: issue.cycleId });
    setTitle("");
  };
  if (!subs.length && !adding) {
    return (
      <button className="link-btn add-sub" onClick={() => setAdding(true)} data-testid="add-sub-issue">
        <Plus size={14} /> サブ課題を追加
      </button>
    );
  }
  return (
    <section className="sub-issues" data-testid="sub-issues">
      <div className="section-title">
        サブ課題
        <span className="muted">
          {done}/{subs.length}
        </span>
        <span className="spacer" />
        <Tooltip label="サブ課題を追加">
          <button className="icon-btn" onClick={() => setAdding(true)} aria-label="サブ課題を追加">
            <Plus size={14} />
          </button>
        </Tooltip>
      </div>
      {subs.length > 0 && (
        <div className="progress-bar thin">
          <div style={{ width: `${(done / subs.length) * 100}%` }} />
        </div>
      )}
      {subs.map((s) => (
        <div key={s.id} className="sub-row" onClick={() => navigate(p(`/issue/${identifier(s, teams)}`))}>
          <button
            className="row-icon-btn"
            data-popover-anchor
            onClick={(e) => {
              e.stopPropagation();
              openPicker({ kind: "status", issueIds: [s.id], anchor: e.currentTarget.getBoundingClientRect() });
            }}
          >
            <StateIcon stateId={s.stateId} />
          </button>
          <span className="row-id">{identifier(s, teams)}</span>
          <span className={cx("row-title-text", states[s.stateId]?.type === "completed" && "muted")}>{s.title}</span>
          <span className="spacer" />
          <Avatar user={s.assigneeId ? users[s.assigneeId] : null} size={18} />
        </div>
      ))}
      {adding && (
        <div className="sub-add">
          <StateIcon stateId={issue.stateId} />
          <input
            autoFocus
            value={title}
            placeholder="サブ課題のタイトル（Enter で追加、Esc で閉じる）"
            data-testid="sub-issue-input"
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return;
              if (e.key === "Enter") add();
              if (e.key === "Escape") {
                setAdding(false);
                setTitle("");
              }
            }}
            onBlur={() => !title.trim() && setAdding(false)}
          />
          <button className="link-btn" onMouseDown={(e) => e.preventDefault()} onClick={() => openCreateIssue({ teamId: issue.teamId, parentId: issue.id })}>
            詳しく作成
          </button>
        </div>
      )}
    </section>
  );
}

export function IssueDetail({ issueId, embedded, onClose }: { issueId: string; embedded?: boolean; onClose?: () => void }) {
  const issue = useData((s) => s.issues[issueId]);
  const teams = useData((s) => s.teams);
  const meId = useData((s) => s.meId);
  const threadState = useData((s) => s.threads[issueId]);
  const listIds = useUI((s) => s.listIds);
  const listLabel = useUI((s) => s.listLabel);
  const listPath = useUI((s) => s.listPath);
  const thread = useThread(issueId);
  const parent = useData((s) => (s.issues[issueId]?.parentId ? s.issues[s.issues[issueId].parentId!] : null));
  const navigate = useNavigate();
  const p = useWsPath();
  const [title, setTitle] = useState(issue?.title ?? "");
  const [menu, setMenu] = useState<DOMRect | null>(null);
  const descTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingDesc = useRef<string | null>(null);
  const titleFocused = useRef(false);

  useEffect(() => {
    engine.loadThread(issueId);
  }, [issueId]);

  // ショートカット（S / P / A / L など）の対象をこの課題にする
  useEffect(() => {
    useUI.setState({ focusedIssueId: issueId, selectedIssueIds: [] });
  }, [issueId]);

  useEffect(() => {
    if (issue && !titleFocused.current) setTitle(issue.title);
  }, [issue?.title]); // eslint-disable-line react-hooks/exhaustive-deps

  // 説明文は入力が止まったら保存。画面を離れるときにも保存する。
  const flushDesc = () => {
    if (descTimer.current) clearTimeout(descTimer.current);
    if (pendingDesc.current !== null) {
      updateIssues([issueId], { description: pendingDesc.current }, { undo: false });
      pendingDesc.current = null;
    }
  };
  useEffect(() => flushDesc, [issueId]); // eslint-disable-line react-hooks/exhaustive-deps

  const pos = listIds.indexOf(issueId);
  const go = (delta: number) => {
    if (pos < 0) return;
    const next = useData.getState().issues[listIds[pos + delta]];
    if (next) navigate(p(`/issue/${identifier(next, teams)}`), { replace: true });
  };
  useHotkeys(["j", "arrowdown"], () => go(1), { enabled: !embedded, scope: SCOPE.detail });
  useHotkeys(["k", "arrowup"], () => go(-1), { enabled: !embedded, scope: SCOPE.detail });
  useHotkeys(
    "escape",
    () => {
      if (embedded) return false;
      if (onClose) onClose();
      else if (listPath) navigate(listPath);
      else navigate(-1);
    },
    { scope: SCOPE.detail },
  );

  const comments = useMemo(() => thread.filter((t) => t.kind === "comment").length, [thread]);

  if (!issue) {
    return (
      <div className="detail-missing">
        <p>課題が見つかりません。削除されたか、URL が間違っている可能性があります。</p>
      </div>
    );
  }
  const team = teams[issue.teamId];
  const id = identifier(issue, teams);
  const subscribed = !!meId && issue.subscriberIds.includes(meId);
  const url = appUrl(p(`/issue/${id}`));

  return (
    <div className={cx("issue-detail", embedded && "embedded")} data-testid="issue-detail" data-identifier={id}>
      <div className="detail-topbar">
        {team && (
          <Link to={p(`/team/${team.key}/all`)} className="crumb">
            <TeamIcon team={team} size={16} />
            {team.name}
          </Link>
        )}
        <span className="crumb-sep">›</span>
        <span className="crumb current" data-testid="issue-identifier">
          {id}
        </span>
        {issue.archivedAt && <span className="chip danger-chip">削除済み</span>}
        <span className="spacer" />
        {!embedded && pos >= 0 && (
          <span className="detail-nav">
            <span className="muted small" title={listLabel}>
              {pos + 1} / {listIds.length}
            </span>
            <Tooltip label="前の課題" combo="k">
              <button className="icon-btn" onClick={() => go(-1)} disabled={pos <= 0} aria-label="前の課題">
                <ChevronUp size={15} />
              </button>
            </Tooltip>
            <Tooltip label="次の課題" combo="j">
              <button className="icon-btn" onClick={() => go(1)} disabled={pos >= listIds.length - 1} aria-label="次の課題">
                <ChevronDown size={15} />
              </button>
            </Tooltip>
          </span>
        )}
        {!embedded && <HelpVideoButton screen="issue" />}
        <Tooltip label={subscribed ? "通知の購読を解除" : "通知を購読"}>
          <button className="icon-btn" onClick={() => toggleSubscription(issue.id)} aria-label="通知の購読" data-testid="subscribe-toggle">
            {subscribed ? <Bell size={15} /> : <BellOff size={15} />}
          </button>
        </Tooltip>
        <Tooltip label="リンクをコピー">
          <button
            className="icon-btn"
            aria-label="リンクをコピー"
            onClick={() => copyText(url).then(() => toast(`${id} のリンクをコピーしました`))}
          >
            <Link2 size={15} />
          </button>
        </Tooltip>
        <button className="icon-btn" aria-label="その他の操作" data-popover-anchor onClick={(e) => setMenu(menu ? null : e.currentTarget.getBoundingClientRect())}>
          <MoreHorizontal size={15} />
        </button>
        {(embedded || onClose) && (
          <Tooltip label="閉じる" combo="escape">
            <button className="icon-btn" aria-label="閉じる" onClick={() => (onClose ? onClose() : navigate(p("/inbox")))}>
              <X size={15} />
            </button>
          </Tooltip>
        )}
      </div>

      <div className="detail-layout">
        <div className="detail-main">
          <div className="detail-content">
            {parent && (
              <Link to={p(`/issue/${identifier(parent, teams)}`)} className="parent-link">
                <CornerLeftUp size={13} />
                <span className="row-id">{identifier(parent, teams)}</span>
                {parent.title}
              </Link>
            )}
            <AutoTextarea
              className="detail-title"
              value={title}
              data-testid="issue-title"
              placeholder="課題のタイトル"
              onFocus={() => (titleFocused.current = true)}
              onChange={(e) => setTitle(e.target.value.replace(/\n/g, ""))}
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing) return;
                if (e.key === "Enter") {
                  e.preventDefault();
                  (e.target as HTMLTextAreaElement).blur();
                }
                if (e.key === "Escape") {
                  setTitle(issue.title);
                  (e.target as HTMLTextAreaElement).blur();
                }
              }}
              onBlur={() => {
                titleFocused.current = false;
                const t = title.trim();
                if (t && t !== issue.title) updateIssues([issue.id], { title: t });
                else setTitle(issue.title);
              }}
            />
            <Editor
              key={issue.id}
              value={issue.description}
              placeholder="説明を追加…（Markdown 記法が使えます）"
              className="detail-description"
              testId="issue-description"
              onChange={(html) => {
                pendingDesc.current = html;
                if (descTimer.current) clearTimeout(descTimer.current);
                descTimer.current = setTimeout(flushDesc, 700);
              }}
              onBlur={flushDesc}
            />
            <SubIssues issue={issue} />

            <section className="activity" data-testid="activity">
              <div className="section-title">
                アクティビティ
                {comments > 0 && <span className="muted">コメント {comments}件</span>}
                <span className="spacer" />
                <button className="link-btn" onClick={() => toggleSubscription(issue.id)}>
                  {subscribed ? "購読を解除" : "購読する"}
                </button>
              </div>
              {threadState !== "loaded" && !thread.length ? (
                <div className="activity-loading">
                  <Spinner size={14} /> 読み込み中…
                </div>
              ) : (
                thread.map((t) =>
                  t.kind === "comment" ? <CommentCard key={t.item.id} c={t.item} /> : <ActivityLine key={t.item.id} a={t.item} />,
                )
              )}
              <CommentComposer issueId={issue.id} />
            </section>
          </div>
        </div>
        <Properties issue={issue} />
      </div>

      {menu && (
        <Menu
          anchor={menu}
          placement="bottom-end"
          onClose={() => setMenu(null)}
          items={[
            { label: "ID をコピー", icon: <Copy size={14} />, combo: "mod+.", onSelect: () => copyText(id).then(() => toast(`${id} をコピーしました`)) },
            { label: "リンクをコピー", icon: <Link2 size={14} />, onSelect: () => copyText(url).then(() => toast("リンクをコピーしました")) },
            { label: "別のチームに移動", icon: <ArrowRightLeft size={14} />, onSelect: () => openPicker({ kind: "team", issueIds: [issue.id], anchor: menu }) },
            "divider",
            issue.archivedAt
              ? { label: "復元", icon: <RotateCcw size={14} />, onSelect: () => restoreIssues([issue.id]) }
              : {
                  label: "削除",
                  icon: <Trash2 size={14} />,
                  combo: "mod+backspace",
                  danger: true,
                  onSelect: () => {
                    archiveIssues([issue.id]);
                    toast(`${id} を削除しました`, { action: { label: "元に戻す", run: () => restoreIssues([issue.id]) } });
                    if (!embedded) navigate(listPath || p("/my-issues"));
                  },
                },
          ]}
        />
      )}
    </div>
  );
}
