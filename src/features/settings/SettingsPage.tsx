import { useEffect, useState } from "react";
import { NavLink, useParams } from "react-router";
import { Copy, Plus, RefreshCw, Trash2 } from "lucide-react";
import type { StateType } from "../../../shared/types";
import { AVATAR_COLORS, PALETTE, STATE_TYPES } from "../../../shared/constants";
import { useData } from "../../store/data";
import {
  createLabel,
  createState,
  createTeam,
  deleteLabel,
  deleteState,
  regenerateInvite,
  removeMember,
  restoreIssues,
  setMemberRole,
  updateLabel,
  updateMe,
  updateState,
  updateTeam,
  updateWorkspaceName,
} from "../../store/actions";
import { useLabels, useMembers, useStates, useTeams } from "../../store/selectors";
import { setTheme, toast, useUI, type Theme } from "../../store/ui";
import { appUrl, copyText, cx, identifier, timeAgo } from "../../lib/utils";
import { Avatar, Button, Popover, Switch } from "../../components/ui";
import { LabelDot, TeamIcon } from "../../components/icons";
import { StateIcon } from "../../components/pickers";
import { PageHeader } from "../../components/PageHeader";
import { useDocumentTitle, useIsAdmin, useWsPath } from "../../app/hooks";
import { api } from "../../lib/api";
import { confirmDialog } from "../../components/ConfirmDialog";
import type { Me } from "../../../shared/types";

function Section({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <section className="settings-section">
      <h2>{title}</h2>
      {description && <p className="muted">{description}</p>}
      <div className="settings-card">{children}</div>
    </section>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="field">
      <div className="field-label">
        <span>{label}</span>
        {hint && <span className="muted small">{hint}</span>}
      </div>
      <div className="field-control">{children}</div>
    </div>
  );
}

function ColorPicker({ value, onChange, colors = PALETTE }: { value: string; onChange: (c: string) => void; colors?: string[] }) {
  return (
    <span className="color-row">
      {colors.map((c) => (
        <button key={c} className={cx("color-swatch", c === value && "on")} style={{ background: c }} onClick={() => onChange(c)} aria-label={c} />
      ))}
    </span>
  );
}

/** 色の点をクリックするとパレットが開く、省スペースな色選択 */
function ColorButton({ value, onChange, colors = PALETTE }: { value: string; onChange: (c: string) => void; colors?: string[] }) {
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  return (
    <>
      <button
        className="color-button"
        data-popover-anchor
        aria-label="色を変更"
        onClick={(e) => setAnchor(anchor ? null : e.currentTarget.getBoundingClientRect())}
      >
        <span className="dot big" style={{ background: value }} />
      </button>
      {anchor && (
        <Popover anchor={anchor} onClose={() => setAnchor(null)} className="color-popover" width={196}>
          <ColorPicker
            value={value}
            colors={colors}
            onChange={(c) => {
              onChange(c);
              setAnchor(null);
            }}
          />
        </Popover>
      )}
    </>
  );
}

function ProfileSettings() {
  const me = useData((s) => (s.meId ? (s.users[s.meId] as Me) : null));
  const theme = useUI((s) => s.theme);
  const [name, setName] = useState(me?.name ?? "");
  if (!me) return null;
  return (
    <>
      <Section title="プロフィール">
        <Field label="名前">
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} onBlur={() => name.trim() && name !== me.name && updateMe({ name: name.trim() })} data-testid="profile-name" />
        </Field>
        <Field label="メールアドレス">
          <span className="muted">{me.email}</span>
        </Field>
        <Field label="アバターの色">
          <span className="avatar-edit">
            <Avatar user={me} size={28} />
            <ColorPicker value={me.avatarColor} onChange={(c) => updateMe({ avatarColor: c })} colors={AVATAR_COLORS} />
          </span>
        </Field>
      </Section>
      <Section title="表示" description="この端末での見た目の設定です。">
        <Field label="テーマ">
          <div className="segmented wide">
            {(
              [
                ["system", "システム"],
                ["light", "ライト"],
                ["dark", "ダーク"],
              ] as [Theme, string][]
            ).map(([t, l]) => (
              <button key={t} className={cx(theme === t && "on")} onClick={() => setTheme(t)} data-testid={`theme-${t}`}>
                {l}
              </button>
            ))}
          </div>
        </Field>
      </Section>
    </>
  );
}

