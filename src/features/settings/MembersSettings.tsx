import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { Mail, Trash2, UserPlus, X } from "lucide-react";
import type { InvitationIssued, InvitationListResponse, InvitationSummary, Role } from "../../../shared/types";
import { emailDomain, isEmailAllowed, isValidDomain, MAX_ALLOWED_DOMAINS, normalizeDomain } from "../../../shared/domains";
import { useData } from "../../store/data";
import { removeMember, setAllowedDomains, setMemberRole } from "../../store/actions";
import { useMembers } from "../../store/selectors";
import { toast } from "../../store/ui";
import { api } from "../../lib/api";
import { cx } from "../../lib/utils";
import { confirmDialog } from "../../components/ConfirmDialog";
import { Avatar, Button } from "../../components/ui";
import { useIsAdmin } from "../../app/hooks";
import { InviteDialog } from "./InviteDialog";
import { Section } from "./parts";

const EMPTY_DOMAINS: string[] = [];
const DAY_MS = 86_400_000;

function roleLabel(role: Role): string {
  return role === "admin" ? "管理者" : "メンバー";
}

function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

function isExpired(inv: Pick<InvitationSummary, "expiresAt" | "status">, now = Date.now()): boolean {
  return inv.status === "expired" || inv.expiresAt <= now;
}

function expiryLabel(inv: Pick<InvitationSummary, "expiresAt" | "status">, now = Date.now()): string {
  if (isExpired(inv, now)) {
    const d = new Date(inv.expiresAt);
    return `${d.getMonth() + 1}月${d.getDate()}日に期限切れ`;
  }
  const days = Math.max(1, Math.ceil((inv.expiresAt - now) / DAY_MS));
  return `あと ${days} 日`;
}

function invitationTone(inv: InvitationSummary, now = Date.now()): "danger" | "success" | "warn" {
  if (isExpired(inv, now)) return "danger";
  if (inv.emailSentAt != null) return "success";
  return "warn";
}

function invitationStatusLabel(tone: "danger" | "success" | "warn"): string {
  if (tone === "danger") return "期限切れ";
  if (tone === "success") return "メールを送りました";
  return "メール未送信";
}

function countTitle(label: string, count: string) {
  return (
    <>
      {label}
      <span className="settings-section-count">（{count}）</span>
    </>
  );
}

