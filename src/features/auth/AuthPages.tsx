import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { AlertTriangle, Check, Link2Off } from "lucide-react";
import { api } from "../../lib/api";
import { Avatar, Button, Spinner } from "../../components/ui";
import { GoogleIcon, Logo } from "../../components/icons";
import { acceptPendingInvitation, devSignIn, lastWorkspaceKey, loadSession, logout, pickWorkspaceKey, refreshAccounts, signInWithGoogle, useSession } from "../../app/session";
import { formatDateTime } from "../../lib/utils";
import type { InvitePreview, PendingInvitation, Role } from "../../../shared/types";

const isDemo = typeof __SEN_DEMO__ !== "undefined" && __SEN_DEMO__;
const DAY_MS = 86_400_000;

function AuthLayout({
  title,
  subtitle,
  icon,
  children,
}: {
  title: string;
  subtitle?: React.ReactNode;
  /** ロゴの代わりに出すアイコン。渡さないときはロゴ */
  icon?: ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="auth-page">
      <div className="auth-glow" />
      <div className="auth-card">
        {icon ?? <Logo size={36} />}
        <h1>{title}</h1>
        {subtitle && <p className="muted">{subtitle}</p>}
        {children}
      </div>
      <p className="auth-foot muted small">Sen — 速く、静かに、チームの仕事を前へ。</p>
    </div>
  );
}

// Google から戻ってきたときの ?error=...（Better Auth のエラーコード）
const AUTH_ERRORS: Record<string, string> = {
  access_denied: "Google でのログインがキャンセルされました。",
  state_mismatch: "ログインの途中で時間が経ったか、別のタブで操作されました。もう一度お試しください。",
  state_not_found: "ログインの途中で時間が経ったか、別のタブで操作されました。もう一度お試しください。",
  please_restart_the_process: "ログインの途中で時間が経ったか、別のタブで操作されました。もう一度お試しください。",
  account_not_linked: "このメールアドレスのアカウントに Google アカウントを結び付けられませんでした。",
  unable_to_link_account: "このメールアドレスのアカウントに Google アカウントを結び付けられませんでした。",
  email_not_found: "Google アカウントのメールアドレスを取得できませんでした。",
};

function authErrorMessage(code: string | null): string | null {
  if (!code) return null;
  // URL に書かれた任意の文を表示しないよう、エラーコードの形をしたものだけを添える
  const detail = /^[a-z0-9_]{1,40}$/.test(code) ? `（${code}）` : "";
  return AUTH_ERRORS[code] ?? `Google でログインできませんでした${detail}。もう一度お試しください。`;
}

// 招待ページから Google へ移る直前に、このタブへ残す印（値は招待トークン）。
// 戻ってきたとき（?join=1）に印が一致した場合だけ自動で参加し、URL を開かせるだけでは参加させられないようにする
const INVITE_JOIN_MARK = "sen:invite-join";

function readJoinMark(): string | null {
  try {
    return sessionStorage.getItem(INVITE_JOIN_MARK);
  } catch {
    return null;
  }
}

function writeJoinMark(token: string | null) {
  try {
    if (token) sessionStorage.setItem(INVITE_JOIN_MARK, token);
    else sessionStorage.removeItem(INVITE_JOIN_MARK);
  } catch {
    // 保存できなければ、戻ってきたあとに「参加する」を押してもらう
  }
}

function roleLabel(role: Role): string {
  return role === "admin" ? "管理者" : "メンバー";
}

/** 残り時間を日で切り上げる。過ぎていても 1 日とする */
function daysLeft(expiresAt: number, now = Date.now()): number {
  return Math.max(1, Math.ceil((expiresAt - now) / DAY_MS));
}

function inviteLead(invite: InvitePreview): string {
  return invite.invitedByName ? `${invite.invitedByName} さんから招待されました` : "招待されました";
}

function pendingMeta(inv: PendingInvitation, now = Date.now()): string {
  const rest = `${roleLabel(inv.role)} ・ あと ${daysLeft(inv.expiresAt, now)} 日`;
  return inv.invitedByName ? `${inv.invitedByName} さんから ・ ${rest}` : rest;
}

