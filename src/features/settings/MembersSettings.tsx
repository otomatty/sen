import { useCallback, useEffect, useRef, useState } from "react";
import { Copy, Trash2, X } from "lucide-react";
import type { InvitationCreateResponse, InvitationIssued, InvitationListResponse, InvitationSummary, Role } from "../../../shared/types";
import { emailDomain, isEmailAllowed, isValidDomain, isValidEmail, MAX_ALLOWED_DOMAINS, normalizeDomain, normalizeEmail } from "../../../shared/domains";
import { useData } from "../../store/data";
import { removeMember, setAllowedDomains, setMemberRole } from "../../store/actions";
import { useMembers } from "../../store/selectors";
import { toast } from "../../store/ui";
import { copyText } from "../../lib/utils";
import { api } from "../../lib/api";
import { confirmDialog } from "../../components/ConfirmDialog";
import { Avatar, Button, Spinner } from "../../components/ui";
import { useIsAdmin } from "../../app/hooks";
import { Section } from "./parts";

const EMPTY_DOMAINS: string[] = [];
const DAY_MS = 86_400_000;

function roleLabel(role: Role): string {
  return role === "admin" ? "管理者" : "メンバー";
}

function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/** カンマ・読点・空白・改行で分ける */
function splitEmails(raw: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const part of raw.split(/[\s,、，]+/)) {
    const email = normalizeEmail(part);
    if (!email || seen.has(email)) continue;
    seen.add(email);
    out.push(email);
  }
  return out;
}

function expiryLabel(inv: Pick<InvitationSummary, "expiresAt" | "status">, now = Date.now()): string {
  if (inv.status === "expired" || inv.expiresAt <= now) return "期限切れ";
  const days = Math.max(1, Math.ceil((inv.expiresAt - now) / DAY_MS));
  return `${days}日後に期限切れ`;
}

function mailStatus(issued: InvitationIssued): string {
  if (issued.emailSent) return "メールを送りました";
  return issued.emailError ? `メールは送られていません：${issued.emailError}` : "メールは送られていません";
}

