import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from "react";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  pointerWithin,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { useLocation, useNavigate } from "react-router";
import { ChevronDown, ChevronRight, Plus } from "lucide-react";
import type { Issue } from "../../../shared/types";
import { useData } from "../../store/data";
import { openCreateIssue, toast, useUI } from "../../store/ui";
import { updateIssues } from "../../store/actions";
import type { IssueGroup, ViewOptions } from "../../store/view";
import { SCOPE, useHotkeys } from "../../lib/hotkeys";
import { cx, identifier, readLocal, writeLocal } from "../../lib/utils";
import { Avatar, Tooltip } from "../../components/ui";
import { CycleIcon, LabelDot, PriorityIcon, ProjectIcon } from "../../components/icons";
import { StateIcon } from "../../components/pickers";
import { useWsPath } from "../../app/hooks";
import { IssueRow } from "./IssueRow";

export function GroupIcon({ group }: { group: IssueGroup }) {
  const users = useData((s) => s.users);
  const projects = useData((s) => s.projects);
  const labels = useData((s) => s.labels);
  switch (group.kind) {
    case "status":
      return <StateIcon stateId={String(group.value)} />;
    case "priority":
      return <PriorityIcon priority={Number(group.value)} />;
    case "assignee":
      return <Avatar user={group.value ? users[String(group.value)] : null} size={16} />;
    case "project": {
      const p = group.value ? projects[String(group.value)] : null;
      return p ? <ProjectIcon color={p.color} status={p.status} /> : <ProjectIcon color="var(--text-tertiary)" />;
    }
    case "label": {
      const l = group.value ? labels[String(group.value)] : null;
      return <LabelDot color={l?.color ?? "var(--text-tertiary)"} />;
    }
    case "cycle":
      return <CycleIcon size={14} progress={0.5} />;
    default:
      return null;
  }
}

/** 一覧共通のキーボード操作・選択・フォーカス管理 */
export function useListNavigation(ids: string[], opts: { enabled?: boolean; label: string; onOpen: (id: string) => void }) {
  const focusedId = useUI((s) => s.focusedIssueId);
  const location = useLocation();
  const lastMouse = useRef({ x: -1, y: -1 });
  const anchorId = useRef<string | null>(null);

  // 詳細画面の「前へ / 次へ」のため、今の並びを共有する
  useEffect(() => {
    if (opts.enabled === false) return;
    useUI.setState({ listIds: ids, listLabel: opts.label, listPath: location.pathname + location.search });
  }, [ids, opts.label, opts.enabled, location.pathname, location.search]);

  useEffect(() => {
    return () => {
      useUI.setState({ selectedIssueIds: [] });
    };
  }, []);

  const scrollTo = (id: string) => {
    requestAnimationFrame(() => {
      document.querySelector(`[data-issue-id="${id}"]`)?.scrollIntoView({ block: "nearest" });
    });
  };

  const move = (delta: number, extend = false) => {
    if (!ids.length) return;
    const cur = useUI.getState().focusedIssueId;
    let idx = cur ? ids.indexOf(cur) : -1;
    idx = idx < 0 ? (delta > 0 ? 0 : ids.length - 1) : Math.min(ids.length - 1, Math.max(0, idx + delta));
    const next = ids[idx];
    if (extend) {
      const sel = new Set(useUI.getState().selectedIssueIds);
      if (cur) sel.add(cur);
      sel.add(next);
      useUI.setState({ selectedIssueIds: [...sel] });
    }
    useUI.setState({ focusedIssueId: next });
    scrollTo(next);
  };

  const enabled = opts.enabled !== false;
  useHotkeys(["j", "arrowdown"], () => move(1), { enabled, scope: SCOPE.view });
  useHotkeys(["k", "arrowup"], () => move(-1), { enabled, scope: SCOPE.view });
  useHotkeys(["shift+j", "shift+arrowdown"], () => move(1, true), { enabled, scope: SCOPE.view });
  useHotkeys(["shift+k", "shift+arrowup"], () => move(-1, true), { enabled, scope: SCOPE.view });
  useHotkeys(
    ["enter", "o"],
    () => {
      const id = useUI.getState().focusedIssueId;
      if (!id || !ids.includes(id)) return false;
      opts.onOpen(id);
    },
    { enabled, scope: SCOPE.view },
  );
  useHotkeys(
    "x",
    () => {
      const id = useUI.getState().focusedIssueId;
      if (!id || !ids.includes(id)) return false;
      toggleSelect(id);
    },
    { enabled, scope: SCOPE.view },
  );
  useHotkeys("mod+a", () => useUI.setState({ selectedIssueIds: [...ids] }), { enabled, scope: SCOPE.view });
  useHotkeys(
    "escape",
    () => {
      if (!useUI.getState().selectedIssueIds.length) return false;
      useUI.setState({ selectedIssueIds: [] });
    },
    { enabled, scope: SCOPE.view },
  );

  const toggleSelect = (id: string) => {
    const sel = useUI.getState().selectedIssueIds;
    useUI.setState({ selectedIssueIds: sel.includes(id) ? sel.filter((x) => x !== id) : [...sel, id] });
    anchorId.current = id;
  };

  const rangeSelect = (id: string) => {
    const from = anchorId.current ?? useUI.getState().focusedIssueId ?? id;
    const a = ids.indexOf(from);
    const b = ids.indexOf(id);
    if (a < 0 || b < 0) return toggleSelect(id);
    const [s, e] = a < b ? [a, b] : [b, a];
    const sel = new Set(useUI.getState().selectedIssueIds);
    ids.slice(s, e + 1).forEach((x) => sel.add(x));
    useUI.setState({ selectedIssueIds: [...sel] });
  };

  const onMouseMove = useCallback((id: string, e: MouseEvent) => {
    // スクロールで行が動いただけのときはフォーカスを変えない
    if (lastMouse.current.x === e.clientX && lastMouse.current.y === e.clientY) return;
    lastMouse.current = { x: e.clientX, y: e.clientY };
    if (useUI.getState().focusedIssueId !== id) useUI.setState({ focusedIssueId: id });
  }, []);

  return { focusedId, toggleSelect, rangeSelect, onMouseMove };
}