/** 使い方動画の収録中は、利用者に関係のない開発用ツールを映さない */
function isRecording() {
  try {
    return localStorage.getItem("sen:recording") === "1";
  } catch {
    return false;
  }
}

function DevTools() {
  const ws = useData((s) => s.workspace);
  const admin = useIsAdmin();
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api<{ devTools?: boolean }>("/api/health")
      .then((r) => setEnabled(!!r.devTools))
      .catch(() => setEnabled(false));
  }, []);
  const isDemo = typeof __SEN_DEMO__ !== "undefined" && __SEN_DEMO__;
  if (!enabled || !admin || !ws || (!isDemo && isRecording())) return null;
  return (
    <Section
      title={isDemo ? "デモ" : "開発用ツール"}
      description={isDemo ? "このデモはブラウザの中だけで動いています。データはこの端末にのみ保存されます。" : "ローカル開発時（DEV_TOOLS=1）だけ表示されます。"}
    >
      <div className="invite-row">
        <Button
          disabled={busy}
          data-testid="seed-demo"
          onClick={async () => {
            const ok = await confirmDialog({
              title: "デモデータを投入しますか？",
              message: "このワークスペースの課題・プロジェクト・サイクルを、デモ用のデータで置き換えます。",
              confirmLabel: "置き換える",
              danger: true,
            });
            if (!ok) return;
            setBusy(true);
            try {
              await api(`/api/dev/seed-demo?ws=${ws.urlKey}`, { body: {} });
              location.reload();
            } catch (e) {
              toast((e as Error).message, { kind: "error" });
              setBusy(false);
            }
          }}
        >
          デモデータを投入
        </Button>
        {isDemo && (
          <Button
            variant="ghost"
            onClick={async () => {
              const ok = await confirmDialog({ title: "デモを最初の状態に戻しますか？", message: "このブラウザに保存された変更はすべて消えます。", confirmLabel: "戻す", danger: true });
              if (!ok) return;
              const { resetDemo } = await import("../../../demo/backend");
              await resetDemo();
            }}
          >
            最初の状態に戻す
          </Button>
        )}
      </div>
    </Section>
  );
}

function WorkspaceSettings() {
  const ws = useData((s) => s.workspace);
  const admin = useIsAdmin();
  const [name, setName] = useState(ws?.name ?? "");
  if (!ws) return null;
  const invite = appUrl(`/invite/${ws.inviteCode}`);
  return (
    <>
      <Section title="ワークスペース">
        <Field label="名前">
          <input className="input" value={name} disabled={!admin} onChange={(e) => setName(e.target.value)} onBlur={() => name.trim() && name !== ws.name && updateWorkspaceName(name.trim())} />
        </Field>
        <Field label="URL">
          <code className="muted">
            {location.host}/{ws.urlKey}
          </code>
        </Field>
      </Section>
      <InviteSection invite={invite} admin={admin} />
      <DevTools />
    </>
  );
}

function InviteSection({ invite, admin }: { invite: string; admin: boolean }) {
  return (
    <Section title="メンバーを招待" description="このリンクを知っている人は、アカウントを作成してワークスペースに参加できます。">
      <div className="invite-row">
        <input className="input" readOnly value={invite} onFocus={(e) => e.target.select()} data-testid="invite-link" />
        <Button icon={<Copy size={14} />} onClick={() => copyText(invite).then(() => toast("招待リンクをコピーしました"))}>
          コピー
        </Button>
        {admin && (
          <Button
            variant="ghost"
            icon={<RefreshCw size={14} />}
            onClick={async () => {
              const ok = await confirmDialog({ title: "招待リンクを作り直しますか？", message: "今のリンクは使えなくなります。", confirmLabel: "作り直す" });
              if (ok) regenerateInvite();
            }}
          >
            作り直す
          </Button>
        )}
      </div>
    </Section>
  );
}

