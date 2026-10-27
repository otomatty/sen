import { useMemo, useState, type ReactNode } from "react";
import { CircleSlash, Columns3, Filter, List, SlidersHorizontal, X, User as UserIcon, Tag, Box, Users, BarChart3, CircleDashed } from "lucide-react";
import { PRIORITY_ORDER, priorityLabel } from "../../../shared/constants";
import { useData } from "../../store/data";
import { cycleName, sortStates, useCycles, useLabels, useMembers, useProjects, useTeams } from "../../store/selectors";
import { stateKey, type FilterKey, type Filters, type Grouping, type Ordering, type PropKey, type ViewOptions } from "../../store/view";
import { cx } from "../../lib/utils";
import { SCOPE, useHotkeys } from "../../lib/hotkeys";
import { CycleIcon, LabelDot, PriorityIcon, ProjectIcon, TeamIcon } from "../../components/icons";
import { StateIcon } from "../../components/pickers";
import { Picker, type PickerOption } from "../../components/Picker";
import { Avatar, Menu, Popover, Switch, Tooltip } from "../../components/ui";

const FIELD_META: Record<FilterKey, { label: string; icon: ReactNode }> = {
  status: { label: "ステータス", icon: <CircleDashed size={14} /> },
  priority: { label: "優先度", icon: <BarChart3 size={14} /> },
  assignee: { label: "担当者", icon: <UserIcon size={14} /> },
  creator: { label: "作成者", icon: <UserIcon size={14} /> },
  label: { label: "ラベル", icon: <Tag size={14} /> },
  project: { label: "プロジェクト", icon: <Box size={14} /> },
  cycle: { label: "サイクル", icon: <CycleIcon size={14} progress={0.5} /> },
  team: { label: "チーム", icon: <Users size={14} /> },
};

function useFilterOptions(field: FilterKey, teamId: string | null | undefined, selected: (string | number)[]): PickerOption[] {
  const states = useData((s) => s.states);
  const members = useMembers();
  const labels = useLabels();
  const projects = useProjects();
  const cycles = useCycles(teamId);
  const teams = useTeams();
  const meId = useData((s) => s.meId);
  return useMemo(() => {
    const sel = (v: string | number) => selected.includes(v);
    switch (field) {
      case "status": {
        const seen = new Map<string, string>();
        for (const st of sortStates(Object.values(states).filter((s) => !teamId || s.teamId === teamId))) {
          const k = stateKey(st.type, st.name);
          if (!seen.has(k)) seen.set(k, st.id);
        }
        return [...seen].map(([k, id]) => ({ id: k, label: states[id].name, icon: <StateIcon stateId={id} />, selected: sel(k) }));
      }
      case "priority":
        return [...PRIORITY_ORDER].map((p) => ({ id: String(p), label: priorityLabel(p), icon: <PriorityIcon priority={p} />, selected: sel(p) }));
      case "assignee":
      case "creator":
        return [
          ...(field === "assignee" ? [{ id: "none", label: "担当者なし", icon: <Avatar user={null} size={16} />, selected: sel("none") }] : []),
          ...members.map((u) => ({
            id: u.id,
            label: u.id === meId ? `${u.name}（自分）` : u.name,
            icon: <Avatar user={u} size={16} />,
            selected: sel(u.id),
          })),
        ];
      case "label":
        return [
          { id: "none", label: "ラベルなし", icon: <CircleSlash size={14} className="muted" />, selected: sel("none") },
          ...labels.map((l) => ({ id: l.id, label: l.name, icon: <LabelDot color={l.color} />, selected: sel(l.id) })),
        ];
      case "project":
        return [
          { id: "none", label: "プロジェクトなし", icon: <CircleSlash size={14} className="muted" />, selected: sel("none") },
          ...projects.map((p) => ({ id: p.id, label: p.name, icon: <ProjectIcon color={p.color} status={p.status} />, selected: sel(p.id) })),
        ];
      case "cycle":
        return [
          { id: "none", label: "サイクルなし", icon: <CircleSlash size={14} className="muted" />, selected: sel("none") },
          ...cycles.map((c) => ({ id: c.id, label: cycleName(c), icon: <CycleIcon size={14} progress={0.5} />, selected: sel(c.id) })),
        ];
      case "team":
        return teams.map((t) => ({ id: t.id, label: t.name, icon: <TeamIcon team={t} size={16} />, selected: sel(t.id) }));
    }
  }, [field, states, members, labels, projects, cycles, teams, teamId, selected, meId]);
}