/** ドラッグで並べ替え・別グループへ移動できる行 */
function DraggableRow(props: Parameters<typeof IssueRow>[0] & { groupKey: string; dndEnabled: boolean }) {
  const { groupKey, dndEnabled, ...rest } = props;
  const id = `${groupKey}::${props.issue.id}`;
  const { setNodeRef: dragRef, listeners, attributes, isDragging } = useDraggable({ id, disabled: !dndEnabled });
  const { setNodeRef: dropRef, isOver } = useDroppable({ id: `row:${id}`, disabled: !dndEnabled });
  return (
    <IssueRow
      {...rest}
      rowRef={(el) => {
        dragRef(el);
        dropRef(el);
      }}
      dragProps={dndEnabled ? { ...listeners, ...attributes, role: "row", tabIndex: -1 } : undefined}
      dragging={isDragging}
      dropBefore={isOver && !isDragging}
    />
  );
}

function GroupDropZone({ groupKey, enabled, children }: { groupKey: string; enabled: boolean; children: ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id: `group:${groupKey}`, disabled: !enabled });
  return (
    <div ref={setNodeRef} className={cx(isOver && enabled && "group-drop-over")}>
      {children}
    </div>
  );
}

export function IssueList({
  groups,
  view,
  listKey,
  listLabel,
  teamId,
  empty,
  onOpenIssue,
  keyboard = true,
  hideGroupHeaders,
}: {
  groups: IssueGroup[];
  view: ViewOptions;
  listKey: string;
  listLabel: string;
  teamId?: string | null;
  empty?: ReactNode;
  onOpenIssue?: (issue: Issue) => void;
  keyboard?: boolean;
  hideGroupHeaders?: boolean;
}) {
  const navigate = useNavigate();
  const p = useWsPath();
  const teams = useData((s) => s.teams);
  const issuesMap = useData((s) => s.issues);
  const selected = useUI((s) => s.selectedIssueIds);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => readLocal(`sen:collapsed:${listKey}`, {}));
  useEffect(() => setCollapsed(readLocal(`sen:collapsed:${listKey}`, {})), [listKey]);

  const flatIds = useMemo(() => {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const g of groups) {
      if (collapsed[g.key]) continue;
      for (const i of g.issues)
        if (!seen.has(i.id)) {
          seen.add(i.id);
          out.push(i.id);
        }
    }
    return out;
  }, [groups, collapsed]);

  const open = useCallback(
    (issue: Issue) => {
      if (onOpenIssue) onOpenIssue(issue);
      else navigate(p(`/issue/${identifier(issue, teams)}`));
    },
    [onOpenIssue, navigate, p, teams],
  );

  const nav = useListNavigation(flatIds, {
    enabled: keyboard,
    label: listLabel,
    onOpen: (id) => issuesMap[id] && open(issuesMap[id]),
  });

  const onRowClick = useCallback(
    (issue: Issue, e: MouseEvent) => {
      if (e.metaKey || e.ctrlKey) return nav.toggleSelect(issue.id);
      if (e.shiftKey) return nav.rangeSelect(issue.id);
      if (useUI.getState().selectedIssueIds.length) return nav.toggleSelect(issue.id);
      open(issue);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [open, flatIds],
  );

  const onSelectToggle = useCallback(
    (id: string, e: MouseEvent) => (e.shiftKey ? nav.rangeSelect(id) : nav.toggleSelect(id)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [flatIds],
  );

  const onContextMenu = useCallback((id: string, e: MouseEvent) => {
    e.preventDefault();
    const sel = useUI.getState().selectedIssueIds;
    const ids = sel.includes(id) ? sel : [id];
    useUI.setState({ contextMenu: { x: e.clientX, y: e.clientY, issueIds: ids }, focusedIssueId: id });
  }, []);

  const toggleGroup = (key: string) => {
    const next = { ...collapsed, [key]: !collapsed[key] };
    setCollapsed(next);
    writeLocal(`sen:collapsed:${listKey}`, next);
  };

  // ---- ドラッグ＆ドロップ（別のグループへ移す / 手動の並び順で並べ替える） ----
  const dndEnabled = !hideGroupHeaders && (view.grouping !== "none" || view.ordering === "manual") && view.grouping !== "label";
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const [dragId, setDragId] = useState<string | null>(null);
  const onDragEnd = (e: DragEndEvent) => {
    setDragId(null);
    const [fromKey, issueId] = String(e.active.id).split("::");
    const over = e.over ? String(e.over.id) : null;
    if (!over || !issuesMap[issueId]) return;
    let targetKey: string;
    let beforeId: string | null = null;
    if (over.startsWith("row:")) {
      const [k, id] = over.slice(4).split("::");
      targetKey = k;
      beforeId = id;
      if (id === issueId) return;
    } else targetKey = over.slice(6);
    const target = groups.find((g) => g.key === targetKey);
    if (!target) return;
    const sameGroup = targetKey === fromKey;
    if (sameGroup && view.ordering !== "manual") {
      toast("並び順を「手動」にすると、ドラッグで順番を入れ替えられます（表示 → 並び順）");
      return;
    }
    if (!sameGroup && !target.patchFor) return;
    const sel = useUI.getState().selectedIssueIds;
    const ids = sel.includes(issueId) ? sel : [issueId];
    let sortOrder: number | undefined;
    if (view.ordering === "manual") {
      const list = target.issues.filter((i) => !ids.includes(i.id));
      const idx = beforeId ? list.findIndex((i) => i.id === beforeId) : list.length;
      const prev = list[idx - 1]?.sortOrder;
      const next = list[idx]?.sortOrder;
      sortOrder = prev === undefined && next === undefined ? 0 : prev === undefined ? next! - 1 : next === undefined ? prev + 1 : (prev + next) / 2;
    }
    updateIssues(ids, (i) => ({
      ...(!sameGroup && target.patchFor ? target.patchFor(i) : {}),
      ...(sortOrder !== undefined && i.id === issueId ? { sortOrder } : {}),
    }));
  };
  const dragIssue = dragId ? issuesMap[dragId.split("::")[1]] : null;

  const total = groups.reduce((n, g) => n + g.issues.length, 0);
  if (!total && empty) return <>{empty}</>;

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={(args) => {
        const hits = pointerWithin(args);
        const rows = hits.filter((h) => String(h.id).startsWith("row:"));
        return rows.length ? rows : hits;
      }}
      onDragStart={(e) => setDragId(String(e.active.id))}
      onDragEnd={onDragEnd}
      onDragCancel={() => setDragId(null)}
    >
    <div className="issue-list" role="grid" data-testid="issue-list">
      {groups.map((g) => (
        <section key={g.key} className="issue-group" data-testid="issue-group" data-group={g.label}>
          <GroupDropZone groupKey={g.key} enabled={dndEnabled && !!g.patchFor}>
          {!hideGroupHeaders && view.grouping !== "none" && (
            <div className="group-header" onClick={() => toggleGroup(g.key)}>
              <span className="group-chevron">{collapsed[g.key] ? <ChevronRight size={13} /> : <ChevronDown size={13} />}</span>
              <GroupIcon group={g} />
              <span className="group-label">{g.label}</span>
              <span className="group-count">{g.issues.length}</span>
              <span className="spacer" />
              <Tooltip label="このグループに課題を作成">
                <button
                  className="icon-btn group-add"
                  aria-label="課題を作成"
                  onClick={(e) => {
                    e.stopPropagation();
                    openCreateIssue({ teamId: teamId ?? undefined, ...g.defaults });
                  }}
                >
                  <Plus size={14} />
                </button>
              </Tooltip>
            </div>
          )}
          {!collapsed[g.key] &&
            g.issues.map((issue) => (
              <DraggableRow
                key={`${g.key}:${issue.id}`}
                groupKey={g.key}
                dndEnabled={dndEnabled}
                issue={issue}
                props={view.props}
                focused={nav.focusedId === issue.id}
                selected={selected.includes(issue.id)}
                onOpen={onRowClick}
                onMouseMove={nav.onMouseMove}
                onSelectToggle={onSelectToggle}
                onContextMenu={onContextMenu}
              />
            ))}
          </GroupDropZone>
        </section>
      ))}
    </div>
      <DragOverlay dropAnimation={null}>
        {dragIssue ? (
          <div className="row-drag-ghost">
            <span className="row-id">{identifier(dragIssue, teams)}</span>
            <span className="row-title-text">{dragIssue.title}</span>
            {selected.length > 1 && selected.includes(dragIssue.id) && <span className="chip">{selected.length}件</span>}
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}

export function useSelectedCount() {
  return useUI((s) => s.selectedIssueIds.length);
}

export function GroupHeaderPlain({ children, count }: { children: ReactNode; count?: number }) {
  return (
    <div className={cx("group-header", "plain")}>
      <span className="group-label">{children}</span>
      {count !== undefined && <span className="group-count">{count}</span>}
    </div>
  );
}
