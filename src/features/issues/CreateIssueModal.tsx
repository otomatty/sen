import { useEffect, useRef, useState, type MouseEvent } from "react";
import { useNavigate } from "react-router";
import { CalendarDays, ChevronDown, CornerLeftUp, Hash, Tag, X, Box, UserCircle2 } from "lucide-react";
import { priorityLabel } from "../../../shared/constants";
import { createIssue, defaultStateFor } from "../../store/actions";
import { useData } from "../../store/data";
import { cycleName, useTeams } from "../../store/selectors";
import { toast, useUI, type PickerKind } from "../../store/ui";
import { SCOPE, useHotkeys } from "../../lib/hotkeys";
import { cx, formatDate, identifier, MOD } from "../../lib/utils";
import { Avatar, Button, Modal, Switch, Tooltip } from "../../components/ui";
import { CycleIcon, LabelDot, PriorityIcon, ProjectIcon, TeamIcon } from "../../components/icons";
import { PropertyPicker, StateIcon } from "../../components/pickers";
import { Editor } from "../../components/Editor";
import { useWsPath } from "../../app/hooks";

interface Draft {
  teamId: string;
  title: string;
  description: string;
  stateId: string;
  priority: number;
  assigneeId: string | null;
  labelIds: string[];
  projectId: string | null;
  cycleId: string | null;
  estimate: number | null;
  dueDate: string | null;
  parentId: string | null;
}

// 閉じても下書きは残る（Linear と同じ）
let savedDraft: Partial<Draft> | null = null;

export function CreateIssueModal() {
  const open = useUI((s) => s.createOpen);
  if (!open) return null;
  return <CreateIssueDialog />;
}

