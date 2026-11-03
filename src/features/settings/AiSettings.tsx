import { useEffect, useRef, useState } from "react";
import { Check, CheckCircle2, Copy, KeyRound, Trash2 } from "lucide-react";
import { API_TOKEN_CLIENTS, apiTokenClientLabel } from "../../../shared/constants";
import type { ApiTokenClient, ApiTokenCreateRequest, ApiTokenCreateResponse, ApiTokenListResponse, ApiTokenScope, ApiTokenSummary } from "../../../shared/types";
import { useData } from "../../store/data";
import { useTeams } from "../../store/selectors";
import { toast } from "../../store/ui";
import { copyText, cx, formatDate, timeAgo } from "../../lib/utils";
import { api } from "../../lib/api";
import { confirmDialog } from "../../components/ConfirmDialog";
import { Button, Spinner } from "../../components/ui";
import { Field, Section } from "./parts";

type ExpiryChoice = "30" | "90" | "365" | "none";

function expiresInDays(v: ExpiryChoice): 30 | 90 | 365 | null {
  if (v === "30") return 30;
  if (v === "90") return 90;
  if (v === "365") return 365;
  return null;
}

interface Issued {
  secret: string;
  mcpUrl: string;
  client: ApiTokenClient;
  scope: ApiTokenScope;
}

const INITIAL = {
  client: "claude-code" as ApiTokenClient,
  scope: "write" as ApiTokenScope,
  expiry: "90" as ExpiryChoice,
  name: "",
};

function CodeBlock({ value, label, onCopied }: { value: string; label?: string; onCopied: () => void }) {
  const [done, setDone] = useState(false);
  const timer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (timer.current) window.clearTimeout(timer.current);
    },
    [],
  );
  return (
    <div className={cx("code-block", !label && "code-block-plain")}>
      <div className="code-block-bar">
        {label && <span className="code-block-label">{label}</span>}
        <button
          type="button"
          className="code-block-copy"
          data-testid="ai-copy"
          onClick={() => {
            void copyText(value).then(() => {
              setDone(true);
              onCopied();
              if (timer.current) window.clearTimeout(timer.current);
              timer.current = window.setTimeout(() => setDone(false), 2000);
            });
          }}
        >
          {done ? <Check size={12} /> : <Copy size={12} />}
          {done ? "コピーしました" : "コピー"}
        </button>
      </div>
      <pre>
        <code>{value}</code>
      </pre>
    </div>
  );
}

function examplePrompts(teamKey: string | undefined, scope: ApiTokenScope): string[] {
  const team = teamKey ? `${teamKey} チーム` : "";
  const assigned = "Sen で、自分に割り当てられた課題を一覧にして";
  const second =
    scope === "read"
      ? team
        ? `Sen の ${team}で、今週やるべき課題をまとめて`
        : "Sen で、今週やるべき課題をまとめて"
      : team
        ? `この機能に必要な作業を、Sen の ${team}に課題として登録して`
        : "この機能に必要な作業を、Sen に課題として登録して";
  const third = team ? `Sen の ${team}のバックログを見直して、優先度を提案して` : "Sen のバックログを見直して、優先度を提案して";
  return [assigned, second, third];
}

function ClientSetup({ issued, onCopied }: { issued: Issued; onCopied: () => void }) {
  const { client, mcpUrl, secret } = issued;
  if (client === "claude-code") {
    const command = `claude mcp add --scope user --transport http sen ${mcpUrl} --header "Authorization: Bearer ${secret}"`;
    return (
      <>
        <p>ターミナルで次のコマンドを実行します。</p>
        <CodeBlock value={command} onCopied={onCopied} />
        <p className="muted small">すべてのプロジェクトで使えるよう、ユーザー設定に追加します。</p>
      </>
    );
  }
  if (client === "cursor") {
    const href = `cursor://anysphere.cursor-deeplink/mcp/install?name=sen&config=${encodeURIComponent(btoa(JSON.stringify({ url: mcpUrl, headers: { Authorization: "Bearer " + secret } })))}`;
    const json = JSON.stringify({ mcpServers: { sen: { url: mcpUrl, headers: { Authorization: `Bearer ${secret}` } } } }, null, 2);
    return (
      <>
        <p>
          <a className="btn btn-primary btn-md" data-testid="ai-cursor-install" href={href}>
            Cursor に追加
          </a>
        </p>
        <p>
          うまく開かないときは、<code className="inline-code">~/.cursor/mcp.json</code> に次の内容を追加します。
        </p>
        <CodeBlock value={json} onCopied={onCopied} />
      </>
    );
  }
  if (client === "vscode") {
    const json = JSON.stringify({ servers: { sen: { type: "http", url: mcpUrl, headers: { Authorization: `Bearer ${secret}` } } } }, null, 2);
    return (
      <>
        <p>
          コマンドパレットで<code className="inline-code">MCP: Open User Configuration</code>を開き、次の内容を追加します。
        </p>
        <CodeBlock value={json} onCopied={onCopied} />
      </>
    );
  }
  return (
    <>
      <p>Streamable HTTP に対応した MCP クライアントに、次の 2 つを設定します。</p>
      <CodeBlock label="URL" value={mcpUrl} onCopied={onCopied} />
      <CodeBlock label="ヘッダー" value={`Authorization: Bearer ${secret}`} onCopied={onCopied} />
    </>
  );
}