function MemberList() {
  const members = useMembers();
  const meId = useData((s) => s.meId);
  const allowed = useData((s) => s.workspace?.allowedDomains) ?? EMPTY_DOMAINS;
  const admin = useIsAdmin();
  return (
    <Section title={`メンバー（${members.length}人）`}>
      {members.map((m) => {
        const blocked = allowed.length > 0 && !isEmailAllowed(m.email, allowed);
        return (
          <div key={m.id} className="member-row">
            <Avatar user={m} size={28} />
            <div className="member-info">
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
              <span className="muted small">{m.email}</span>
            </div>
            <span className="spacer" />
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
      {!admin && <p className="muted settings-empty">メンバーの招待は管理者が行います。</p>}
    </Section>
  );
}

function IssuedResults({ issued, onClose }: { issued: InvitationIssued[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.scrollIntoView({ block: "nearest" });
  }, [issued]);
  if (!issued.length) return null;
  return (
    <div className="invite-results" ref={ref}>
      <div className="invite-results-bar">
        <Button type="button" variant="ghost" size="sm" onClick={onClose}>
          閉じる
        </Button>
      </div>
      {issued.map((r) => (
        <div key={r.invitation.id} className="invite-result" data-testid="invite-result" data-email={r.invitation.email}>
          <b className="invite-result-email">{r.invitation.email}</b>
          <span className="muted small">{mailStatus(r)}</span>
          <div className="invite-result-link-row">
            <input
              className="input"
              readOnly
              value={r.link}
              data-testid="invite-result-link"
              aria-label={`${r.invitation.email} の招待リンク`}
              onFocus={(e) => e.target.select()}
            />
            <Button
              type="button"
              icon={<Copy size={14} />}
              onClick={() => void copyText(r.link).then(() => toast("招待リンクをコピーしました"))}
            >
              コピー
            </Button>
          </div>
          <p className="muted small">このリンクは今だけ表示されます</p>
        </div>
      ))}
    </div>
  );
}

function InviteForm({
  wsKey,
  emailEnabled,
  issued,
  onIssued,
  onDone,
}: {
  wsKey: string;
  emailEnabled: boolean | null;
  issued: InvitationIssued[];
  onIssued: (issued: InvitationIssued[]) => void;
  onDone: () => void;
}) {
  const allowed = useData((s) => s.workspace?.allowedDomains) ?? EMPTY_DOMAINS;
  const [raw, setRaw] = useState("");
  const [role, setRole] = useState<Role>("member");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const emails = splitEmails(raw);
  const blocked = allowed.length ? emails.filter((e) => isValidEmail(e) && !isEmailAllowed(e, allowed)) : [];

  const submit = async () => {
    if (!wsKey || busy) return;
    setError(null);
    if (!emails.length) {
      setError("メールアドレスを指定してください");
      return;
    }
    setBusy(true);
    try {
      const res = await api<InvitationCreateResponse>(`/api/invitations?ws=${encodeURIComponent(wsKey)}`, {
        body: { emails, role },
      });
      setRaw("");
      onIssued(res.results);
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section
      title="メンバーを招待"
      description="招待したい人のメールアドレスを入力してください。招待は 7 日間有効で、1 回だけ使えます。招待したアドレスの Google アカウントでログインしたときだけ参加できます。"
    >
      {emailEnabled === false && (
        <p className="invite-banner">
          招待メールの送信が設定されていないため、メールは送られません。招待したあとに表示されるリンクを、本人に送ってください。
        </p>
      )}
      <textarea
        className="invite-emails"
        data-testid="invite-emails"
        aria-label="招待するメールアドレス"
        placeholder="hanako@example.com, ichiro@example.com"
        value={raw}
        rows={3}
        onChange={(e) => setRaw(e.target.value)}
      />
      {allowed.length > 0 && <p className="muted small domain-hint">利用できるドメイン：{allowed.join("、")}</p>}
      <div className="invite-actions">
        <label className="invite-role">
          権限
          <select data-testid="invite-role" aria-label="権限" value={role} onChange={(e) => setRole(e.target.value as Role)}>
            <option value="member">メンバー</option>
            <option value="admin">管理者</option>
          </select>
        </label>
        <Button type="button" variant="primary" data-testid="invite-submit" disabled={busy || !raw.trim() || !wsKey} onClick={() => void submit()}>
          {busy ? "招待しています…" : "招待する"}
        </Button>
      </div>
      {blocked.length > 0 && <p className="form-warn">許可されていないドメインのアドレスが含まれています：{blocked.join("、")}</p>}
      {error && <p className="form-error">{error}</p>}
      <IssuedResults issued={issued} onClose={() => onIssued([])} />
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

  return (
    <Section title="招待中">
      {loading && invitations.length === 0 && !loadError ? (
        <div className="settings-loading">
          <Spinner />
        </div>
      ) : loadError && invitations.length === 0 ? (
        <p className="form-error">{loadError}</p>
      ) : invitations.length === 0 ? (
        <p className="muted settings-empty">招待中の人はいません</p>
      ) : (
        <>
          {loadError && <p className="form-error">{loadError}</p>}
          {invitations.map((inv) => (
            <div key={inv.id} className="member-row invitation-row" data-testid="invitation-row" data-email={inv.email}>
              <div className="member-info">
                <b className="invite-result-email">{inv.email}</b>
                <span className="muted small invitation-meta">
                  {roleLabel(inv.role)}
                  <span>・</span>
                  {inv.invitedBy ? `招待した人：${inv.invitedBy.name}` : "招待した人は不明"}
                  <span>・</span>
                  {expiryLabel(inv)}
                  <span>・</span>
                  {inv.emailSentAt ? "メールを送りました" : "メールは送られていません"}
                </span>
              </div>
              <div className="invitation-actions">
                <Button type="button" size="sm" data-testid="invitation-resend" disabled={busyId !== null} onClick={() => void resend(inv)}>
                  再送
                </Button>
                <Button type="button" size="sm" variant="ghost" data-testid="invitation-revoke" disabled={busyId !== null} onClick={() => void revoke(inv)}>
                  取り消す
                </Button>
              </div>
            </div>
          ))}
        </>
      )}
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
          {domains.map((d) => (
            <span key={d} className="chip domain-chip" data-testid="allowed-domain">
              <span className="chip-text">{d}</span>
              {admin && (
                <button type="button" className="chip-x" aria-label={`${d} を外す`} onClick={() => edit(domains.filter((x) => x !== d))}>
                  <X size={12} />
                </button>
              )}
            </span>
          ))}
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
          <div className="domain-save">
            <Button type="button" variant="primary" data-testid="allowed-domains-save" disabled={!dirty || saving} onClick={() => void save()}>
              {saving ? "保存しています…" : "保存"}
            </Button>
          </div>
          {saveError && <p className="form-error">{saveError}</p>}
        </>
      )}
    </Section>
  );
}

export function MembersSettings() {
  const admin = useIsAdmin();
  const wsKey = useData((s) => s.workspace?.urlKey ?? "");
  const [invitations, setInvitations] = useState<InvitationSummary[]>([]);
  const [emailEnabled, setEmailEnabled] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [issued, setIssued] = useState<InvitationIssued[]>([]);
  const [tick, setTick] = useState(0);
  const [scope, setScope] = useState(wsKey);
  const loadSeq = useRef(0);
  const reload = useCallback(() => setTick((n) => n + 1), []);
  if (scope !== wsKey) {
    setScope(wsKey);
    setInvitations([]);
    setIssued([]);
    setEmailEnabled(null);
    setLoadError(null);
    setLoading(!!wsKey);
  }

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
      <MemberList />
      {admin && <InviteForm key={wsKey} wsKey={wsKey} emailEnabled={emailEnabled} issued={issued} onIssued={setIssued} onDone={reload} />}
      {admin && (
        <InvitationList wsKey={wsKey} invitations={invitations} loading={loading} loadError={loadError} onIssued={setIssued} onChange={reload} />
      )}
      <AllowedDomains key={wsKey} onSaved={reload} />
    </>
  );
}