function CreateIssueDialog() {
  const defaults = useUI((s) => s.createDefaults);
  const teams = useTeams();
  const d = useData();
  const navigate = useNavigate();
  const p = useWsPath();
  const [keepOpen, setKeepOpen] = useState(false);
  const [editorKey, setEditorKey] = useState(0);
  const titleRef = useRef<HTMLTextAreaElement>(null);
  const [picker, setPicker] = useState<{ kind: PickerKind; anchor: DOMRect } | null>(null);

  const initTeam = defaults.teamId ?? savedDraft?.teamId ?? teams[0]?.id ?? "";
  const [draft, setDraft] = useState<Draft>(() => {
    const base: Draft = {
      teamId: initTeam,
      title: "",
      description: "",
      stateId: defaultStateFor(initTeam)?.id ?? "",
      priority: 0,
      assigneeId: null,
      labelIds: [],
      projectId: null,
      cycleId: null,
      estimate: null,
      dueDate: null,
      parentId: null,
    };
    // 初期値が明示されたときは下書きより優先
    const hasDefaults = Object.keys(defaults).some((k) => k !== "teamId");
    const merged = { ...base, ...(hasDefaults ? {} : savedDraft ?? {}), ...stripUndefined(defaults) } as Draft;
    if (merged.stateId && d.states[merged.stateId]?.teamId !== merged.teamId) merged.stateId = base.stateId;
    return merged;
  });

  useEffect(() => {
    savedDraft = draft;
  }, [draft]);

  const close = () => useUI.setState({ createOpen: false, createDefaults: {} });

  const set = (patch: Partial<Draft>) => setDraft((x) => ({ ...x, ...patch }));

  const changeTeam = (teamId: string) => {
    if (teamId === draft.teamId) return;
    const oldType = d.states[draft.stateId]?.type ?? "unstarted";
    set({ teamId, stateId: defaultStateFor(teamId, oldType)?.id ?? "", cycleId: null, parentId: null });
  };

  const submit = () => {
    const title = draft.title.trim();
    if (!title) {
      titleRef.current?.focus();
      toast("タイトルを入力してください", { kind: "error" });
      return;
    }
    const { id, identifier: ident } = createIssue({ ...draft, title });
    savedDraft = null;
    toast(`${ident} を作成しました`, {
      kind: "success",
      action: {
        label: "表示",
        run: () => {
          const issue = useData.getState().issues[id];
          if (issue) navigate(p(`/issue/${identifier(issue, useData.getState().teams)}`));
        },
      },
    });
    if (keepOpen) {
      set({ title: "", description: "" });
      setEditorKey((k) => k + 1);
      titleRef.current?.focus();
    } else close();
  };

  useHotkeys("mod+enter", () => submit(), { allowInInput: true, scope: SCOPE.overlay });

  const team = d.teams[draft.teamId];
  const st = d.states[draft.stateId];
  const assignee = draft.assigneeId ? d.users[draft.assigneeId] : null;
  const project = draft.projectId ? d.projects[draft.projectId] : null;
  const cycle = draft.cycleId ? d.cycles[draft.cycleId] : null;
  const parent = draft.parentId ? d.issues[draft.parentId] : null;
  const pick = (kind: PickerKind) => (e: MouseEvent<HTMLElement>) => setPicker({ kind, anchor: e.currentTarget.getBoundingClientRect() });

  return (
    <Modal onClose={close} width={720} className="create-modal" testId="create-issue-modal">
      <div className="create-head">
        <button className="team-chip" data-popover-anchor onClick={pick("team")} data-testid="create-team">
          {team && <TeamIcon team={team} size={16} />}
          <span>{team?.key}</span>
          <ChevronDown size={12} />
        </button>
        <span className="crumb-sep">›</span>
        <span className="muted">{parent ? `${identifier(parent, d.teams)} のサブ課題` : "新しい課題"}</span>
        <span className="spacer" />
        <Tooltip label="閉じる（下書きは保存されます）" combo="escape">
          <button className="icon-btn" onClick={close} aria-label="閉じる">
            <X size={16} />
          </button>
        </Tooltip>
      </div>
      <div className="create-body">
        <textarea
          ref={titleRef}
          autoFocus
          rows={1}
          className="create-title"
          placeholder="課題のタイトル"
          value={draft.title}
          data-testid="create-title"
          onChange={(e) => set({ title: e.target.value.replace(/\n/g, "") })}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (e.key === "Enter" && !(e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              (document.querySelector(".create-description .ProseMirror") as HTMLElement | null)?.focus();
            }
          }}
        />
        <Editor
          key={editorKey}
          value={draft.description}
          onChange={(h) => set({ description: h })}
          placeholder="説明を追加…"
          className="create-description"
          onSubmit={submit}
          testId="create-description"
        />
      </div>
      <div className="create-props">
        <button className="prop-chip" data-popover-anchor onClick={pick("status")} data-testid="create-status">
          {st && <StateIcon stateId={st.id} />}
          {st?.name ?? "ステータス"}
        </button>
        <button className="prop-chip" data-popover-anchor onClick={pick("priority")} data-testid="create-priority">
          <PriorityIcon priority={draft.priority} />
          {draft.priority ? priorityLabel(draft.priority) : "優先度"}
        </button>
        <button className="prop-chip" data-popover-anchor onClick={pick("assignee")} data-testid="create-assignee">
          {assignee ? <Avatar user={assignee} size={16} /> : <UserCircle2 size={14} />}
          {assignee?.name ?? "担当者"}
        </button>
        <button className="prop-chip" data-popover-anchor onClick={pick("labels")} data-testid="create-labels">
          {draft.labelIds.length ? (
            <>
              {draft.labelIds.slice(0, 3).map((id) => d.labels[id] && <LabelDot key={id} color={d.labels[id].color} />)}
              {draft.labelIds.length === 1 ? d.labels[draft.labelIds[0]]?.name : `${draft.labelIds.length}個のラベル`}
            </>
          ) : (
            <>
              <Tag size={14} />
              ラベル
            </>
          )}
        </button>
        <button className="prop-chip" data-popover-anchor onClick={pick("project")} data-testid="create-project">
          {project ? <ProjectIcon color={project.color} status={project.status} /> : <Box size={14} />}
          {project?.name ?? "プロジェクト"}
        </button>
        {team?.cyclesEnabled && (
          <button className="prop-chip" data-popover-anchor onClick={pick("cycle")} data-testid="create-cycle">
            <CycleIcon size={14} progress={cycle ? 0.5 : 0} />
            {cycle ? cycleName(cycle) : "サイクル"}
          </button>
        )}
        <button className="prop-chip" data-popover-anchor onClick={pick("estimate")}>
          <Hash size={14} />
          {draft.estimate !== null ? `${draft.estimate}ポイント` : "見積もり"}
        </button>
        <button className="prop-chip" data-popover-anchor onClick={pick("dueDate")} data-testid="create-due">
          <CalendarDays size={14} />
          {draft.dueDate ? formatDate(draft.dueDate) : "期日"}
        </button>
        <button className={cx("prop-chip", !parent && "subtle")} data-popover-anchor onClick={pick("parent")}>
          <CornerLeftUp size={14} />
          {parent ? identifier(parent, d.teams) : "親課題"}
        </button>
      </div>
      <div className="create-foot">
        <span className="spacer" />
        <label className="keep-open">
          <Switch checked={keepOpen} onChange={setKeepOpen} label="続けて作成" />
          続けて作成
        </label>
        <Button variant="primary" onClick={submit} data-testid="create-submit">
          課題を作成
          <span className="btn-kbd">{MOD}↵</span>
        </Button>
      </div>
      {picker && (
        <PropertyPicker
          kind={picker.kind}
          anchor={picker.anchor}
          value={{ ...draft, excludeParentIds: [] }}
          onClose={() => setPicker(null)}
          onChange={(patch) => {
            if (patch.toggleLabel) {
              const id = patch.toggleLabel;
              set({ labelIds: draft.labelIds.includes(id) ? draft.labelIds.filter((x) => x !== id) : [...draft.labelIds, id] });
              return;
            }
            if (patch.teamId) return changeTeam(patch.teamId);
            set(patch as Partial<Draft>);
          }}
        />
      )}
    </Modal>
  );
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}