function FilterValuePicker({
  field,
  anchor,
  filters,
  setFilters,
  teamId,
  onClose,
}: {
  field: FilterKey;
  anchor: DOMRect;
  filters: Filters;
  setFilters: (f: Filters) => void;
  teamId?: string | null;
  onClose: () => void;
}) {
  const current = (filters[field] ?? []) as (string | number)[];
  const options = useFilterOptions(field, teamId, current);
  return (
    <Picker
      anchor={anchor}
      onClose={onClose}
      multi
      testId={`filter-picker-${field}`}
      options={options}
      placeholder={`${FIELD_META[field].label}で絞り込む...`}
      onSelect={(o) => {
        const v: string | number = field === "priority" ? Number(o.id) : o.id;
        const next = current.includes(v) ? current.filter((x) => x !== v) : [...current, v];
        setFilters({ ...filters, [field]: next });
      }}
    />
  );
}

export function FilterButton({
  filters,
  setFilters,
  teamId,
  fields,
}: {
  filters: Filters;
  setFilters: (f: Filters) => void;
  teamId?: string | null;
  fields: FilterKey[];
}) {
  const [menu, setMenu] = useState<DOMRect | null>(null);
  const [picking, setPicking] = useState<{ field: FilterKey; anchor: DOMRect } | null>(null);
  useHotkeys(
    "f",
    () => {
      const el = document.querySelector<HTMLElement>("[data-testid=filter-button]");
      if (el) setMenu(el.getBoundingClientRect());
    },
    { scope: SCOPE.view },
  );
  return (
    <>
      <Tooltip label="フィルター" combo="f">
        <button
          className="toolbar-btn"
          data-popover-anchor
          data-testid="filter-button"
          onClick={(e) => setMenu(menu ? null : e.currentTarget.getBoundingClientRect())}
        >
          <Filter size={14} />
          <span>フィルター</span>
        </button>
      </Tooltip>
      {menu && (
        <Menu
          anchor={menu}
          onClose={() => setMenu(null)}
          items={fields.map((f) => ({
            label: FIELD_META[f].label,
            icon: FIELD_META[f].icon,
            onSelect: () => setPicking({ field: f, anchor: menu }),
          }))}
        />
      )}
      {picking && (
        <FilterValuePicker
          field={picking.field}
          anchor={picking.anchor}
          filters={filters}
          setFilters={setFilters}
          teamId={teamId}
          onClose={() => setPicking(null)}
        />
      )}
    </>
  );
}

function useValueLabel(field: FilterKey, values: (string | number)[], teamId?: string | null): string {
  const options = useFilterOptions(field, teamId, values);
  const labels = options.filter((o) => o.selected).map((o) => o.label);
  if (labels.length <= 2) return labels.join("・");
  return `${labels.slice(0, 2).join("・")} ほか${labels.length - 2}件`;
}

function FilterChip({
  field,
  filters,
  setFilters,
  teamId,
}: {
  field: FilterKey;
  filters: Filters;
  setFilters: (f: Filters) => void;
  teamId?: string | null;
}) {
  const values = (filters[field] ?? []) as (string | number)[];
  const label = useValueLabel(field, values, teamId);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  return (
    <span className="filter-chip" data-testid={`filter-chip-${field}`}>
      <span className="filter-chip-field">
        {FIELD_META[field].icon}
        {FIELD_META[field].label}
      </span>
      <button className="filter-chip-value" data-popover-anchor onClick={(e) => setAnchor(anchor ? null : e.currentTarget.getBoundingClientRect())}>
        {label}
      </button>
      <button
        className="filter-chip-remove"
        aria-label="フィルターを削除"
        onClick={() => {
          const next = { ...filters };
          delete next[field];
          setFilters(next);
        }}
      >
        <X size={12} />
      </button>
      {anchor && <FilterValuePicker field={field} anchor={anchor} filters={filters} setFilters={setFilters} teamId={teamId} onClose={() => setAnchor(null)} />}
    </span>
  );
}

export function FilterChips({ filters, setFilters, teamId }: { filters: Filters; setFilters: (f: Filters) => void; teamId?: string | null }) {
  const active = (Object.keys(filters) as FilterKey[]).filter((k) => (filters[k] ?? []).length > 0);
  if (!active.length) return null;
  return (
    <div className="filter-bar" data-testid="filter-bar">
      {active.map((k) => (
        <FilterChip key={k} field={k} filters={filters} setFilters={setFilters} teamId={teamId} />
      ))}
      <button className="link-btn" onClick={() => setFilters({})}>
        すべてクリア
      </button>
    </div>
  );
}

