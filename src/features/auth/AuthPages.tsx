import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { api } from "../../lib/api";
import { Button, Spinner } from "../../components/ui";
import { GoogleIcon, Logo } from "../../components/icons";
import { devSignIn, lastWorkspaceKey, loadSession, logout, signInWithGoogle, signOut, useSession } from "../../app/session";

const isDemo = typeof __SEN_DEMO__ !== "undefined" && __SEN_DEMO__;

function AuthLayout({ title, subtitle, children }: { title: string; subtitle?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="auth-page">
      <div className="auth-glow" />
      <div className="auth-card">
        <Logo size={36} />
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

// 招待ページから Google へ移る直前に、このタブへ残す印（値は招待コード）。
// 戻ってきたとき（?join=1）に印が一致した場合だけ自動で参加し、URL を開かせるだけでは参加させられないようにする
const INVITE_JOIN_MARK = "sen:invite-join";

function readJoinMark(): string | null {
  try {
    return sessionStorage.getItem(INVITE_JOIN_MARK);
  } catch {
    return null;
  }
}

function writeJoinMark(code: string | null) {
  try {
    if (code) sessionStorage.setItem(INVITE_JOIN_MARK, code);
    else sessionStorage.removeItem(INVITE_JOIN_MARK);
  } catch {
    // 保存できなければ、戻ってきたあとに「参加する」を押してもらう
  }
}

/** アプリ内のパスだけを戻り先にする（外部サイトへのリダイレクトを防ぐ） */
function safePath(path: string | null): string | null {
  return path && path.startsWith("/") && !path.startsWith("//") && !path.startsWith("/\\") ? path : null;
}

function GoogleSignInButton({
  label = "Google でログイン",
  callbackURL,
  errorCallbackURL,
  error: initialError,
  disabled,
  beforeSignIn,
}: {
  label?: string;
  callbackURL: string;
  errorCallbackURL: string;
  error?: string | null;
  disabled?: boolean;
  /** Google へ移る前にすること（別のアカウントに切り替えるときのログアウトなど） */
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
  return (
    <>
      <Button variant="secondary" onClick={start} disabled={busy || disabled} icon={busy ? <Spinner size={14} /> : <GoogleIcon />} data-testid="google-sign-in">
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
      const key = res?.workspaces[0]?.urlKey;
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

/** 招待リンク（/invite/:code）から参加する */
export function InvitePage() {
  const navigate = useNavigate();
  const { code = "" } = useParams();
  const [params] = useSearchParams();
  const [invite, setInvite] = useState<{ name: string; memberCount: number } | null>(null);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const session = useSession();

  useEffect(() => {
    api<{ name: string; memberCount: number }>(`/api/invite/${code}`)
      .then(setInvite)
      .catch((e) => setInviteError((e as Error).message));
  }, [code]);

  const join = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ workspaceKey: string }>(`/api/invite/${code}/accept`, { body: {} });
      await loadSession();
      navigate(`/${res.workspaceKey}/my-issues`, { replace: true });
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }, [code, navigate]);

  // 「Google でログインして参加」から戻ってきたときだけ、そのまま参加する
  const autoJoin = params.get("join") === "1" && readJoinMark() === code;
  const authed = session.status === "authed";
  const autoJoined = useRef(false);
  useEffect(() => {
    if (!autoJoin || !authed || !invite || autoJoined.current) return;
    autoJoined.current = true;
    writeJoinMark(null);
    join();
  }, [autoJoin, authed, invite, join]);

  if (inviteError) {
    return (
      <AuthLayout title="招待リンクが無効です" subtitle="リンクが古いか、作り直された可能性があります。招待した人に確認してください。">
        <Link to="/login">ログイン画面へ</Link>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout title={invite ? `${invite.name} に参加` : "招待を確認中…"} subtitle={invite ? `${invite.memberCount}人のメンバーがいます` : undefined}>
      <div className="auth-form">
        {authed && (
          <>
            <p className="muted small">
              {session.user?.name}（{session.user?.email}）としてログイン中です。
            </p>
            <Button variant="primary" onClick={join} disabled={busy || !invite} data-testid="invite-accept">
              {busy ? <Spinner size={14} /> : "このアカウントで参加する"}
            </Button>
            {error && <div className="form-error">{error}</div>}
            <div className="auth-divider">または</div>
          </>
        )}
        {/* ログアウトしてから Google へ移るときも、ボタンが作り直されないよう同じ位置に置く */}
        {session.status !== "unknown" && (
          <GoogleSignInButton
            label={authed ? "別の Google アカウントで参加" : "Google でログインして参加"}
            callbackURL={`/invite/${code}?join=1`}
            errorCallbackURL={`/invite/${code}`}
            error={authed ? null : authErrorMessage(params.get("error"))}
            disabled={busy || !invite}
            beforeSignIn={async () => {
              writeJoinMark(code);
              if (authed) await signOut();
            }}
          />
        )}
      </div>
    </AuthLayout>
  );
}

export function NewWorkspacePage() {
  const navigate = useNavigate();
  const session = useSession();
  // 初めてログインした人（まだどのワークスペースにも入っていない）
  const firstTime = session.workspaces.length === 0;
  const [name, setName] = useState(firstTime && session.user ? `${session.user.name}のワークスペース` : "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
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
  return (
    <AuthLayout
      title={firstTime ? "ワークスペースを作成" : "新しいワークスペース"}
      subtitle={
        firstTime
          ? "ワークスペースと、使い方を学べるサンプル課題が用意されます。チームに参加する場合は、招待リンクを開いてください。"
          : "チームや組織ごとにワークスペースを分けられます。"
      }
    >
      <form onSubmit={submit} className="auth-form" data-testid="new-workspace-form">
        <label>
          ワークスペース名
          <input
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