function MembersSettings() {
  const members = useMembers();
  const meId = useData((s) => s.meId);
  const ws = useData((s) => s.workspace);
  const admin = useIsAdmin();
  return (
    <>
      <Section title={`メンバー（${members.length}人）`}>
        {members.map((m) => (
          <div key={m.id} className="member-row">
            <Avatar user={m} size={28} />
            <div className="member-info">
              <b>
                {m.name}
                {m.id === meId && <span className="muted">（あなた）</span>}
              </b>
              <span className="muted small">{m.email}</span>
            </div>
            <span className="spacer" />
            {admin && m.id !== meId ? (
              <>
                <select value={m.role} onChange={(e) => setMemberRole(m.id, e.target.value as "admin" | "member")}>
                  <option value="admin">管理者</option>
                  <option value="member">メンバー</option>
                </select>
                <button
                  className="icon-btn"
                  aria-label="メンバーを削除"
                  onClick={async () =>
                    (await confirmDialog({
                      title: `${m.name} さんをワークスペースから外しますか？`,
                      message: "担当している課題は「担当者なし」になります。",
                      confirmLabel: "外す",
                      danger: true,
                    })) && removeMember(m.id)
                  }
                >
                  <Trash2 size={14} />
                </button>
              </>
            ) : (
              <span className="pill">{m.role === "admin" ? "管理者" : "メンバー"}</span>
            )}
          </div>
        ))}
      </Section>
      {ws && <InviteSection invite={appUrl(`/invite/${ws.inviteCode}`)} admin={admin} />}
    </>
  );
}

function LabelsSettings() {
  const labels = useLabels();
  const issues = useData((s) => s.issues);
  const [name, setName] = useState("");
  const [color, setColor] = useState(PALETTE[0]);
  const add = () => {
    if (!name.trim()) return;
    createLabel(name.trim(), color);
    setName("");
  };
  return (
    <Section title="ラベル" description="課題の分類に使うラベルです。ワークスペース全体で共通です。">
      <div className="label-add">
        <LabelDot color={color} size={10} />
        <input
          className="input"
          placeholder="新しいラベル名"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => !e.nativeEvent.isComposing && e.key === "Enter" && add()}
          data-testid="new-label-name"
        />
        <ColorPicker value={color} onChange={setColor} />
        <Button variant="primary" icon={<Plus size={14} />} onClick={add} disabled={!name.trim()} data-testid="new-label-submit">
          追加
        </Button>
      </div>
      {labels.map((l) => {
        const count = Object.values(issues).filter((i) => !i.archivedAt && i.labelIds.includes(l.id)).length;
        return (
          <div key={l.id} className="label-row" data-testid="label-row">
            <ColorButton value={l.color} onChange={(c) => updateLabel(l.id, { color: c })} />
            <input
              className="input ghost"
              defaultValue={l.name}
              onBlur={(e) => e.target.value.trim() && e.target.value !== l.name && updateLabel(l.id, { name: e.target.value.trim() })}
            />
            <span className="muted small">{count}件の課題</span>
            <span className="spacer" />
            <button
              className="icon-btn"
              aria-label="ラベルを削除"
              onClick={async () =>
                (await confirmDialog({
                  title: `ラベル「${l.name}」を削除しますか？`,
                  message: "このラベルが付いた課題からも外れます。",
                  confirmLabel: "削除する",
                  danger: true,
                })) && deleteLabel(l.id)
              }
            >
              <Trash2 size={14} />
            </button>
          </div>
        );
      })}
    </Section>
  );
}