function IssuedPanel({ issued, onCopied, onDone }: { issued: Issued; onCopied: () => void; onDone: () => void }) {
  const teamKey = useTeams()[0]?.key;
  const prompts = examplePrompts(teamKey, issued.scope);
  return (
    <div className="ai-issued" data-testid="ai-issued">
      <div className="ai-callout">
        <CheckCircle2 size={18} />
        <div>
          <b>トークンを発行しました</b>
          <p>このトークンは今だけ表示されます。設定が終わるまで、この画面を閉じないでください。</p>
        </div>
      </div>
      <h3 className="ai-step-title">1. AI ツールに Sen を追加する</h3>
      <ClientSetup issued={issued} onCopied={onCopied} />
      <h3 className="ai-step-title">2. AI に頼んでみる</h3>
      <p>AI ツールを再起動してから、たとえば次のように話しかけます。</p>
      <div className="ai-prompts">
        {prompts.map((text) => (
          <button
            key={text}
            type="button"
            className="ai-prompt"
            onClick={() => {
              void copyText(text).then(() => toast("コピーしました"));
            }}
          >
            <span>{text}</span>
            <Copy size={13} />
          </button>
        ))}
      </div>
      <div>
        <Button data-testid="ai-issued-done" onClick={onDone}>
          完了
        </Button>
      </div>
    </div>
  );
}

function TokenMeta({ token }: { token: ApiTokenSummary }) {
  const expired = token.expiresAt != null && token.expiresAt <= Date.now();
  const used = token.lastUsedAt ? `最後に使用：${timeAgo(token.lastUsedAt)}` : "まだ使われていません";
  const expiry = token.expiresAt == null ? "無期限" : expired ? null : `${formatDate(token.expiresAt, true)}まで`;
  return (
    <span className="muted small ai-token-meta">
      sen_…{token.hint}・{used}・{expired ? <span className="text-danger">期限切れ</span> : expiry}
    </span>
  );
}

