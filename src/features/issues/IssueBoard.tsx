import { useCallback, useMemo, useState, type MouseEvent } from "react";
import { useNavigate } from "react-router";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  pointerWithin,
  rectIntersection,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { Plus } from "lucide-react";
import type { Issue } from "../../../shared/types";
import { useData } from "../../store/data";
import { updateIssues } from "../../store/actions";
import { openCreateIssue, useUI } from "../../store/ui";
import type { IssueGroup, ViewOptions } from "../../store/view";
import { cx, identifier } from "../../lib/utils";
import { PriorityIcon } from "../../components/icons";
import { StateIcon } from "../../components/pickers";
import { Avatar, Tooltip } from "../../components/ui";
import { useWsPath } from "../../app/hooks";
import { DueChip, EstimateChip, LabelChips, ProjectChip, SubIssueCount } from "./chips";
import { GroupIcon, useListNavigation } from "./IssueList";
import { pickFrom } from "./IssueRow";

function Card({
  issue,
  view,
  focused,
  selected,
  overlay,
  onOpen,
  onMouseMove,
  onContextMenu,
}: {
  issue: Issue;
  view: ViewOptions;
  focused?: boolean;
  selected?: boolean;
  overlay?: boolean;
  onOpen?: (issue: Issue, e: MouseEvent) => void;
  onMouseMove?: (id: string, e: MouseEvent) => void;
  onContextMenu?: (id: string, e: MouseEvent) => void;
}) {
  const teams = useData((s) => s.teams);
  const assignee = useData((s) => (issue.assigneeId ? s.users[issue.assigneeId] : null));
  const stateType = useData((s) => s.states[issue.stateId]?.type);
  const done = stateType === "completed" || stateType === "canceled";
  const { setNodeRef: dragRef, listeners, attributes, isDragging } = useDraggable({ id: issue.id, disabled: overlay });
  const { setNodeRef: dropRef, isOver } = useDroppable({ id: `card:${issue.id}`, disabled: overlay });
  const props = view.props;
  return (
    <div
      ref={(el) => {
        dragRef(el);
        dropRef(el);
      }}
      {...(overlay ? {} : listeners)}
      {...(overlay ? {} : attributes)}
      className={cx("board-card", focused && "focused", selected && "selected", isDragging && "dragging", overlay && "overlay", isOver && "drop-before")}
      data-issue-id={issue.id}
      data-testid="board-card"
      data-identifier={identifier(issue, teams)}
      onClick={(e) => onOpen?.(issue, e)}
      onMouseMove={(e) => onMouseMove?.(issue.id, e)}
      onContextMenu={(e) => onContextMenu?.(issue.id, e)}
      role="button"
      tabIndex={-1}
    >
      <div className="card-top">
        <span className="row-id">{identifier(issue, teams)}</span>
        <span className="spacer" />
        {props.assignee && (
          <button className="row-icon-btn" data-popover-anchor onPointerDown={(e) => e.stopPropagation()} onClick={(e) => pickFrom(e, "assignee", issue.id)}>
            <Avatar user={assignee} size={18} />
          </button>
        )}
      </div>
      <div className="card-title">
        {props.status && (
          <button className="row-icon-btn" data-popover-anchor onPointerDown={(e) => e.stopPropagation()} onClick={(e) => pickFrom(e, "status", issue.id)}>
            <StateIcon stateId={issue.stateId} />
          </button>
        )}
        <span className={cx(done && "muted")}>{issue.title}</span>
      </div>
      <div className="card-props">
        {props.priority && (
          <button className="chip chip-btn-icon" data-popover-anchor onPointerDown={(e) => e.stopPropagation()} onClick={(e) => pickFrom(e, "priority", issue.id)}>
            <PriorityIcon priority={issue.priority} size={13} />
          </button>
        )}
        <SubIssueCount issue={issue} />
        {props.labels && <LabelChips ids={issue.labelIds} max={2} />}
        {props.project && <ProjectChip projectId={issue.projectId} />}
        {props.dueDate && <DueChip due={issue.dueDate} done={done} />}
        {props.estimate && <EstimateChip estimate={issue.estimate} />}
      </div>
    </div>
  );
}

function Column({
  group,
  children,
  teamId,
  canDrop,
}: {
  group: IssueGroup;
  children: React.ReactNode;
  teamId?: string | null;
  canDrop: boolean;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: `col:${group.key}`, disabled: !canDrop });
  return (
    <div className={cx("board-column", isOver && canDrop && "over")} data-testid="board-column" data-group={group.label}>
      <div className="board-column-head">
        <GroupIcon group={group} />
        <span className="group-label">{group.label}</span>
        <span className="group-count">{group.issues.length}</span>
        <span className="spacer" />
        <Tooltip label="課題を作成">
          <button className="icon-btn" aria-label="課題を作成" onClick={() => openCreateIssue({ teamId: teamId ?? undefined, ...group.defaults })}>
            <Plus size={14} />
          </button>
        </Tooltip>
      </div>
      <div ref={setNodeRef} className="board-column-body">
        {children}
      </div>
    </div>
  );
}

