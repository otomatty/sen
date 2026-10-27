import { BarChart3, Box, CalendarDays, CircleDashed, Copy, Link2, Tag, Trash2, User, UserCheck, X } from "lucide-react";
import { useData } from "../../store/data";
import { archiveIssues, restoreIssues, updateIssues } from "../../store/actions";
import { openPicker, toast, useUI } from "../../store/ui";
import { appUrl, copyText, identifier } from "../../lib/utils";
import { useParams } from "react-router";
import { Kbd, Menu, Tooltip } from "../../components/ui";
import { CycleIcon } from "../../components/icons";

export function IssueContextMenu() {
  const cm = useUI((s) => s.contextMenu);
  const teams = useData((s) => s.teams);
  const issues = useData((s) => s.issues);
  const meId = useData((s) => s.meId);
  const { ws } = useParams();
  if (!cm) return null;
  const ids = cm.issueIds;
  const anchor = { x: cm.x, y: cm.y };
  const rect = new DOMRect(cm.x, cm.y, 0, 0);
  const close = () => useUI.setState({ contextMenu: null });
  const first = issues[ids[0]];
  return (
    <Menu
      anchor={anchor}
      onClose={close}
      items={[
        { label: "ステータス", icon: <CircleDashed size={14} />, combo: "s", onSelect: () => openPicker({ kind: "status", issueIds: ids, anchor: rect }) },
        { label: "優先度", icon: <BarChart3 size={14} />, combo: "p", onSelect: () => openPicker({ kind: "priority", issueIds: ids, anchor: rect }) },
        { label: "担当者", icon: <User size={14} />, combo: "a", onSelect: () => openPicker({ kind: "assignee", issueIds: ids, anchor: rect }) },
        { label: "ラベル", icon: <Tag size={14} />, combo: "l", onSelect: () => openPicker({ kind: "labels", issueIds: ids, anchor: rect }) },
        { label: "プロジェクト", icon: <Box size={14} />, combo: "shift+p", onSelect: () => openPicker({ kind: "project", issueIds: ids, anchor: rect }) },
        { label: "サイクル", icon: <CycleIcon size={14} progress={0.5} />, combo: "shift+c", onSelect: () => openPicker({ kind: "cycle", issueIds: ids, anchor: rect }) },
        { label: "期日", icon: <CalendarDays size={14} />, combo: "shift+d", onSelect: () => openPicker({ kind: "dueDate", issueIds: ids, anchor: rect }) },
        "divider",
        { label: "自分に割り当てる", icon: <UserCheck size={14} />, combo: "i", onSelect: () => meId && updateIssues(ids, { assigneeId: meId }) },
        ...(ids.length === 1 && first
          ? [
              {
                label: "ID をコピー",
                icon: <Copy size={14} />,
                combo: "mod+.",
                onSelect: () => copyText(identifier(first, teams)).then(() => toast("ID をコピーしました")),
              },
              {
                label: "リンクをコピー",
                icon: <Link2 size={14} />,
                onSelect: () =>
                  copyText(appUrl(`/${ws}/issue/${identifier(first, teams)}`)).then(() => toast("リンクをコピーしました")),
              },
            ]
          : []),
        "divider",
        {
          label: ids.length > 1 ? `${ids.length}件を削除` : "削除",
          icon: <Trash2 size={14} />,
          combo: "mod+backspace",
          danger: true,
          onSelect: () => {
            archiveIssues(ids);
            toast(ids.length > 1 ? `${ids.length}件の課題を削除しました` : "課題を削除しました", {
              action: { label: "元に戻す", run: () => restoreIssues(ids) },
            });
            useUI.setState({ selectedIssueIds: [] });
          },
        },
      ]}
    />
  );
}

export function SelectionBar() {
  const selected = useUI((s) => s.selectedIssueIds);
  if (selected.length === 0) return null;
  const btn = (label: string, kind: Parameters<typeof openPicker>[0]["kind"], combo: string, icon: React.ReactNode) => (
    <Tooltip label={label} combo={combo} side="top">
      <button
        className="selbar-btn"
        data-popover-anchor
        onClick={(e) => openPicker({ kind, issueIds: selected, anchor: e.currentTarget.getBoundingClientRect() })}
      >
        {icon}
        <span>{label}</span>
      </button>
    </Tooltip>
  );
  return (
    <div className="selection-bar" data-testid="selection-bar">
      <span className="selbar-count">
        <b>{selected.length}</b>件を選択中
      </span>
      <span className="selbar-sep" />
      {btn("ステータス", "status", "s", <CircleDashed size={14} />)}
      {btn("優先度", "priority", "p", <BarChart3 size={14} />)}
      {btn("担当者", "assignee", "a", <User size={14} />)}
      {btn("ラベル", "labels", "l", <Tag size={14} />)}
      {btn("プロジェクト", "project", "shift+p", <Box size={14} />)}
      <Tooltip label="削除" combo="mod+backspace" side="top">
        <button
          className="selbar-btn danger"
          onClick={() => {
            archiveIssues(selected);
            toast(`${selected.length}件の課題を削除しました`, { action: { label: "元に戻す", run: () => restoreIssues(selected) } });
            useUI.setState({ selectedIssueIds: [] });
          }}
        >
          <Trash2 size={14} />
        </button>
      </Tooltip>
      <span className="selbar-sep" />
      <Tooltip label="選択を解除" combo="escape" side="top">
        <button className="selbar-btn" onClick={() => useUI.setState({ selectedIssueIds: [] })} aria-label="選択を解除">
          <X size={14} />
        </button>
      </Tooltip>
      <span className="selbar-hint">
        <Kbd combo="x" /> で選択
      </span>
    </div>
  );
}
