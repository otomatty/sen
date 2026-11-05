import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Check, Copy, X } from "lucide-react";
import type { InvitationCreateResponse, InvitationIssued, InvitationSummary, Role } from "../../../shared/types";
import { isEmailAllowed, isValidEmail, MAX_INVITATIONS_PER_REQUEST, normalizeEmail } from "../../../shared/domains";
import { useData } from "../../store/data";
import { useMembers } from "../../store/selectors";
import { api } from "../../lib/api";
import { copyText, cx } from "../../lib/utils";
import { Button, Modal } from "../../components/ui";

const EMPTY_DOMAINS: string[] = [];
/** 半角・全角のカンマ、読点、空白、改行 */
const SEPARATOR = /[\s,、，]/;
const SEPARATOR_SPLIT = /[\s,、，]+/;

type ChipStatus = "ok" | "invalid" | "member" | "blocked" | "pending";

/** カンマ・読点・空白・改行で分け、同じアドレスは 1 つにする */
function splitEmails(raw: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const part of raw.split(SEPARATOR_SPLIT)) {
    const email = normalizeEmail(part);
    if (!email || seen.has(email)) continue;
    seen.add(email);
    out.push(email);
  }
  return out;
}

function commitRaw(current: string[], raw: string): string[] {
  if (!raw) return current;
  const seen = new Set(current);
  const next = [...current];
  for (const email of splitEmails(raw)) {
    if (seen.has(email)) continue;
    seen.add(email);
    next.push(email);
  }
  return next;
}

function chipStatus(email: string, memberEmails: Set<string>, pendingEmails: Set<string>, allowed: string[]): ChipStatus {
  if (!isValidEmail(email)) return "invalid";
  if (memberEmails.has(email)) return "member";
  if (allowed.length > 0 && !isEmailAllowed(email, allowed)) return "blocked";
  if (pendingEmails.has(email)) return "pending";
  return "ok";
}

function isBlocking(status: ChipStatus): boolean {
  return status === "invalid" || status === "member" || status === "blocked";
}

function chipMessage(email: string, status: ChipStatus): string | null {
  switch (status) {
    case "invalid":
      return `${email} は、メールアドレスの形式が正しくありません。`;
    case "member":
      return `${email} は、すでにメンバーです。`;
    case "blocked":
      return `${email} は、利用できるドメインのアドレスではありません。`;
    case "pending":
      return `${email} は招待中です。新しいリンクで招待し直します。`;
    default:
      return null;
  }
}

function roleLabel(role: Role): string {
  return role === "admin" ? "管理者" : "メンバー";
}

function isSeparatorKey(key: string): boolean {
  return key === "," || key === "、" || key === "，" || key === " " || key === "　" || key === "Enter";
}

function resultNote(issued: InvitationIssued, emailEnabled: boolean | null): { text: string; kind: "ok" | "warn" | "muted" } {
  if (issued.emailSent) return { text: "メールを送りました", kind: "ok" };
  if (emailEnabled === false) return { text: roleLabel(issued.invitation.role), kind: "muted" };
  return { text: `メールは送られていません：${issued.emailError ?? ""}`, kind: "warn" };
}

/** 招待後の案内。全員・誰も送れない・一部だけ、で文言を分ける */
function mailNotice(results: InvitationIssued[]): { text: string; warn: boolean } {
  const sent = results.filter((r) => r.emailSent).length;
  if (sent === results.length) {
    return { text: "メールが届かないときは、リンクをコピーして本人に送ってください。", warn: false };
  }
  if (sent === 0) {
    return { text: "招待メールは送られていません。リンクをコピーして、本人に送ってください。", warn: true };
  }
  return {
    text: "一部の人には、招待メールを送れませんでした。「メールは送られていません」と出ている人には、リンクをコピーして送ってください。",
    warn: true,
  };
}

