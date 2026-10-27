import { useMemo, type ReactNode } from "react";
import { Ban, CircleSlash, Hash } from "lucide-react";
import type { Issue } from "../../shared/types";
import { ESTIMATES, PALETTE, priorityLabel } from "../../shared/constants";
import { createLabel, statesForTeam, updateIssues } from "../store/actions";
import { useData } from "../store/data";
import { cycleName, cycleStatus, useCycles, useLabels, useMembers, useProjects, useStates, useTeams } from "../store/selectors";
import { useUI, type PickerKind } from "../store/ui";
import { formatDate, identifier, fuzzyMatch } from "../lib/utils";
import { CycleIcon, LabelDot, PriorityIcon, ProjectIcon, StatusIcon, TeamIcon, startedProgress } from "./icons";
import { Picker, type PickerOption } from "./Picker";
import { DatePicker } from "./DatePicker";
import { Avatar } from "./ui";

// ---------------------------------------------------------------------------
// 各プロパティの選択肢
// ---------------------------------------------------------------------------

export function StateIcon({ stateId, size }: { stateId: string; size?: number }) {
  const states = useData((s) => s.states);
  const st = states[stateId];
  if (!st) return null;
  let progress: number | undefined;
  if (st.type === "started") {
    const positions = Object.values(states)
      .filter((s) => s.teamId === st.teamId && s.type === "started")
      .map((s) => s.position)
      .sort((a, b) => a - b);
    progress = startedProgress(st.position, positions);
  }
  return <StatusIcon type={st.type} color={st.color} size={size} progress={progress} />;
}

function useStatusOptions(teamId: string | null, current: string | null): PickerOption[] {
  const states = useStates(teamId);
  return useMemo(
    () =>
      states.map((s, i) => ({
        id: s.id,
        label: s.name,
        icon: <StateIcon stateId={s.id} />,
        selected: s.id === current,
        digit: i + 1 <= 9 ? i + 1 : undefined,
      })),
    [states, current],
  );
}

function usePriorityOptions(current: number | null): PickerOption[] {
  return useMemo(
    () =>
      [0, 1, 2, 3, 4].map((p) => ({
        id: String(p),
        label: priorityLabel(p),
        icon: <PriorityIcon priority={p} />,
        selected: p === current,
        digit: p,
        keywords: ["none", "urgent", "high", "medium", "low"][p],
      })),
    [current],
  );
}

function useAssigneeOptions(current: string | null): PickerOption[] {
  const members = useMembers();
  const meId = useData((s) => s.meId);
  return useMemo(() => {
    const sorted = [...members].sort((a, b) => (a.id === meId ? -1 : b.id === meId ? 1 : 0));
    return [
      { id: "none", label: "担当者なし", icon: <Avatar user={null} size={16} />, selected: current === null, digit: 0 },
      ...sorted.map((u, i) => ({
        id: u.id,
        label: u.id === meId ? `${u.name}（自分）` : u.name,
        keywords: `${u.email} ${u.id === meId ? "me 自分" : ""}`,
        icon: <Avatar user={u} size={16} />,
        selected: u.id === current,
        digit: i + 1 <= 9 ? i + 1 : undefined,
      })),
    ];
  }, [members, current, meId]);
}

function useLabelOptions(selected: string[], partial: string[] = []): PickerOption[] {
  const labels = useLabels();
  return useMemo(
    () =>
      labels.map((l) => ({
        id: l.id,
        label: l.name,
        icon: <LabelDot color={l.color} />,
        selected: selected.includes(l.id),
        hint: partial.includes(l.id) ? "一部" : undefined,
      })),
    [labels, selected, partial],
  );
}

function useProjectOptions(current: string | null): PickerOption[] {
  const projects = useProjects();
  return useMemo(
    () => [
      { id: "none", label: "プロジェクトなし", icon: <CircleSlash size={14} className="muted" />, selected: current === null },
      ...projects.map((p) => ({
        id: p.id,
        label: p.name,
        icon: <ProjectIcon color={p.color} status={p.status} />,
        selected: p.id === current,
      })),
    ],
    [projects, current],
  );
}

function useCycleOptions(teamId: string | null, current: string | null): PickerOption[] {
  const cycles = useCycles(teamId);
  return useMemo(() => {
    const relevant = cycles.filter((c) => cycleStatus(c) !== "past" || c.id === current);
    return [
      { id: "none", label: "サイクルなし", icon: <CircleSlash size={14} className="muted" />, selected: current === null },
      ...relevant.map((c) => {
        const st = cycleStatus(c);
        return {
          id: c.id,
          label: cycleName(c),
          icon: <CycleIcon size={14} progress={st === "current" ? 0.5 : st === "past" ? 1 : 0} />,
          hint: `${formatDate(c.startsAt)} → ${formatDate(c.endsAt)}${st === "current" ? "・現在" : ""}`,
          selected: c.id === current,
        };
      }),
    ];
  }, [cycles, current]);
}

