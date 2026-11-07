import { useEffect, useRef, useState } from "react";
import { Navigate, useLocation, useSearchParams } from "react-router";
import type { ApiTokenScope, OAuthApproveRequest, OAuthConsentInfo, OAuthRedirectResponse } from "../../../shared/types";
import { lastWorkspaceKey, useSession } from "../../app/session";
import { Logo } from "../../components/icons";
import { Button, Spinner } from "../../components/ui";
import { api } from "../../lib/api";
import { cx } from "../../lib/utils";
import { AuthLayout } from "./AuthPages";

const missingRequest = "接続のリクエストが見つかりません。AI ツールからもう一度接続してください。";

function ConsentError({ message }: { message: string }) {
  return (
    <AuthLayout title="接続できませんでした">
      <p data-testid="oauth-error">{message}</p>
    </AuthLayout>
  );
}

export function OAuthConsentPage() {
  // 埋め込みでは、認証への移動も API の呼び出しも行わない。
  if (window.top !== window.self) return <p>この画面は、ほかのサイトの中では開けません。</p>;
  return <ConsentPage />;
}

function ConsentPage() {
  const [params] = useSearchParams();
  const location = useLocation();
  const session = useSession();
  const request = params.get("request");
  const hasError = params.has("error");
  const code = params.get("error");
  const queryError = hasError || !request
    ? code === "invalid_client"
      ? "AI ツールを確認できませんでした。AI ツールからもう一度接続してください。"
      : code === "invalid_redirect"
        ? "接続の戻り先が、AI ツールの登録と一致しません。AI ツールからもう一度接続してください。"
        : missingRequest
    : null;
  const [info, setInfo] = useState<OAuthConsentInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [workspaceId, setWorkspaceId] = useState("");
  const [scope, setScope] = useState<ApiTokenScope>("write");
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [done, setDone] = useState<"returning" | "done" | null>(null);
  const submitting = useRef(false);

  useEffect(() => {
    if (queryError || session.status !== "authed") return;
    const controller = new AbortController();
    setInfo(null);
    setLoadError(null);
    setFormError(null);
    setDone(null);
    setBusy(false);
    submitting.current = false;
    api<OAuthConsentInfo>(`/api/oauth/requests/${encodeURIComponent(request!)}`, { signal: controller.signal })
      .then((res) => {
        if (controller.signal.aborted) return;
        setInfo(res);
        setScope(res.scope);
        setWorkspaceId(
          res.workspaces.find((w) => w.id === res.defaultWorkspaceId)?.id
          ?? res.workspaces.find((w) => w.urlKey === lastWorkspaceKey())?.id
          ?? res.workspaces[0]?.id
          ?? "",
        );
      })
      .catch((err: Error) => {
        if (!controller.signal.aborted) setLoadError(err.message);
      });
    return () => controller.abort();
  }, [request, queryError, session.status, session.user?.id]);

  useEffect(() => {
    if (done !== "returning") return;
    const timer = window.setTimeout(() => setDone("done"), 2000);
    return () => window.clearTimeout(timer);
  }, [done]);

  const submit = async (approve: boolean) => {
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setFormError(null);
    try {
      const body: OAuthApproveRequest = { workspaceId, scope };
      const res = await api<OAuthRedirectResponse>(
        `/api/oauth/requests/${encodeURIComponent(request!)}/${approve ? "approve" : "deny"}`,
        { method: "POST", ...(approve ? { body } : {}) },
      );
      window.location.assign(res.redirectTo);
      setDone("returning");
    } catch (err) {
      setFormError((err as Error).message);
      setBusy(false);
      submitting.current = false;
    }
  };

  if (hasError) return <ConsentError message={queryError!} />;
  if (session.status === "unknown") {
    return (
      <div className="fullscreen-center">
        <Logo size={32} />
        <Spinner size={18} />
      </div>
    );
  }
  if (session.status === "anon") {
    return <Navigate to={`/login?next=${encodeURIComponent(location.pathname + location.search)}`} replace />;
  }
  if (queryError || loadError) return <ConsentError message={(queryError ?? loadError)!} />;
  if (!info) {
    return (
      <AuthLayout title="接続を確認中…">
        <Spinner />
      </AuthLayout>
    );
  }
  if (done) {
    return (
      <AuthLayout title="AI ツールへの接続">
        <p data-testid="oauth-done">
          {done === "returning"
            ? "AI ツールに戻っています…"
            : "AI ツールに戻りました。このタブは閉じてかまいません。"}
        </p>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout title={`「${info.clientName}」が Sen への接続を求めています`}>
      <div className="auth-form oauth-consent" data-testid="oauth-consent">
        {info.workspaces.length === 0 ? (
          <p>接続できるワークスペースがありません。ワークスペースを作るか、招待を受けてから、AI ツールで接続し直してください。</p>
        ) : (
          <>
            <dl className="invite-details">
              <div>
                <dt>AI ツール</dt>
                <dd>
                  {info.clientName}
                  {info.verifiedHost && <small className="muted">（{info.verifiedHost} が公開）</small>}
                </dd>
              </div>
              <div>
                <dt>戻り先</dt>
                <dd data-testid="oauth-destination">{info.destination}</dd>
              </div>
              <div>
                <dt>アカウント</dt>
                <dd>{session.user?.name}<br />{session.user?.email}</dd>
              </div>
              <div>
                <dt>ワークスペース</dt>
                <dd>
                  {info.workspaces.length > 1 ? (
                    <select
                      data-testid="oauth-workspace"
                      aria-label="ワークスペース"
                      value={workspaceId}
                      disabled={busy}
                      onChange={(e) => setWorkspaceId(e.target.value)}
                    >
                      {info.workspaces.map((w) => (
                        <option key={w.id} value={w.id}>{w.name}</option>
                      ))}
                    </select>
                  ) : info.workspaces[0].name}
                </dd>
              </div>
            </dl>
            <div className="ai-scope">
              <b>できること</b>
              <div className="segmented wide">
                <button
                  type="button"
                  data-testid="oauth-scope-write"
                  aria-pressed={scope === "write"}
                  className={cx(scope === "write" && "on")}
                  disabled={busy}
                  onClick={() => setScope("write")}
                >
                  課題の作成と変更
                </button>
                <button
                  type="button"
                  data-testid="oauth-scope-read"
                  aria-pressed={scope === "read"}
                  className={cx(scope === "read" && "on")}
                  disabled={busy}
                  onClick={() => setScope("read")}
                >
                  閲覧のみ
                </button>
              </div>
              <p className="muted small">
                {scope === "write"
                  ? "課題の作成・更新・コメントができます。課題の削除はできません。"
                  : "課題を読むだけで、変更はしません。"}
              </p>
            </div>
            <div className="oauth-notice muted small">
              <p>
                AI は、あなたの権限で Sen を操作します。行った変更には「{info.clientName} 経由」の印が付きます。接続は、設定の「AI 連携」からいつでも解除できます。
              </p>
              <p>心当たりのない接続は、許可しないでください。</p>
            </div>
            <Button variant="primary" data-testid="oauth-approve" disabled={busy} onClick={() => void submit(true)}>
              許可する
            </Button>
          </>
        )}
        <Button data-testid="oauth-deny" disabled={busy} onClick={() => void submit(false)}>
          キャンセル
        </Button>
        {formError && <div className="form-error">{formError}</div>}
      </div>
    </AuthLayout>
  );
}
