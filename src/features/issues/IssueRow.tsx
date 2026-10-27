import { memo, type MouseEvent } from "react";
import { Check } from "lucide-react";
import type { Issue } from "../../../shared/types";
import { useData } from "../../store/data";
import { openPicker, useUI, type PickerKind } from "../../store/ui";
import type { PropKey } from "../../store/view";
import { cx, formatDate, identifier } from "../../lib/utils";
import { PriorityIcon } from "../../components/icons";
import { StateIcon } from "../../components/pickers";
import { Avatar } from "../../components/ui";
import { CycleChip, DueChip, EstimateChip, LabelChips, ProjectChip, SubIssueCount } from "./chips";

export function pickFrom(e: MouseEvent, kind: PickerKind, issueId: string) {
  e.stopPropagation();
  e.preventDefault();
  const ui = useUI.getState();
  const ids = ui.selectedIssueIds.includes(issueId) ? ui.selectedIssueIds : [issueId];
  openPicker({ kind, issueIds: ids, anchor: (e.currentTarget as HTMLElement).getBoundingClientRect() });
}

export const IssueRow = memo(function IssueRow({
  issue,
  props,
  focused,
  selected,
  onOpen,
  onMouseMove,
  onSelectToggle,
  onContextMenu,
  rowRef,
  dragProps,
  dragging,
  dropBefore,
}: {
  issue: Issue;
  props: Record<PropKey, boolean>;
  focused: boolean;
  selected: boolean;
  onOpen: (issue: Issue, e: MouseEvent) => void;
  onMouseMove: (id: string, e: MouseEvent) => void;
  onSelectToggle: (id: string, e: MouseEvent) => void;
  onContextMenu: (id: string, e: MouseEvent) => void;
  rowRef?: (el: HTMLElement | null) => void;
  dragProps?: Record<string, unknown>;
  dragging?: boolean;
  dropBefore?: boolean;
}) {
  const teams = useData((s) => s.teams);
  const assignee = useData((s) => (issue.assigneeId ? s.users[issue.assigneeId] : null));
  const stateType = useData((s) => s.states[issue.stateId]?.type);
  const done = stateType === "completed" || stateType === "canceled";
  const id = identifier(issue, teams);
  return (
    <div
      ref={rowRef}
      {...dragProps}
      className={cx("issue-row", focused && "focused", selected && "selected", done && "done", dragging && "dragging", dropBefore && "drop-before")}
      data-issue-id={issue.id}
      data-testid="issue-row"
      data-identifier={id}
      role="row"
      aria-selected={selected}
      onClick={(e) => onOpen(issue, e)}
      onMouseMove={(e) => onMouseMove(issue.id, e)}
      onContextMenu={(e) => onContextMenu(issue.id, e)}
    >
      <button
        className={cx("row-check", selected && "checked")}
        aria-label="選択"
        onClick={(e) => {
          e.stopPropagation();
          onSelectToggle(issue.id, e);
        }}
      >
        {selected && <Check size={11} strokeWidth={3} />}
      </button>
      {props.priority && (
        <button className="row-icon-btn" data-popover-anchor title="優先度（P）" onClick={(e) => pickFrom(e, "priority", issue.id)}>
          <PriorityIcon priority={issue.priority} />
        </button>
      )}
      {props.id && <span className="row-id">{id}</span>}
      {props.status && (
        <button className="row-icon-btn" data-popover-anchor title="ステータス（S）" onClick={(e) => pickFrom(e, "status", issue.id)}>
          <StateIcon stateId={issue.stateId} />
        </button>
      )}
      <span className="row-title">
        <span className="row-title-text">{issue.title}</span>
        <SubIssueCount issue={issue} />
      </span>
      <span className="row-props">
        {props.labels && <LabelChips ids={issue.labelIds} />}
        {props.project && <ProjectChip projectId={issue.projectId} />}
        {props.cycle && <CycleChip cycleId={issue.cycleId} />}
        {props.dueDate && <DueChip due={issue.dueDate} done={done} />}
        {props.estimate && <EstimateChip estimate={issue.estimate} />}
        {props.created && (
          <span className="row-date" title={`作成：${new Date(issue.createdAt).toLocaleString("ja-JP")}`}>
            {formatDate(issue.createdAt)}
          </span>
        )}
        {props.assignee && (
          <button className="row-icon-btn row-assignee" data-popover-anchor title="担当者（A）" onClick={(e) => pickFrom(e, "assignee", issue.id)}>
            <Avatar user={assignee} size={18} />
          </button>
        )}
      </span>
    </div>
  );
});