function useEstimateOptions(current: number | null): PickerOption[] {
  return useMemo(
    () => [
      { id: "none", label: "見積もりなし", icon: <Ban size={14} className="muted" />, selected: current === null },
      ...ESTIMATES.map((e) => ({
        id: String(e),
        label: `${e} ポイント`,
        icon: <Hash size={14} className="muted" />,
        selected: e === current,
      })),
    ],
    [current],
  );
}

function useTeamOptions(current: string | null): PickerOption[] {
  const teams = useTeams();
  return useMemo(
    () =>
      teams.map((t) => ({
        id: t.id,
        label: t.name,
        keywords: t.key,
        icon: <TeamIcon team={t} size={16} />,
        selected: t.id === current,
        hint: t.key,
      })),
    [teams, current],
  );
}

function ParentPicker({
  anchor,
  onClose,
  excludeIds,
  current,
  onChange,
  header,
}: {
  anchor: DOMRect | null | undefined;
  onClose: () => void;
  excludeIds: string[];
  current: string | null;
  onChange: (id: string | null) => void;
  header?: ReactNode;
}) {
  const issues = useData((s) => s.issues);
  const teams = useData((s) => s.teams);
  const options = useMemo(() => {
    const exclude = new Set(excludeIds);
    // 子孫を親にすると循環するので除外
    let grew = true;
    while (grew) {
      grew = false;
      for (const i of Object.values(issues)) {
        if (i.parentId && exclude.has(i.parentId) && !exclude.has(i.id)) {
          exclude.add(i.id);
          grew = true;
        }
      }
    }
    const list: PickerOption[] = Object.values(issues)
      .filter((i) => !i.archivedAt && !exclude.has(i.id))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 300)
      .map((i) => ({
        id: i.id,
        label: i.title,
        keywords: identifier(i, teams),
        icon: <StateIcon stateId={i.stateId} />,
        hint: identifier(i, teams),
        selected: i.id === current,
      }));
    if (current) list.unshift({ id: "none", label: "親課題を解除", icon: <CircleSlash size={14} className="muted" /> });
    return list;
  }, [issues, teams, excludeIds, current]);
  return (
    <Picker
      anchor={anchor}
      onClose={onClose}
      options={options}
      header={header}
      placeholder="親課題を検索..."
      width={380}
      testId="picker-parent"
      onSelect={(o) => onChange(o.id === "none" ? null : o.id)}
    />
  );
}

// ---------------------------------------------------------------------------
// 単一の値を編集する汎用ピッカー（作成ダイアログでも使う）
// ---------------------------------------------------------------------------

export interface PropertyValue {
  teamId: string | null;
  stateId: string | null;
  priority: number | null;
  assigneeId: string | null;
  labelIds: string[];
  partialLabelIds?: string[];
  projectId: string | null;
  cycleId: string | null;
  estimate: number | null;
  dueDate: string | null;
  parentId: string | null;
  excludeParentIds?: string[];
}

export function PropertyPicker({
  kind,
  anchor,
  value,
  onClose,
  onChange,
  header,
}: {
  kind: PickerKind;
  anchor: DOMRect | null | undefined;
  value: PropertyValue;
  onClose: () => void;
  onChange: (patch: Partial<Issue> & { toggleLabel?: string }) => void;
  header?: ReactNode;
}) {
  const statusOpts = useStatusOptions(value.teamId, value.stateId);
  const priorityOpts = usePriorityOptions(value.priority);
  const assigneeOpts = useAssigneeOptions(value.assigneeId);
  const labelOpts = useLabelOptions(value.labelIds, value.partialLabelIds);
  const projectOpts = useProjectOptions(value.projectId);
  const cycleOpts = useCycleOptions(value.teamId, value.cycleId);
  const estimateOpts = useEstimateOptions(value.estimate);
  const teamOpts = useTeamOptions(value.teamId);
  const common = { anchor, onClose, header };

  switch (kind) {
    case "status":
      return (
        <Picker {...common} testId="picker-status" options={statusOpts} placeholder="ステータスを変更..." onSelect={(o) => onChange({ stateId: o.id })} />
      );
    case "priority":
      return (
        <Picker
          {...common}
          testId="picker-priority"
          options={priorityOpts}
          placeholder="優先度を設定..."
          onSelect={(o) => onChange({ priority: Number(o.id) })}
        />
      );
    case "assignee":
      return (
        <Picker
          {...common}
          testId="picker-assignee"
          options={assigneeOpts}
          placeholder="担当者を設定..."
          onSelect={(o) => onChange({ assigneeId: o.id === "none" ? null : o.id })}
        />
      );
    case "labels":
      return (
        <Picker
          {...common}
          testId="picker-labels"
          multi
          options={labelOpts}
          placeholder="ラベルを変更..."
          onSelect={(o) => onChange({ toggleLabel: o.id })}
          onCreate={(name) => {
            const id = createLabel(name, PALETTE[Math.floor(Math.random() * PALETTE.length)]);
            onChange({ toggleLabel: id });
          }}
          createLabel={(q) => `新しいラベルを作成：「${q}」`}
        />
      );
    case "project":
      return (
        <Picker
          {...common}
          testId="picker-project"
          options={projectOpts}
          placeholder="プロジェクトを設定..."
          onSelect={(o) => onChange({ projectId: o.id === "none" ? null : o.id })}
        />
      );
    case "cycle":
      return (
        <Picker
          {...common}
          testId="picker-cycle"
          width={340}
          options={cycleOpts}
          placeholder="サイクルを設定..."
          emptyText="このチームにはサイクルがありません"
          onSelect={(o) => onChange({ cycleId: o.id === "none" ? null : o.id })}
        />
      );
    case "estimate":
      return (
        <Picker
          {...common}
          testId="picker-estimate"
          options={estimateOpts}
          placeholder="見積もりを設定..."
          onSelect={(o) => onChange({ estimate: o.id === "none" ? null : Number(o.id) })}
        />
      );
    case "team":
      return (
        <Picker {...common} testId="picker-team" options={teamOpts} placeholder="チームを選択..." onSelect={(o) => onChange({ teamId: o.id })} />
      );
    case "dueDate":
      return <DatePicker anchor={anchor} value={value.dueDate} onClose={onClose} onChange={(v) => onChange({ dueDate: v })} />;
    case "parent":
      return (
        <ParentPicker
          anchor={anchor}
          onClose={onClose}
          header={header}
          current={value.parentId}
          excludeIds={value.excludeParentIds ?? []}
          onChange={(id) => onChange({ parentId: id })}
        />
      );
  }
}