/** アプリ内のパスだけを戻り先にする（外部サイトへのリダイレクトを防ぐ） */
function safePath(path: string | null): string | null {
  return path && path.startsWith("/") && !path.startsWith("//") && !path.startsWith("/\\") ? path : null;
}

function GoogleSignInButton({
  label = "Google でログイン",
  variant = "secondary",
  callbackURL,
  errorCallbackURL,
  error: initialError,
  disabled,
  beforeSignIn,
}: {
  label?: string;
  /** primary は白い丸の上に Google のアイコン。link は文字だけのリンク */
  variant?: "primary" | "secondary" | "link";
  callbackURL: string;
  errorCallbackURL: string;
  error?: string | null;
  disabled?: boolean;
  /** Google へ移る前にすること（別のアカウントを追加するとき、今のアカウントを記録に加えるなど） */
  beforeSignIn?: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(initialError ?? null);
  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      await beforeSignIn?.();
      await signInWithGoogle({ callbackURL, errorCallbackURL });
      // そのまま Google のページへ移るので、ボタンは押せないままにしておく
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };
  const icon = busy ? (
    <Spinner size={14} />
  ) : variant === "link" ? undefined : variant === "primary" ? (
    <span className="google-icon-badge">
      <GoogleIcon size={13} />
    </span>
  ) : (
    <GoogleIcon />
  );
  return (
    <>
      <Button
        variant={variant === "link" ? "ghost" : variant}
        className={variant === "link" ? "auth-link-btn" : undefined}
        onClick={start}
        disabled={busy || disabled}
        icon={icon}
        data-testid="google-sign-in"
      >
        {label}
      </Button>
      {error && (
        <div className="form-error" data-testid="auth-error">
          {error}
        </div>
      )}
    </>
  );
}

function InviteDetails({ invite, showEmail }: { invite: InvitePreview; showEmail: boolean }) {
  return (
    <dl className="invite-details" data-testid="invite-details">
      {showEmail && (
        <div>
          <dt>招待されたアドレス</dt>
          <dd>{invite.maskedEmail}</dd>
        </div>
      )}
      <div>
        <dt>権限</dt>
        <dd>{roleLabel(invite.role)}</dd>
      </div>
      <div>
        <dt>有効期限</dt>
        <dd>{formatDateTime(invite.expiresAt)} まで</dd>
      </div>
    </dl>
  );
}

export function LoginPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const next = safePath(params.get("next"));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ブラウザ内デモには Google が戻ってくる先のサーバーが無いので、デモ用のアカウントでログインする
  const demoSignIn = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await devSignIn("taro@example.com", "山田 太郎");
      const key = res ? pickWorkspaceKey(res.workspaces, res.defaultWorkspaceId ?? null) : null;
      navigate(next ?? (key ? `/${key}/my-issues` : "/new-workspace"), { replace: true });
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  if (isDemo) {
    return (
      <AuthLayout title="Sen にログイン" subtitle="デモ版では、Google の代わりにデモ用のアカウントでログインします。">
        <div className="auth-form" data-testid="login-form">
          <Button variant="primary" onClick={demoSignIn} disabled={busy} data-testid="demo-sign-in">
            {busy ? <Spinner size={14} /> : "デモ用のアカウントでログイン"}
          </Button>
          {error && <div className="form-error">{error}</div>}
        </div>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout title="Sen にログイン" subtitle="Google アカウントでログインします。初めての方は、そのままアカウントが作られます。">
      <div className="auth-form" data-testid="login-form">
        <GoogleSignInButton
          callbackURL={next ?? "/"}
          errorCallbackURL={next ? `/login?next=${encodeURIComponent(next)}` : "/login"}
          error={authErrorMessage(params.get("error"))}
        />
      </div>
    </AuthLayout>
  );
}