function TeamSettings({ teamId }: { teamId: string }) {
  const team = useData((s) => s.teams[teamId]);
  const states = useStates(teamId);
  const [name, setName] = useState(team?.name ?? "");
  const [key, setKey] = useState(team?.key ?? "");
  const [newState, setNewState] = useState<{ name: string; type: StateType }>({ name: "", type: "started" });
  if (!team) return null;
  return (
    <>
      <Section title={`チーム：${team.name}`}>
        <Field label="名前">
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} onBlur={() => name.trim() && name !== team.name && updateTeam(team.id, { name: name.trim() })} />
        </Field>
        <Field label="識別子" hint="課題 ID の接頭辞（例：ENG-12）">
          <input
            className="input narrow"
            value={key}
            maxLength={7}
            onChange={(e) => setKey(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))}
            onBlur={() => key && key !== team.key && updateTeam(team.id, { key })}
          />
        </Field>
        <Field label="色">
          <ColorPicker value={team.color} onChange={(c) => updateTeam(team.id, { color: c })} />
        </Field>
      </Section>
      <Section title="サイクル" description="一定の期間で区切って仕事を計画・振り返ります。">
        <Field label="サイクルを使う">
          <Switch checked={team.cyclesEnabled} onChange={(v) => updateTeam(team.id, { cyclesEnabled: v })} label="サイクルを使う" />
        </Field>
        <Field label="期間">
          <select value={team.cycleDuration} onChange={(e) => updateTeam(team.id, { cycleDuration: Number(e.target.value) })}>
            {[1, 2, 3, 4].map((w) => (
              <option key={w} value={w}>
                {w}週間
              </option>
            ))}
          </select>
        </Field>
      </Section>
      <Section title="ワークフロー" description="課題がたどるステータスです。種類ごとに順番に並びます。">
        {STATE_TYPES.map((t) => {
          const list = states.filter((s) => s.type === t.type);
          return (
            <div key={t.type} className="workflow-group">
              <div className="workflow-type">{t.label}</div>
              {list.map((s) => (
                <div key={s.id} className="state-row">
                  <StateIcon stateId={s.id} />
                  <input
                    className="input ghost"
                    defaultValue={s.name}
                    onBlur={(e) => e.target.value.trim() && e.target.value !== s.name && updateState(s.id, { name: e.target.value.trim() })}
                  />
                  <span className="spacer" />
                  <ColorButton value={s.color} onChange={(c) => updateState(s.id, { color: c })} />
                  <button
                    className="icon-btn"
                    aria-label="ステータスを削除"
                    disabled={list.length <= 1}
                    title={list.length <= 1 ? "この種類の最後のステータスは削除できません" : "削除"}
                    onClick={async () => {
                      const target = list.find((x) => x.id !== s.id);
                      if (!target) return;
                      const ok = await confirmDialog({
                        title: `ステータス「${s.name}」を削除しますか？`,
                        message: `このステータスの課題は「${target.name}」に移動します。`,
                        confirmLabel: "削除する",
                        danger: true,
                      });
                      if (ok) deleteState(s.id, target.id);
                    }}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
            </div>
          );
        })}
        <div className="state-add">
          <select value={newState.type} onChange={(e) => setNewState({ ...newState, type: e.target.value as StateType })}>
            {STATE_TYPES.map((t) => (
              <option key={t.type} value={t.type}>
                {t.label}
              </option>
            ))}
          </select>
          <input className="input" placeholder="新しいステータス名" value={newState.name} onChange={(e) => setNewState({ ...newState, name: e.target.value })} />
          <Button
            icon={<Plus size={14} />}
            disabled={!newState.name.trim()}
            onClick={() => {
              createState(team.id, newState.name.trim(), newState.type, newState.type === "started" ? "#f0bf37" : "#8b8d93");
              setNewState({ ...newState, name: "" });
            }}
          >
            追加
          </Button>
        </div>
      </Section>
    </>
  );
}

function TrashSettings() {
  const issues = useData((s) => s.issues);
  const teams = useData((s) => s.teams);
  const list = Object.values(issues)
    .filter((i) => i.archivedAt)
    .sort((a, b) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0));
  return (
    <Section title="削除した課題" description="削除した課題はここから元に戻せます。">
      {list.length === 0 && <p className="muted settings-empty">削除した課題はありません。</p>}
      {list.map((i) => (
        <div key={i.id} className="label-row" data-testid="trash-row">
          <StateIcon stateId={i.stateId} />
          <span className="row-id">{identifier(i, teams)}</span>
          <span className="truncate">{i.title}</span>
          <span className="spacer" />
          <span className="muted small">{i.archivedAt ? timeAgo(i.archivedAt) : ""}</span>
          <Button size="sm" onClick={() => restoreIssues([i.id])}>
            元に戻す
          </Button>
        </div>
      ))}
    </Section>
  );
}