// ---------------------------------------------------------------------------
// 課題に対するピッカー（ショートカット・右クリック・プロパティボタンから開く）
// ---------------------------------------------------------------------------

export function PickerHost() {
  const picker = useUI((s) => s.picker);
  const issuesMap = useData((s) => s.issues);
  const teams = useData((s) => s.teams);
  if (!picker) return null;
  const issues = picker.issueIds.map((id) => issuesMap[id]).filter(Boolean) as Issue[];
  if (!issues.length) return null;
  const first = issues[0];
  const close = () => useUI.setState({ picker: null });
  const allLabels = issues.reduce<string[]>((acc, i, idx) => (idx === 0 ? [...i.labelIds] : acc.filter((l) => i.labelIds.includes(l))), []);
  const anyLabels = [...new Set(issues.flatMap((i) => i.labelIds))].filter((l) => !allLabels.includes(l));
  const value: PropertyValue = {
    teamId: first.teamId,
    stateId: first.stateId,
    priority: first.priority,
    assigneeId: first.assigneeId,
    labelIds: allLabels,
    partialLabelIds: anyLabels,
    projectId: first.projectId,
    cycleId: first.cycleId,
    estimate: first.estimate,
    dueDate: first.dueDate,
    parentId: issues.length === 1 ? first.parentId : null,
    excludeParentIds: picker.issueIds,
  };
  const header = !picker.anchor ? (
    <span className="picker-target">
      {issues.length === 1 ? (
        <>
          <b>{identifier(first, teams)}</b> {first.title}
        </>
      ) : (
        <b>{issues.length}件の課題</b>
      )}
    </span>
  ) : undefined;

  const onChange = (patch: Partial<Issue> & { toggleLabel?: string }) => {
    if (patch.toggleLabel) {
      const id = patch.toggleLabel;
      const allHave = issues.every((i) => i.labelIds.includes(id));
      updateIssues(
        picker.issueIds,
        (i) => ({ labelIds: allHave ? i.labelIds.filter((x) => x !== id) : [...new Set([...i.labelIds, id])] }),
      );
      return;
    }
    if (patch.stateId) {
      // 複数チームの課題には、同じ名前（なければ同じ種類）のステータスを割り当てる
      const chosen = useData.getState().states[patch.stateId];
      updateIssues(picker.issueIds, (i) => {
        if (i.teamId === chosen.teamId) return { stateId: chosen.id };
        const list = statesForTeam(i.teamId);
        const st = list.find((s) => s.name === chosen.name) ?? list.find((s) => s.type === chosen.type);
        return st ? { stateId: st.id } : {};
      });
      return;
    }
    if (patch.cycleId !== undefined && patch.cycleId) {
      const cycle = useData.getState().cycles[patch.cycleId];
      updateIssues(picker.issueIds.filter((id) => issuesMap[id]?.teamId === cycle?.teamId), { cycleId: patch.cycleId });
      return;
    }
    updateIssues(picker.issueIds, patch);
  };

  return <PropertyPicker kind={picker.kind} anchor={picker.anchor} value={value} onClose={close} onChange={onChange} header={header} />;
}

export function filterOptions(options: PickerOption[], q: string) {
  return options.filter((o) => fuzzyMatch(`${o.label} ${o.keywords ?? ""}`, q));
}