export function InviteDialog({
  wsKey,
  emailEnabled,
  invitations,
  initial,
  onClose,
  onInvited,
}: {
  wsKey: string;
  emailEnabled: boolean | null;
  invitations: InvitationSummary[];
  /** 再送の結果。無いときは入力から始める */
  initial: { results: InvitationIssued[]; resent: boolean } | null;
  onClose: () => void;
  onInvited: () => void;
}) {
  const members = useMembers();
  const allowed = useData((s) => s.workspace?.allowedDomains) ?? EMPTY_DOMAINS;
  const memberEmails = useMemo(() => new Set(members.map((m) => normalizeEmail(m.email))), [members]);
  const pendingEmails = useMemo(() => new Set(invitations.map((i) => normalizeEmail(i.email))), [invitations]);

  const [phase, setPhase] = useState<"compose" | "done">(initial ? "done" : "compose");
  const [results, setResults] = useState<InvitationIssued[]>(initial?.results ?? []);
  const [resent, setResent] = useState(initial?.resent ?? false);
  const [emails, setEmails] = useState<string[]>([]);
  const [draft, setDraft] = useState("");
  const [role, setRole] = useState<Role>("member");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<Record<string, true>>({});
  const inputRef = useRef<HTMLInputElement>(null);
  const busyRef = useRef(false);
  const copyTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  useEffect(() => {
    if (phase === "compose") inputRef.current?.focus();
  }, [phase]);

  useEffect(
    () => () => {
      for (const timer of copyTimers.current.values()) clearTimeout(timer);
    },
    [],
  );

  const statusOf = (email: string) => chipStatus(email, memberEmails, pendingEmails, allowed);
  const count = commitRaw(emails, draft).length;
  const blocking = emails.some((email) => isBlocking(statusOf(email)));
  const tooMany = count > MAX_INVITATIONS_PER_REQUEST;
  const canSubmit = !!wsKey && !busy && count > 0 && !blocking && !tooMany;

  const flush = (raw: string) => {
    if (raw) setEmails((cur) => commitRaw(cur, raw));
    setDraft("");
  };

  const applyDraft = (value: string, event?: InputEvent) => {
    setError(null);
    const data = event?.data ?? "";
    // 変換などで区切りが 1 文字入ったときだけ、その場でチップにする。
    // まとめて入った文字（fill や貼り付けの取りこぼし）は、Enter・フォーカス移動・送信で分ける。
    if (event?.inputType && data.length === 1 && SEPARATOR.test(data)) {
      const parts = value.split(SEPARATOR_SPLIT);
      const rest = parts.pop() ?? "";
      const tokens = parts.join(",");
      if (tokens) setEmails((cur) => commitRaw(cur, tokens));
      setDraft(rest);
      return;
    }
    setDraft(value);
  };

  const removeEmail = (email: string) => {
    setError(null);
    setEmails((cur) => cur.filter((x) => x !== email));
  };

  const submit = async () => {
    if (busyRef.current || !wsKey) return;
    const next = commitRaw(emails, draft);
    setEmails(next);
    setDraft("");
    setError(null);
    if (!next.length || next.length > MAX_INVITATIONS_PER_REQUEST || next.some((email) => isBlocking(statusOf(email)))) return;
    busyRef.current = true;
    setBusy(true);
    try {
      const res = await api<InvitationCreateResponse>(`/api/invitations?ws=${encodeURIComponent(wsKey)}`, {
        body: { emails: next, role },
      });
      setResults(res.results);
      setResent(false);
      setPhase("done");
      onInvited();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const again = () => {
    setPhase("compose");
    setResults([]);
    setResent(false);
    setEmails([]);
    setDraft("");
    setRole("member");
    setError(null);
    setCopied({});
    for (const timer of copyTimers.current.values()) clearTimeout(timer);
    copyTimers.current.clear();
  };

  const copyLink = (email: string, link: string) => {
    void copyText(link).then(() => {
      setCopied((cur) => ({ ...cur, [email]: true }));
      const prev = copyTimers.current.get(email);
      if (prev) clearTimeout(prev);
      copyTimers.current.set(
        email,
        setTimeout(() => {
          setCopied((cur) => {
            if (!cur[email]) return cur;
            const next = { ...cur };
            delete next[email];
            return next;
          });
          copyTimers.current.delete(email);
        }, 2000),
      );
    });
  };

  const hint =
    `カンマ・スペース・改行で区切ると、まとめて入れられます（${MAX_INVITATIONS_PER_REQUEST} 人まで）。` +
    (allowed.length > 0 ? `利用できるドメイン：${allowed.join("、")}` : "");

  // 送信中に閉じると、1 回しか出ない参加リンクが見られなくなる。
  const requestClose = () => {
    if (busyRef.current) return;
    onClose();
  };

  const notice = mailNotice(results);

  return (
    <Modal onClose={requestClose} width={520} className="invite-dialog" testId="invite-dialog">
      <div className="modal-head">
        {phase === "done" ? (
          <h2 data-testid="invite-done">
            <span className="invite-done-icon" aria-hidden>
              <Check size={13} strokeWidth={2.6} />
            </span>
            {resent ? "新しいリンクで招待し直しました" : `${results.length} 人を招待しました`}
          </h2>
        ) : (
          <h2>メンバーを招待</h2>
        )}
        <span className="spacer" />
        <button type="button" className="icon-btn" onClick={requestClose} aria-label="閉じる" disabled={busy}>
          <X size={16} />
        </button>
      </div>

      {phase === "compose" ? (
        <div className="invite-dialog-body">
          <p className="muted">招待した人は、そのメールアドレスの Google アカウントでログインすると参加できます。招待は 7 日間有効で、1 回だけ使えます。</p>
          {emailEnabled === false && (
            <p className="invite-banner">
              <AlertTriangle size={14} />
              <span>招待メールの送信が設定されていません。招待したあとに出るリンクを、本人に送ってください。</span>
            </p>
          )}
          <div className="invite-field">
            <span className="invite-field-label">メールアドレス</span>
            <div
              className="invite-chip-box"
              onMouseDown={(e) => {
                if ((e.target as HTMLElement).closest("button, input")) return;
                e.preventDefault();
                inputRef.current?.focus();
              }}
            >
              {emails.map((email) => {
                const status = statusOf(email);
                return (
                  <span key={email} className={cx("invite-chip", `is-${status}`)} data-testid="invite-chip" data-email={email} data-status={status}>
                    <span className="invite-chip-text">{email}</span>
                    {status === "pending" && <span className="invite-chip-note">・招待中</span>}
                    <button
                      type="button"
                      className="invite-chip-x"
                      aria-label={`${email} を外す`}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => removeEmail(email)}
                    >
                      <X size={12} />
                    </button>
                  </span>
                );
              })}
              <input
                ref={inputRef}
                className="invite-chip-input"
                data-testid="invite-emails"
                aria-label="招待するメールアドレス"
                placeholder={emails.length ? "続けて入力" : "hanako@example.com, ichiro@example.com"}
                value={draft}
                autoFocus
                onChange={(e) => applyDraft(e.target.value, e.nativeEvent as InputEvent)}
                onBlur={() => {
                  if (!draft) return;
                  flush(draft);
                }}
                onPaste={(e) => {
                  const text = e.clipboardData.getData("text");
                  if (!text) return;
                  e.preventDefault();
                  const el = e.currentTarget;
                  const start = el.selectionStart ?? draft.length;
                  const end = el.selectionEnd ?? draft.length;
                  const merged = draft.slice(0, start) + text + draft.slice(end);
                  setError(null);
                  setEmails((cur) => commitRaw(cur, merged));
                  setDraft("");
                }}
                onKeyDown={(e) => {
                  if (e.nativeEvent.isComposing) return;
                  if (isSeparatorKey(e.key)) {
                    e.preventDefault();
                    flush(draft);
                    return;
                  }
                  if (e.key === "Backspace" && draft === "" && emails.length > 0) {
                    e.preventDefault();
                    setEmails((cur) => cur.slice(0, -1));
                  }
                }}
              />
            </div>
            <p className="muted small">{hint}</p>
            {(emails.some((email) => chipMessage(email, statusOf(email))) || tooMany) && (
              <div className="invite-chip-messages">
                {emails.map((email) => {
                  const status = statusOf(email);
                  const message = chipMessage(email, status);
                  if (!message) return null;
                  return (
                    <p key={email} className={cx("invite-chip-message", `is-${status}`)} data-testid="invite-chip-message">
                      {message}
                    </p>
                  );
                })}
                {tooMany && <p className="text-danger invite-chip-message">一度に招待できるのは {MAX_INVITATIONS_PER_REQUEST} 人までです。</p>}
              </div>
            )}
          </div>
          <div className="invite-field">
            <span className="invite-field-label">権限</span>
            <div className="invite-role-switch" role="radiogroup" aria-label="権限">
              <button
                type="button"
                role="radio"
                aria-checked={role === "member"}
                className={cx(role === "member" && "on")}
                data-testid="invite-role-member"
                onClick={() => setRole("member")}
              >
                メンバー
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={role === "admin"}
                className={cx(role === "admin" && "on")}
                data-testid="invite-role-admin"
                onClick={() => setRole("admin")}
              >
                管理者
              </button>
            </div>
            <p className="muted small">管理者は、メンバーの招待・権限の変更・利用できるドメインの設定もできます。</p>
          </div>
          {error && (
            <p className="form-error" data-testid="invite-error">
              {error}
            </p>
          )}
        </div>
      ) : (
        <div className="invite-dialog-body">
          <p className={notice.warn ? "invite-mail-warn" : "muted"}>{notice.text}</p>
          <div className="invite-done-list">
            {results.map((r) => {
              const email = r.invitation.email;
              const note = resultNote(r, emailEnabled);
              const done = !!copied[email];
              return (
                <div key={r.invitation.id} className="invite-result" data-testid="invite-result" data-email={email}>
                  <div className="invite-result-top">
                    <div className="invite-result-main">
                      <b className="invite-result-email">{email}</b>
                      <span className={cx("small", note.kind === "ok" && "invite-mail-ok", note.kind === "warn" && "invite-mail-warn", note.kind === "muted" && "muted")}>
                        {note.text}
                      </span>
                    </div>
                    <Button
                      type="button"
                      size="sm"
                      className={done ? "invite-copied" : undefined}
                      icon={done ? <Check size={13} /> : <Copy size={13} />}
                      data-testid="invite-result-copy"
                      onClick={() => copyLink(email, r.link)}
                    >
                      {done ? "コピーしました" : "リンクをコピー"}
                    </Button>
                  </div>
                  <input
                    className="invite-result-link"
                    readOnly
                    value={r.link}
                    data-testid="invite-result-link"
                    aria-label={`${email} の招待リンク`}
                    onFocus={(e) => e.target.select()}
                  />
                </div>
              );
            })}
          </div>
          <p className="muted small">リンクは、この画面を閉じると二度と表示されません。あとで必要になったら、招待中の一覧の「招待し直す」で新しいリンクを作れます。</p>
        </div>
      )}

      <div className="invite-dialog-foot">
        {phase === "compose" ? (
          <>
            <Button type="button" variant="ghost" onClick={requestClose} disabled={busy}>
              キャンセル
            </Button>
            <Button type="button" variant="primary" data-testid="invite-submit" disabled={!canSubmit} onClick={() => void submit()}>
              {busy ? "招待しています…" : `${count} 人を招待`}
            </Button>
          </>
        ) : (
          <>
            <Button type="button" variant="ghost" data-testid="invite-again" onClick={again}>
              続けて招待
            </Button>
            <Button type="button" variant="primary" data-testid="invite-done-close" onClick={onClose}>
              閉じる
            </Button>
          </>
        )}
      </div>
    </Modal>
  );
}