const GROUPINGS: [Grouping, string][] = [
  ["status", "ステータス"],
  ["assignee", "担当者"],
  ["priority", "優先度"],
  ["project", "プロジェクト"],
  ["cycle", "サイクル"],
  ["label", "ラベル"],
  ["none", "なし"],
];
const ORDERINGS: [Ordering, string][] = [
  ["priority", "優先度"],
  ["manual", "手動"],
  ["updated", "更新日"],
  ["created", "作成日"],
  ["dueDate", "期日"],
];
const PROPS: [PropKey, string][] = [
  ["id", "ID"],
  ["status", "ステータス"],
  ["priority", "優先度"],
  ["labels", "ラベル"],
  ["project", "プロジェクト"],
  ["cycle", "サイクル"],
  ["dueDate", "期日"],
  ["estimate", "見積もり"],
  ["assignee", "担当者"],
  ["created", "作成日"],
];

export function DisplayButton({ view, setView, allowCycle = true }: { view: ViewOptions; setView: (p: Partial<ViewOptions>) => void; allowCycle?: boolean }) {
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  return (
    <>
      <Tooltip label="表示の切り替え（リスト / ボード）" combo="mod+b">
        <div className="segmented" role="group" aria-label="レイアウト">
          <button className={cx(view.layout === "list" && "on")} onClick={() => setView({ layout: "list" })} aria-label="リスト" data-testid="layout-list">
            <List size={14} />
          </button>
          <button className={cx(view.layout === "board" && "on")} onClick={() => setView({ layout: "board" })} aria-label="ボード" data-testid="layout-board">
            <Columns3 size={14} />
          </button>
        </div>
      </Tooltip>
      <Tooltip label="表示設定">
        <button
          className="toolbar-btn"
          data-popover-anchor
          data-testid="display-button"
          onClick={(e) => setAnchor(anchor ? null : e.currentTarget.getBoundingClientRect())}
        >
          <SlidersHorizontal size={14} />
          <span>表示</span>
        </button>
      </Tooltip>
      {anchor && (
        <Popover anchor={anchor} onClose={() => setAnchor(null)} placement="bottom-end" className="display-menu" width={320} testId="display-menu">
          <div className="display-row">
            <span>グループ</span>
            <select value={view.grouping} onChange={(e) => setView({ grouping: e.target.value as Grouping })} data-testid="display-grouping">
              {GROUPINGS.filter(([g]) => allowCycle || g !== "cycle").map(([g, l]) => (
                <option key={g} value={g}>
                  {l}
                </option>
              ))}
            </select>
          </div>
          <div className="display-row">
            <span>並び順</span>
            <select value={view.ordering} onChange={(e) => setView({ ordering: e.target.value as Ordering })} data-testid="display-ordering">
              {ORDERINGS.map(([o, l]) => (
                <option key={o} value={o}>
                  {l}
                </option>
              ))}
            </select>
          </div>
          <div className="display-row">
            <span>完了した課題</span>
            <select value={view.completed} onChange={(e) => setView({ completed: e.target.value as ViewOptions["completed"] })}>
              <option value="all">すべて表示</option>
              <option value="week">過去1週間</option>
              <option value="month">過去1か月</option>
              <option value="none">表示しない</option>
            </select>
          </div>
          <div className="display-row">
            <span>サブ課題を表示</span>
            <Switch checked={view.showSubIssues} onChange={(v) => setView({ showSubIssues: v })} label="サブ課題を表示" />
          </div>
          {view.layout === "list" && (
            <div className="display-row">
              <span>空のグループを表示</span>
              <Switch checked={view.showEmptyGroups} onChange={(v) => setView({ showEmptyGroups: v })} label="空のグループを表示" />
            </div>
          )}
          <div className="display-sep" />
          <div className="display-label">表示するプロパティ</div>
          <div className="display-props">
            {PROPS.map(([k, l]) => (
              <button
                key={k}
                className={cx("prop-toggle", view.props[k] && "on")}
                onClick={() => setView({ props: { ...view.props, [k]: !view.props[k] } })}
              >
                {l}
              </button>
            ))}
          </div>
        </Popover>
      )}
    </>
  );
}