export function IssueBoard({
  groups,
  view,
  listLabel,
  teamId,
}: {
  groups: IssueGroup[];
  view: ViewOptions;
  listLabel: string;
  teamId?: string | null;
}) {
  const navigate = useNavigate();
  const p = useWsPath();
  const teams = useData((s) => s.teams);
  const issuesMap = useData((s) => s.issues);
  const selected = useUI((s) => s.selectedIssueIds);
  const [dragId, setDragId] = useState<string | null>(null);
  const [, setOver] = useState<string | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const flatIds = useMemo(() => groups.flatMap((g) => g.issues.map((i) => i.id)), [groups]);
  const open = useCallback((issue: Issue) => navigate(p(`/issue/${identifier(issue, teams)}`)), [navigate, p, teams]);
  const nav = useListNavigation(flatIds, { label: listLabel, onOpen: (id) => issuesMap[id] && open(issuesMap[id]) });

  const groupOf = (issueId: string) => groups.find((g) => g.issues.some((i) => i.id === issueId));

  const collision: CollisionDetection = (args) => {
    const within = pointerWithin(args);
    const cards = within.filter((c) => String(c.id).startsWith("card:"));
    if (cards.length) return cards;
    return within.length ? within : rectIntersection(args);
  };

  const onDragStart = (e: DragStartEvent) => setDragId(String(e.active.id));
  const onDragOver = (e: DragOverEvent) => setOver(e.over ? String(e.over.id) : null);
  const onDragEnd = (e: DragEndEvent) => {
    setDragId(null);
    setOver(null);
    const id = String(e.active.id);
    const overId = e.over ? String(e.over.id) : null;
    if (!overId) return;
    const issue = issuesMap[id];
    if (!issue) return;
    let target: IssueGroup | undefined;
    let beforeId: string | null = null;
    if (overId.startsWith("card:")) {
      beforeId = overId.slice(5);
      if (beforeId === id) return;
      target = groupOf(beforeId);
    } else target = groups.find((g) => `col:${g.key}` === overId);
    if (!target || !target.patchFor) return;
    const patch: Partial<Issue> = { ...target.patchFor(issue) };
    if (view.ordering === "manual") {
      const list = target.issues.filter((i) => i.id !== id);
      const idx = beforeId ? list.findIndex((i) => i.id === beforeId) : list.length;
      const prev = list[idx - 1]?.sortOrder;
      const next = list[idx]?.sortOrder;
      patch.sortOrder =
        prev === undefined && next === undefined ? 0 : prev === undefined ? next! - 1 : next === undefined ? prev + 1 : (prev + next) / 2;
    }
    const ids = selected.includes(id) ? selected : [id];
    updateIssues(ids, (i) => (i.id === id ? patch : target!.patchFor!(i)));
  };

  const onCardClick = (issue: Issue, e: MouseEvent) => {
    if (e.metaKey || e.ctrlKey) return nav.toggleSelect(issue.id);
    if (e.shiftKey) return nav.rangeSelect(issue.id);
    open(issue);
  };
  const onContextMenu = (id: string, e: MouseEvent) => {
    e.preventDefault();
    const sel = useUI.getState().selectedIssueIds;
    useUI.setState({ contextMenu: { x: e.clientX, y: e.clientY, issueIds: sel.includes(id) ? sel : [id] }, focusedIssueId: id });
  };

  const dragging = dragId ? issuesMap[dragId] : null;
  return (
    <DndContext sensors={sensors} collisionDetection={collision} onDragStart={onDragStart} onDragOver={onDragOver} onDragEnd={onDragEnd} onDragCancel={() => setDragId(null)}>
      <div className="board" data-testid="board">
        {groups.map((g) => (
          <Column key={g.key} group={g} teamId={teamId} canDrop={!!g.patchFor}>
            {g.issues.map((issue) => (
              <Card
                key={issue.id}
                issue={issue}
                view={view}
                focused={nav.focusedId === issue.id}
                selected={selected.includes(issue.id)}
                onOpen={onCardClick}
                onMouseMove={nav.onMouseMove}
                onContextMenu={onContextMenu}
              />
            ))}
            {!g.issues.length && <div className="board-empty">課題はありません</div>}
          </Column>
        ))}
      </div>
      <DragOverlay dropAnimation={{ duration: 160, easing: "cubic-bezier(.2,.8,.2,1)" }}>
        {dragging ? <Card issue={dragging} view={view} overlay /> : null}
      </DragOverlay>
    </DndContext>
  );
}