function TeamsSettings() {
  const teams = useTeams();
  const [name, setName] = useState("");
  const [key, setKey] = useState("");
  const p = useWsPath();
  return (
    <Section title="チーム" description="チームごとに課題・ワークフロー・サイクルを持てます。">
      {teams.map((t) => (
        <NavLink key={t.id} to={p(`/settings/team/${t.id}`)} className="member-row link-row">
          <TeamIcon team={t} size={22} />
          <div className="member-info">
            <b>{t.name}</b>
            <span className="muted small">{t.key}</span>
          </div>
        </NavLink>
      ))}
      <div className="label-add">
        <input className="input" placeholder="チーム名（例：デザイン）" value={name} onChange={(e) => setName(e.target.value)} />
        <input
          className="input narrow"
          placeholder="識別子（例：DES）"
          value={key}
          maxLength={7}
          onChange={(e) => setKey(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))}
        />
        <Button
          variant="primary"
          icon={<Plus size={14} />}
          disabled={!name.trim() || !/^[A-Z][A-Z0-9]{0,6}$/.test(key)}
          onClick={() => {
            createTeam(name.trim(), key, PALETTE[Math.floor(Math.random() * 10)]);
            setName("");
            setKey("");
          }}
        >
          チームを作成
        </Button>
      </div>
    </Section>
  );
}

export function SettingsPage() {
  const { section = "workspace", id } = useParams();
  const p = useWsPath();
  const teams = useTeams();
  useDocumentTitle("設定");
  const nav = [
    ["account", "アカウント", [["profile", "プロフィールと表示"]]],
    [
      "workspace",
      "ワークスペース",
      [
        ["workspace", "全般"],
        ["members", "メンバー"],
        ["labels", "ラベル"],
        ["teams", "チーム"],
        ["trash", "削除した課題"],
      ],
    ],
  ] as const;
  return (
    <div className="page settings-page" data-testid="settings-page">
      <PageHeader title={<span className="page-title-text">設定</span>} screen="settings" />
      <div className="settings-layout">
        <nav className="settings-nav">
          {nav.map(([k, title, items]) => (
            <div key={k}>
              <div className="nav-section">{title}</div>
              {items.map(([s, l]) => (
                <NavLink key={s} to={p(`/settings/${s}`)} className={({ isActive }) => cx("nav-item", isActive && "active")} data-testid={`settings-nav-${s}`}>
                  <span className="nav-label">{l}</span>
                </NavLink>
              ))}
            </div>
          ))}
          <div className="nav-section">チームの設定</div>
          {teams.map((t) => (
            <NavLink key={t.id} to={p(`/settings/team/${t.id}`)} className={({ isActive }) => cx("nav-item", isActive && "active")}>
              <span className="nav-icon">
                <TeamIcon team={t} size={16} />
              </span>
              <span className="nav-label">{t.name}</span>
            </NavLink>
          ))}
        </nav>
        <div className="settings-content">
          {section === "profile" && <ProfileSettings />}
          {section === "workspace" && <WorkspaceSettings />}
          {section === "members" && <MembersSettings />}
          {section === "labels" && <LabelsSettings />}
          {section === "teams" && <TeamsSettings />}
          {section === "trash" && <TrashSettings />}
          {section === "team" && id && <TeamSettings key={id} teamId={id} />}
        </div>
      </div>
    </div>
  );
}