function MemberList() {
  const members = useMembers();
  const meId = useData((s) => s.meId);
  const allowed = useData((s) => s.workspace?.allowedDomains) ?? EMPTY_DOMAINS;
  const admin = useIsAdmin();
  return (
    <Section title={countTitle("メンバー", `${members.length}人`)}>
      {members.map((m) => {
        const blocked = allowed.length > 0 && !isEmailAllowed(m.email, allowed);
        return (
          <div key={m.id} className="member-row">
            <Avatar user={m} size={28} />
            <div className="member-info member-person">
              <span className="member-name-line">
                <b>
                  {m.name}
                  {m.id === meId && <span className="muted">（あなた）</span>}
                </b>
                {blocked && (
                  <span className="pill warn" data-testid="member-domain-blocked">
                    許可外のドメイン（利用できません）
                  </span>
                )}
              </span>
              <span className="muted small member-email" title={m.email}>
                {m.email}
              </span>
            </div>
            {admin && m.id !== meId ? (
              <>
                <select value={m.role} onChange={(e) => setMemberRole(m.id, e.target.value as Role)}>
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
        );
      })}
    </Section>
  );
}

function InvitationList({
  wsKey,
  invitations,
  loading,
  loadError,
  onIssued,
  onChange,
}: {
  wsKey: string;
  invitations: InvitationSummary[];
  loading: boolean;
  loadError: string | null;
  onIssued: (issued: InvitationIssued[]) => void;
  onChange: () => void;
}) {
  const [busyId, setBusyId] = useState<string | null>(null);

  const resend = async (inv: InvitationSummary) => {
    if (busyId) return;
    const ok = await confirmDialog({
      title: "新しいリンクで招待し直しますか？",
      message: "今のリンクは使えなくなります。",
      confirmLabel: "招待し直す",
    });
    if (!ok) return;
    setBusyId(inv.id);
    try {
      const res = await api<InvitationIssued>(`/api/invitations/${inv.id}/resend?ws=${encodeURIComponent(wsKey)}`, { body: {} });
      onIssued([res]);
      onChange();
    } catch (e) {
      toast((e as Error).message, { kind: "error" });
    } finally {
      setBusyId(null);
    }
  };

  const revoke = async (inv: InvitationSummary) => {
    if (busyId) return;
    const ok = await confirmDialog({
      title: `${inv.email} への招待を取り消しますか？`,
      message: "この招待リンクは使えなくなります。",
      confirmLabel: "取り消す",
      danger: true,
    });
    if (!ok) return;
    setBusyId(inv.id);
    try {
      await api(`/api/invitations/${inv.id}?ws=${encodeURIComponent(wsKey)}`, { method: "DELETE" });
      toast("招待を取り消しました");
      onChange();
    } catch (e) {
      toast((e as Error).message, { kind: "error" });
    } finally {
      setBusyId(null);
    }
  };

  // 招待が無いときは出さない。読み込みに失敗したときだけ、空でもエラーを出す。
  if (invitations.length === 0 && (loading || !loadError)) return null;

  return (
    <Section title={countTitle("招待中", `${invitations.length}件`)}>
      {loadError && <p className="form-error">{loadError}</p>}
      {invitations.map((inv) => {
        const expired = isExpired(inv);
        const tone = invitationTone(inv);
        const by = inv.invitedBy ? `${inv.invitedBy.name} さんが招待` : "招待した人は不明";
        return (
          <div key={inv.id} className="member-row invitation-row" data-testid="invitation-row" data-email={inv.email}>
            <span className="invitation-mark muted" aria-hidden>
              <Mail size={14} />
            </span>
            <div className="member-info invitation-main">
              <span className="invitation-email-line">
                <b className={cx("invitation-email", expired && "muted")} title={inv.email}>
                  {inv.email}
                </b>
                <span className={cx("pill", "invitation-status", tone)} data-testid="invitation-status">
                  {invitationStatusLabel(tone)}
                </span>
              </span>
              <span className="muted small">
                {roleLabel(inv.role)} ・ {by} ・ {expiryLabel(inv)}
              </span>
            </div>
            <div className="invitation-actions">
              <Button
                type="button"
                size="sm"
                variant={expired ? "primary" : "secondary"}
                data-testid="invitation-resend"
                disabled={busyId !== null}
                onClick={() => void resend(inv)}
              >
                招待し直す
              </Button>
              <Button type="button" size="sm" variant="ghost" data-testid="invitation-revoke" disabled={busyId !== null} onClick={() => void revoke(inv)}>
                取り消す
              </Button>
            </div>
          </div>
        );
      })}
    </Section>
  );
}

function AllowedDomains({ onSaved }: { onSaved: () => void }) {
  const admin = useIsAdmin();
  const members = useMembers();
  const saved = useData((s) => s.workspace?.allowedDomains) ?? EMPTY_DOMAINS;
  const me = useData((s) => (s.meId ? s.users[s.meId] : null));
  const [draft, setDraft] = useState<string[] | null>(null);
  const [input, setInput] = useState("");
  const [inputError, setInputError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const domains = draft ?? saved;
  const dirty = draft !== null && !sameList(draft, saved);

  const edit = (next: string[]) => {
    setSaveError(null);
    setDraft(sameList(next, saved) ? null : next);
  };

  const add = () => {
    const domain = normalizeDomain(input);
    if (!domain) {
      setInputError("ドメインを入力してください");
      return;
    }
    if (!isValidDomain(domain)) {
      setInputError("ドメインの形式が正しくありません");
      return;
    }
    if (domains.includes(domain)) {
      setInputError("すでに追加しています");
      return;
    }
    if (domains.length >= MAX_ALLOWED_DOMAINS) {
      setInputError(`利用できるドメインは${MAX_ALLOWED_DOMAINS}個までです`);
      return;
    }
    setInputError(null);
    setInput("");
    edit([...domains, domain]);
  };

  const reset = () => {
    setDraft(null);
    setInputError(null);
    setSaveError(null);
  };

  const save = async () => {
    if (!dirty || saving) return;
    setSaveError(null);
    if (domains.length > 0) {
      const mine = emailDomain(me?.email ?? "");
      if (!domains.includes(mine)) {
        setSaveError(`あなたのメールアドレスのドメイン（${mine}）を含めてください`);
        return;
      }
    }
    const willLose = members.filter((m) => isEmailAllowed(m.email, saved) && !isEmailAllowed(m.email, domains));
    if (willLose.length) {
      const ok = await confirmDialog({
        title: "次の人はこのワークスペースを使えなくなります",
        message: `${willLose.map((m) => `${m.name}（${m.email}）`).join("\n")}\n\n許可外のドメイン宛ての招待中の招待も取り消されます。`,
        confirmLabel: "保存する",
        danger: true,
      });
      if (!ok) return;
    }
    const snapshot = [...domains];
    setSaving(true);
    try {
      const ok = await setAllowedDomains(snapshot);
      if (!ok) return;
      setDraft((cur) => (cur && sameList(cur, snapshot) ? null : cur));
      onSaved();
    } finally {
      setSaving(false);
    }
  };

  return (
    <Section
      title="利用できるドメイン"
      description="設定すると、ここにあるドメインのメールアドレスの人だけが、招待・参加・利用できます。空のときは制限しません。サブドメインは含みません（example.com を許可しても a.example.com は含まれません）。"
    >
      {domains.length === 0 ? (
        <p className="muted small domain-hint">制限していません</p>
      ) : (
        <div className="domain-chips">
          {domains.map((d) => {
            const unsaved = !saved.includes(d);
            return (
              <span key={d} className={cx("chip", "domain-chip", unsaved && "is-draft")} data-testid="allowed-domain">
                <span className="chip-text">{d}</span>
                {unsaved && <span className="domain-chip-draft">（未保存）</span>}
                {admin && (
                  <button type="button" className="chip-x" aria-label={`${d} を外す`} onClick={() => edit(domains.filter((x) => x !== d))}>
                    <X size={12} />
                  </button>
                )}
              </span>
            );
          })}
        </div>
      )}
      {admin && (
        <>
          <div className="label-add domain-add">
            <input
              className="input"
              data-testid="allowed-domains-input"
              aria-label="利用できるドメイン"
              placeholder="example.com"
              value={input}
              onChange={(e) => {
                setInput(e.target.value);
                setInputError(null);
              }}
              onKeyDown={(e) => {
                if (!e.nativeEvent.isComposing && e.key === "Enter") {
                  e.preventDefault();
                  add();
                }
              }}
            />
            <Button type="button" data-testid="allowed-domains-add" disabled={!input.trim()} onClick={add}>
              追加
            </Button>
          </div>
          {inputError && <p className="form-error">{inputError}</p>}
          {saveError && <p className="form-error">{saveError}</p>}
          {dirty && (
            <div className="domain-pending">
              <span className="domain-pending-note">まだ保存していない変更があります</span>
              <Button type="button" variant="ghost" size="sm" data-testid="allowed-domains-reset" disabled={saving} onClick={reset}>
                元に戻す
              </Button>
              <Button type="button" variant="primary" size="sm" data-testid="allowed-domains-save" disabled={saving} onClick={() => void save()}>
                {saving ? "保存しています…" : "保存"}
              </Button>
            </div>
          )}
        </>
      )}
    </Section>
  );
}

type InviteDialogState = { kind: "compose" } | { kind: "done"; results: InvitationIssued[]; resent: boolean };

export function MembersSettings() {
  const admin = useIsAdmin();
  const wsKey = useData((s) => s.workspace?.urlKey ?? "");
  const wsName = useData((s) => s.workspace?.name ?? "");
  const [searchParams, setSearchParams] = useSearchParams();
  const [invitations, setInvitations] = useState<InvitationSummary[]>([]);
  const [emailEnabled, setEmailEnabled] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<InviteDialogState | null>(null);
  const [tick, setTick] = useState(0);
  const [scope, setScope] = useState(wsKey);
  const loadSeq = useRef(0);
  const reload = useCallback(() => setTick((n) => n + 1), []);
  if (scope !== wsKey) {
    setScope(wsKey);
    setInvitations([]);
    setDialog(null);
    setEmailEnabled(null);
    setLoadError(null);
    setLoading(!!wsKey);
  }

  // サイドバーや受信トレイの「メンバーを招待」は ?invite=1 で開く。開いたらパラメーターは消す。
  const inviteRequested = searchParams.get("invite") === "1";
  useEffect(() => {
    if (!inviteRequested) return;
    if (admin) setDialog({ kind: "compose" });
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete("invite");
        return next;
      },
      { replace: true },
    );
  }, [admin, inviteRequested, setSearchParams]);

  useEffect(() => {
    if (!admin || !wsKey) {
      setLoading(false);
      return;
    }
    const seq = ++loadSeq.current;
    setLoading(true);
    api<InvitationListResponse>(`/api/invitations?ws=${encodeURIComponent(wsKey)}`)
      .then((res) => {
        if (loadSeq.current !== seq) return;
        setInvitations(res.invitations);
        setEmailEnabled(res.emailEnabled);
        setLoadError(null);
      })
      .catch((e: Error) => {
        if (loadSeq.current !== seq) return;
        setLoadError(e.message);
      })
      .finally(() => {
        if (loadSeq.current === seq) setLoading(false);
      });
  }, [admin, wsKey, tick]);

  return (
    <>
      <header className="members-page-head">
        <div className="members-page-head-text">
          <h1>メンバー</h1>
          <p className="muted">{wsName}に参加している人と、招待中の人です。</p>
          {!admin && <p className="muted">メンバーの招待は管理者が行います。</p>}
        </div>
        {admin && (
          <Button type="button" variant="primary" icon={<UserPlus size={14} />} data-testid="invite-open" onClick={() => setDialog({ kind: "compose" })}>
            メンバーを招待
          </Button>
        )}
      </header>
      {admin && (
        <InvitationList
          wsKey={wsKey}
          invitations={invitations}
          loading={loading}
          loadError={loadError}
          onIssued={(results) => setDialog({ kind: "done", results, resent: true })}
          onChange={reload}
        />
      )}
      <MemberList />
      <AllowedDomains key={wsKey} onSaved={reload} />
      {dialog && (
        <InviteDialog
          key={dialog.kind === "done" ? dialog.results.map((r) => r.link).join("\n") : "compose"}
          wsKey={wsKey}
          emailEnabled={emailEnabled}
          invitations={invitations}
          initial={dialog.kind === "done" ? { results: dialog.results, resent: dialog.resent } : null}
          onClose={() => setDialog(null)}
          onInvited={reload}
        />
      )}
    </>
  );
}
