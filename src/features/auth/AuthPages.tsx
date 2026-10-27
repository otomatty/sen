import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { api } from "../../lib/api";
import { Button, Spinner } from "../../components/ui";
import { Logo } from "../../components/icons";
import { lastWorkspaceKey, loadSession, login, signup, useSession } from "../../app/session";

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

export function LoginPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const isDemo = typeof __SEN_DEMO__ !== "undefined" && __SEN_DEMO__;
  const [email, setEmail] = useState(isDemo ? "taro@example.com" : "");
  const [password, setPassword] = useState(isDemo ? "password123" : "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const key = await login(email, password);
      const next = params.get("next");
      navigate(next && next.startsWith("/") ? next : key ? `/${key}/my-issues` : "/new-workspace", { replace: true });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <AuthLayout title="Sen にログイン" subtitle={isDemo ? "デモ用のアカウントが入力されています。そのままログインできます。" : undefined}>
      <form onSubmit={submit} className="auth-form" data-testid="login-form">
        <label>
          メールアドレス
          <input type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus data-testid="login-email" />
        </label>
        <label>
          パスワード
          <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required data-testid="login-password" />
        </label>
        {error && <div className="form-error">{error}</div>}
        <Button variant="primary" type="submit" disabled={busy} data-testid="login-submit">
          {busy ? <Spinner size={14} /> : "ログイン"}
        </Button>
      </form>
      <p className="auth-switch">
        アカウントをお持ちでない方は <Link to="/signup">新規登録</Link>
      </p>
    </AuthLayout>
  );
}

export function SignupPage() {
  const navigate = useNavigate();
  const { code } = useParams();
  const [invite, setInvite] = useState<{ name: string; memberCount: number } | null>(null);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [workspaceName, setWorkspaceName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const session = useSession();

  useEffect(() => {
    if (!code) return;
    api<{ name: string; memberCount: number }>(`/api/invite/${code}`)
      .then(setInvite)
      .catch((e) => setInviteError((e as Error).message));
  }, [code]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const key = await signup({ name, email, password, workspaceName: code ? undefined : workspaceName, inviteCode: code });
      navigate(`/${key}/my-issues`, { replace: true });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const acceptAsCurrent = async () => {
    setBusy(true);
    try {
      const res = await api<{ workspaceKey: string }>(`/api/invite/${code}/accept`, { body: {} });
      await loadSession();
      navigate(`/${res.workspaceKey}/my-issues`, { replace: true });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (code && inviteError) {
    return (
      <AuthLayout title="招待リンクが無効です" subtitle="リンクが古いか、作り直された可能性があります。招待した人に確認してください。">
        <Link to="/login">ログイン画面へ</Link>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title={code ? (invite ? `${invite.name} に参加` : "招待を確認中…") : "アカウントを作成"}
      subtitle={code ? (invite ? `${invite.memberCount}人のメンバーがいます` : undefined) : "ワークスペースと、使い方を学べるサンプル課題が用意されます。"}
    >
      {code && session.status === "authed" && (
        <div className="auth-form">
          <p className="muted small">{session.user?.name} としてログイン中です。</p>
          <Button variant="primary" onClick={acceptAsCurrent} disabled={busy}>
            このアカウントで参加する
          </Button>
          <div className="auth-divider">または新しいアカウントで参加</div>
        </div>
      )}
      <form onSubmit={submit} className="auth-form" data-testid="signup-form">
        <label>
          名前
          <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={40} placeholder="山田 太郎" autoFocus data-testid="signup-name" />
        </label>
        <label>
          メールアドレス
          <input type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required data-testid="signup-email" />
        </label>
        <label>
          パスワード
          <input
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={8}
            placeholder="8文字以上"
            data-testid="signup-password"
          />
        </label>
        {!code && (
          <label>
            ワークスペース名
            <input value={workspaceName} onChange={(e) => setWorkspaceName(e.target.value)} placeholder="例：ミライ株式会社" maxLength={60} data-testid="signup-workspace" />
          </label>
        )}
        {error && <div className="form-error">{error}</div>}
        <Button variant="primary" type="submit" disabled={busy || (!!code && !invite)} data-testid="signup-submit">
          {busy ? <Spinner size={14} /> : code ? "参加する" : "はじめる"}
        </Button>
      </form>
      <p className="auth-switch">
        すでにアカウントをお持ちの方は <Link to="/login">ログイン</Link>
      </p>
    </AuthLayout>
  );
}

export function NewWorkspacePage() {
  const navigate = useNavigate();
  const [name, setName] = useState("");
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
    <AuthLayout title="新しいワークスペース" subtitle="チームや組織ごとにワークスペースを分けられます。">
      <form onSubmit={submit} className="auth-form">
        <label>
          ワークスペース名
          <input value={name} onChange={(e) => setName(e.target.value)} required autoFocus maxLength={60} placeholder="例：ミライ株式会社" />
        </label>
        {error && <div className="form-error">{error}</div>}
        <Button variant="primary" type="submit" disabled={busy || !name.trim()}>
          作成する
        </Button>
      </form>
      {lastWorkspaceKey() && (
        <p className="auth-switch">
          <Link to={`/${lastWorkspaceKey()}/my-issues`}>← 戻る</Link>
        </p>
      )}
    </AuthLayout>
  );
}