/** 招待リンク（/invite/:token）から参加する */
export function InvitePage() {
  const navigate = useNavigate();
  const { token = "" } = useParams();
  const [params] = useSearchParams();
  const [invite, setInvite] = useState<InvitePreview | null>(null);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const session = useSession();

  useEffect(() => {
    api<InvitePreview>(`/api/invite/${token}`)
      .then(setInvite)
      .catch((e) => setInviteError((e as Error).message));
  }, [token]);

  const join = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ workspaceKey: string }>(`/api/invite/${token}/accept`, { body: {} });
      await loadSession();
      navigate(`/${res.workspaceKey}/my-issues`, { replace: true });
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }, [token, navigate]);

  // 「Google でログインして参加」から戻ってきたときだけ、そのまま参加する。
  // 別のアカウントで戻ってきたときは参加せず、案内だけ出す
  const autoJoin = params.get("join") === "1" && readJoinMark() === token;
  const authed = session.status === "authed";
  const wrongAccount = authed && invite?.forCurrentUser === false;
  const autoJoined = useRef(false);
  useEffect(() => {
    if (!autoJoin || !authed || !invite || autoJoined.current) return;
    if (invite.forCurrentUser === false) {
      writeJoinMark(null);
      return;
    }
    autoJoined.current = true;
    writeJoinMark(null);
    join();
  }, [autoJoin, authed, invite, join]);

  if (inviteError) {
    const loggedIn = session.status === "authed";
    return (
      <AuthLayout
        icon={
          <span className="invite-dead-icon" aria-hidden>
            <Link2Off size={22} />
          </span>
        }
        title="この招待リンクは使えません"
        subtitle="期限が切れたか、取り消されたか、すでに使われています。招待した人に、もう一度招待してもらってください。"
      >
        {session.status !== "unknown" && (
          <div className="auth-form">
            <Link to={loggedIn ? "/" : "/login"} className="btn btn-secondary btn-md auth-wide-btn">
              {loggedIn ? "Sen を開く" : "ログイン画面へ"}
            </Link>
          </div>
        )}
      </AuthLayout>
    );
  }

  const googleLabel = !authed ? "Google でログインして参加" : wrongAccount ? "招待されたアカウントでログインし直す" : "別の Google アカウントで参加";

  return (
    <AuthLayout title={invite ? `${invite.workspaceName} に参加` : "招待を確認中…"} subtitle={invite ? inviteLead(invite) : undefined}>
      {invite && session.status !== "unknown" && (
        <div className="auth-form invite-form">
          {wrongAccount && (
            <div className="invite-wrong-account" data-testid="invite-wrong-account">
              <AlertTriangle size={16} aria-hidden />
              <span className="invite-wrong-account-text">
                <b>この招待は {invite.maskedEmail} あてです</b>
                <span>今は {session.user?.email} でログインしています。このアカウントでは参加できません。</span>
              </span>
            </div>
          )}
          <InviteDetails invite={invite} showEmail={!wrongAccount} />
          {authed && !wrongAccount && session.user && (
            <>
              <div className="invite-account" data-testid="invite-account">
                <Avatar user={session.user} size={32} />
                <span className="invite-account-body">
                  <b>{session.user.name}</b>
                  <span>{session.user.email}</span>
                </span>
                <span className="invite-account-status">
                  <Check size={12} strokeWidth={2.6} />
                  ログイン中
                </span>
              </div>
              <Button variant="primary" onClick={join} disabled={busy} data-testid="invite-accept" icon={busy ? <Spinner size={14} /> : undefined}>
                このアカウントで参加する
              </Button>
            </>
          )}
          {error && <div className="form-error">{error}</div>}
          {/* ログイン中かどうかでボタンが作り直されないよう、同じ位置に置く */}
          <GoogleSignInButton
            variant={authed && !wrongAccount ? "link" : "primary"}
            label={googleLabel}
            callbackURL={`/invite/${token}?join=1`}
            errorCallbackURL={`/invite/${token}`}
            error={authed ? null : authErrorMessage(params.get("error"))}
            disabled={busy}
            beforeSignIn={async () => {
              writeJoinMark(token);
              if (authed && !(await refreshAccounts())) throw new Error("今のアカウントを記録できませんでした。通信できる状態で、もう一度お試しください");
            }}
          />
          {session.status === "anon" && <p className="invite-hint">{invite.maskedEmail} の Google アカウントでログインしてください。</p>}
        </div>
      )}
    </AuthLayout>
  );
}