export function AiSettings() {
  const wsKey = useData((s) => s.workspace?.urlKey ?? "");
  const [tokens, setTokens] = useState<ApiTokenSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [client, setClient] = useState<ApiTokenClient>(INITIAL.client);
  const [scope, setScope] = useState<ApiTokenScope>(INITIAL.scope);
  const [expiry, setExpiry] = useState<ExpiryChoice>(INITIAL.expiry);
  const [name, setName] = useState(INITIAL.name);
  const [creating, setCreating] = useState(false);
  const [issued, setIssued] = useState<Issued | null>(null);
  const [didCopy, setDidCopy] = useState(false);
  const [revoking, setRevoking] = useState<string | null>(null);
  const loadSeq = useRef(0);

  useEffect(() => {
    if (!wsKey) {
      setLoading(false);
      return;
    }
    const seq = ++loadSeq.current;
    setLoading(true);
    setLoadError(null);
    setTokens([]);
    api<ApiTokenListResponse>(`/api/tokens?ws=${wsKey}`)
      .then((res) => {
        if (loadSeq.current !== seq) return;
        // 読み込み中に発行したトークンは、応答に含まれていなくても先頭に残す
        setTokens((current) => {
          const ids = new Set(res.tokens.map((t) => t.id));
          const extra = current.filter((t) => !ids.has(t.id));
          return extra.length ? [...extra, ...res.tokens] : res.tokens;
        });
      })
      .catch((e: Error) => {
        if (loadSeq.current !== seq) return;
        setLoadError(e.message);
      })
      .finally(() => {
        if (loadSeq.current === seq) setLoading(false);
      });
  }, [wsKey]);

  const resetForm = () => {
    setClient(INITIAL.client);
    setScope(INITIAL.scope);
    setExpiry(INITIAL.expiry);
    setName(INITIAL.name);
    setDidCopy(false);
    setIssued(null);
  };

  const create = async () => {
    if (!wsKey || creating) return;
    setCreating(true);
    try {
      const body: ApiTokenCreateRequest = { client, scope, expiresInDays: expiresInDays(expiry) };
      const trimmed = name.trim();
      if (trimmed) body.name = trimmed;
      const res = await api<ApiTokenCreateResponse>(`/api/tokens?ws=${wsKey}`, { body });
      setTokens((list) => [res.token, ...list.filter((t) => t.id !== res.token.id)]);
      setLoadError(null);
      setLoading(false);
      setDidCopy(false);
      setIssued({ secret: res.secret, mcpUrl: res.mcpUrl, client, scope });
    } catch (e) {
      toast((e as Error).message, { kind: "error" });
    } finally {
      setCreating(false);
    }
  };

  const finish = async () => {
    if (!didCopy) {
      const ok = await confirmDialog({
        title: "設定をコピーしましたか？",
        message: "この画面を閉じると、トークンはもう表示できません。",
        confirmLabel: "閉じる",
      });
      if (!ok) return;
    }
    resetForm();
  };

  const revoke = async (token: ApiTokenSummary) => {
    if (revoking) return;
    setRevoking(token.id);
    try {
      const ok = await confirmDialog({
        title: `「${token.name}」のトークンを無効にしますか？`,
        message: "このトークンを使っている AI ツールは、Sen に接続できなくなります。",
        confirmLabel: "無効にする",
        danger: true,
      });
      if (!ok) return;
      await api(`/api/tokens/${token.id}?ws=${wsKey}`, { method: "DELETE" });
      setTokens((list) => list.filter((t) => t.id !== token.id));
      toast("トークンを無効にしました");
    } catch (e) {
      toast((e as Error).message, { kind: "error" });
    } finally {
      setRevoking(null);
    }
  };

  return (
    <>
      <Section
        className="ai-connect"
        testId="ai-connect"
        title="AI 連携"
        description="Claude Code や Cursor などの AI ツールから、Sen の課題を作成・整理できます。AI はあなたの権限で操作し、行った変更には「Claude Code 経由」のような印が付きます。"
      >
        {issued ? (
          <IssuedPanel issued={issued} onCopied={() => setDidCopy(true)} onDone={() => void finish()} />
        ) : (
          <>
            <Field label="AI ツール">
              <div className="segmented wide">
                {API_TOKEN_CLIENTS.map((c) => (
                  <button
                    key={c.value}
                    type="button"
                    className={cx(client === c.value && "on")}
                    aria-pressed={client === c.value}
                    onClick={() => setClient(c.value)}
                    data-testid={`ai-client-${c.value}`}
                  >
                    {c.label}
                  </button>
                ))}
              </div>
            </Field>
            <Field label="できること">
              <div className="ai-scope">
                <div className="segmented wide">
                  <button type="button" className={cx(scope === "write" && "on")} aria-pressed={scope === "write"} onClick={() => setScope("write")} data-testid="ai-scope-write">
                    課題の作成と変更
                  </button>
                  <button type="button" className={cx(scope === "read" && "on")} aria-pressed={scope === "read"} onClick={() => setScope("read")} data-testid="ai-scope-read">
                    閲覧のみ
                  </button>
                </div>
                <p className="muted small">{scope === "write" ? "課題の作成・更新・コメントができます。課題の削除はできません。" : "課題を読むだけで、変更はしません。"}</p>
              </div>
            </Field>
            <Field label="有効期限">
              <select data-testid="ai-expiry" value={expiry} onChange={(e) => setExpiry(e.target.value as ExpiryChoice)}>
                <option value="30">30日</option>
                <option value="90">90日</option>
                <option value="365">1年</option>
                <option value="none">無期限</option>
              </select>
            </Field>
            <Field label="名前" hint="任意">
              <input
                className="input"
                data-testid="ai-token-name"
                maxLength={40}
                placeholder="例：仕事用の MacBook"
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (!e.nativeEvent.isComposing && e.key === "Enter") void create();
                }}
              />
            </Field>
            <div className="ai-create-row">
              <Button variant="primary" icon={<KeyRound size={14} />} data-testid="ai-token-create" disabled={creating || !wsKey} onClick={() => void create()}>
                {creating ? "発行しています…" : "接続用のトークンを発行"}
              </Button>
            </div>
          </>
        )}
      </Section>
      <Section className="ai-tokens" testId="ai-tokens" title="接続中のトークン" description="使わなくなったトークンは無効にしてください。">
        {loading && tokens.length === 0 ? (
          <div className="ai-tokens-loading">
            <Spinner />
          </div>
        ) : loadError && tokens.length === 0 ? (
          <p className="muted ai-tokens-status">{loadError}</p>
        ) : tokens.length === 0 ? (
          <p className="muted settings-empty">まだ AI ツールを接続していません。</p>
        ) : (
          tokens.map((token) => {
            const tool = apiTokenClientLabel(token.client);
            return (
              <div key={token.id} className="member-row ai-token-row" data-testid="ai-token-row">
                <KeyRound size={16} className="muted" />
                <div className="member-info">
                  <span className="ai-token-name">
                    <b>{token.name}</b>
                    {token.name !== tool && <span className="muted">（{tool}）</span>}
                    <span className="pill">{token.scope === "write" ? "作成と変更" : "閲覧のみ"}</span>
                  </span>
                  <TokenMeta token={token} />
                </div>
                <button type="button" className="icon-btn" aria-label="トークンを無効にする" data-testid="ai-token-revoke" disabled={revoking === token.id} onClick={() => void revoke(token)}>
                  <Trash2 size={14} />
                </button>
              </div>
            );
          })
        )}
      </Section>
    </>
  );
}