export function NewWorkspacePage() {
  const navigate = useNavigate();
  const session = useSession();
  const invitations = session.invitations ?? [];
  // 初めてログインした人（まだどのワークスペースにも入っていない）
  const firstTime = session.workspaces.length === 0;
  const [name, setName] = useState(firstTime && session.user ? `${session.user.name}のワークスペース` : "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [acceptingId, setAcceptingId] = useState<string | null>(null);
  const [acceptErrors, setAcceptErrors] = useState<Record<string, string>>({});
  const hasInvitations = invitations.length > 0;
  const [creating, setCreating] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const showCreateForm = !hasInvitations || creating;
  useEffect(() => {
    if (creating) nameRef.current?.focus();
  }, [creating]);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await api<{ workspaceKey: string }>("/api/workspaces", { body: { name } });
      await loadSession();
      navigate(`/${res.workspaceKey}/my-issues`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const accept = async (id: string) => {
    if (acceptingId) return;
    setAcceptingId(id);
    setAcceptErrors((cur) => {
      const next = { ...cur };
      delete next[id];
      return next;
    });
    try {
      const key = await acceptPendingInvitation(id);
      navigate(`/${key}/my-issues`);
    } catch (err) {
      setAcceptErrors((cur) => ({ ...cur, [id]: (err as Error).message }));
      setAcceptingId(null);
    }
  };
  return (
    <AuthLayout
      title={hasInvitations ? "招待が届いています" : firstTime ? "ワークスペースを作成" : "新しいワークスペース"}
      subtitle={
        hasInvitations
          ? "参加するワークスペースを選んでください。"
          : firstTime
            ? "ワークスペースと、使い方を学べるサンプル課題が用意されます。チームに参加する場合は、招待メールのリンクを開いてください。"
            : "チームや組織ごとにワークスペースを分けられます。課題の入っていないワークスペースが作られます。"
      }
    >
      {hasInvitations && (
        <div className="pending-invitations">
          {invitations.map((inv) => (
            <div key={inv.id} className="pending-invitation" data-testid="pending-invitation">
              <span className="pending-invitation-mark" aria-hidden>
                {Array.from(inv.workspaceName)[0] ?? ""}
              </span>
              <span className="pending-invitation-main">
                <b>{inv.workspaceName}</b>
                <span>{pendingMeta(inv)}</span>
              </span>
              <Button
                type="button"
                variant="primary"
                size="sm"
                data-testid="pending-invitation-accept"
                disabled={acceptingId !== null}
                icon={acceptingId === inv.id ? <Spinner size={14} /> : undefined}
                onClick={() => void accept(inv.id)}
              >
                参加する
              </Button>
              {acceptErrors[inv.id] && <div className="form-error">{acceptErrors[inv.id]}</div>}
            </div>
          ))}
        </div>
      )}
      {hasInvitations && <div className="auth-or">または</div>}
      {showCreateForm ? (
        <form onSubmit={submit} className="auth-form" data-testid="new-workspace-form">
          <label>
            ワークスペース名
            <input
              ref={nameRef}
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              autoFocus
              maxLength={60}
              placeholder="例：ミライ株式会社"
              data-testid="new-workspace-name"
            />
          </label>
          {error && <div className="form-error">{error}</div>}
          <Button variant="primary" type="submit" disabled={busy || !name.trim()} data-testid="new-workspace-submit">
            {firstTime ? "はじめる" : "作成する"}
          </Button>
        </form>
      ) : (
        <Button type="button" variant="secondary" className="auth-wide-btn" data-testid="new-workspace-toggle" onClick={() => setCreating(true)}>
          新しいワークスペースを作る
        </Button>
      )}
      {firstTime ? (
        <p className="auth-switch">
          {session.user?.email} でログイン中 ・{" "}
          <a
            href="/login"
            onClick={(e) => {
              e.preventDefault();
              logout();
            }}
          >
            別のアカウントでログイン
          </a>
        </p>
      ) : (
        lastWorkspaceKey() && (
          <p className="auth-switch">
            <Link to={`/${lastWorkspaceKey()}/my-issues`}>← 戻る</Link>
          </p>
        )
      )}
    </AuthLayout>
  );
}
