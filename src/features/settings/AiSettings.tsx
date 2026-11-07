import { useEffect, useRef, useState } from "react";
import { Check, CheckCircle2, Copy, KeyRound, Plug, Trash2 } from "lucide-react";
import { apiTokenClientLabel } from "../../../shared/constants";
import type {
  ApiTokenCreateRequest,
  ApiTokenCreateResponse,
  AiConnectionsResponse,
  OAuthGrantSummary,
  ApiTokenScope,
  ApiTokenSummary,
} from "../../../shared/types";
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
}

const INITIAL = {
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

type AiClient = "claude" | "chatgpt" | "claude-code" | "cursor" | "vscode" | "other";
const AI_CLIENTS: { value: AiClient; label: string }[] = [
  { value: "claude", label: "Claude" },
  { value: "chatgpt", label: "ChatGPT" },
  { value: "claude-code", label: "Claude Code" },
  { value: "cursor", label: "Cursor" },
  { value: "vscode", label: "VS Code" },
  { value: "other", label: "その他" },
];

function ClientGuide({ client, mcpUrl }: { client: AiClient; mcpUrl: string }) {
  const copied = () => toast("コピーしました");
  const consent = "Sen の画面が開いたら、ワークスペースとできることを選んで「許可する」を押します。";
  if (client === "claude" || client === "chatgpt") {
    return (
      <>
        <ol className="ai-guide-steps">
          <li>
            {client === "claude"
              ? "Claude（Web・デスクトップ・スマホのアプリ）で、カスタマイズ → コネクタ を開き、カスタムコネクタを追加します。"
              : "ChatGPT の設定で、カスタムの MCP サーバー（アプリ）を追加します。"}
          </li>
          <li>
            {client === "claude"
              ? "URL に、上の URL を入れて追加します。"
              : "サーバーの URL に上の URL を入れ、認証は OAuth を選びます。"}
          </li>
          <li>{consent}</li>
        </ol>
        <p className="muted small">
          {client === "claude"
            ? "Team・Enterprise プランでは、組織のオーナーが組織の設定のコネクタから追加し、メンバーがそれぞれ接続します。"
            : "プランや組織の設定によっては、MCP サーバーを追加できないことがあります。"}
        </p>
      </>
    );
  }
  if (client === "claude-code") {
    return (
      <>
        <p>ターミナルで次のコマンドを実行します。</p>
        <CodeBlock value={`claude mcp add --scope user --transport http sen ${mcpUrl}`} onCopied={copied} />
        <p>Claude Code で /mcp を開き、sen を選んで認証します。ブラウザで Sen の画面が開きます。</p>
      </>
    );
  }
  if (client === "cursor") {
    return (
      <>
        <p>
          <a
            className="btn btn-primary btn-md"
            data-testid="ai-cursor-install"
            href={`cursor://anysphere.cursor-deeplink/mcp/install?name=sen&config=${encodeURIComponent(
              btoa(JSON.stringify({ url: mcpUrl })),
            )}`}
          >
            Cursor に追加
          </a>
        </p>
        <p>うまく開かないときは、<code className="inline-code">~/.cursor/mcp.json</code> に次の内容を追加します。</p>
        <CodeBlock value={JSON.stringify({ mcpServers: { sen: { url: mcpUrl } } }, null, 2)} onCopied={copied} />
        <p>Cursor の MCP の設定で sen の接続を押すと、ブラウザで Sen の画面が開きます。</p>
      </>
    );
  }
  if (client === "vscode") {
    return (
      <>
        <p>コマンドパレットで <code className="inline-code">MCP: Open User Configuration</code> を開き、次の内容を追加します。</p>
        <CodeBlock value={JSON.stringify({ servers: { sen: { type: "http", url: mcpUrl } } }, null, 2)} onCopied={copied} />
        <p>サーバーを起動すると、認証を求められます。ブラウザで Sen の画面が開きます。</p>
      </>
    );
  }
  return (
    <>
      <p>OAuth に対応した MCP クライアント（Streamable HTTP）に、上の URL を入れます。接続を始めると、ブラウザで Sen の画面が開きます。</p>
      <p>OAuth に対応していないツールは、下の「トークンで接続」を使います。</p>
    </>
  );
}

function IssuedPanel({ issued, onCopied, onDone }: { issued: Issued; onCopied: () => void; onDone: () => void }) {
  return (
    <div className="ai-issued" data-testid="ai-issued">
      <div className="ai-callout">
        <CheckCircle2 size={18} />
        <div>
          <b>トークンを発行しました</b>
          <p>このトークンは今だけ表示されます。設定が終わるまで、この画面を閉じないでください。</p>
        </div>
      </div>
      <CodeBlock label="URL" value={issued.mcpUrl} onCopied={onCopied} />
      <CodeBlock label="ヘッダー" value={`Authorization: Bearer ${issued.secret}`} onCopied={onCopied} />
      <CodeBlock
        label="Claude Code の例"
        value={`claude mcp add --scope user --transport http sen ${issued.mcpUrl} --header "Authorization: Bearer ${issued.secret}"`}
        onCopied={onCopied}
      />
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
  const teamKey = useTeams()[0]?.key;
  const [mcpUrl, setMcpUrl] = useState(`${window.location.origin}/api/mcp`);
  const [grants, setGrants] = useState<OAuthGrantSummary[]>([]);
  const [tokens, setTokens] = useState<ApiTokenSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [client, setClient] = useState<AiClient>("claude");
  const [scope, setScope] = useState<ApiTokenScope>(INITIAL.scope);
  const [expiry, setExpiry] = useState<ExpiryChoice>(INITIAL.expiry);
  const [name, setName] = useState(INITIAL.name);
  const [creating, setCreating] = useState(false);
  const [issued, setIssued] = useState<Issued | null>(null);
  const [didCopy, setDidCopy] = useState(false);
  const [revoking, setRevoking] = useState<string | null>(null);
  const loadSeq = useRef(0);

  useEffect(() => {
    const seq = ++loadSeq.current;
    if (!wsKey) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setLoadError(null);
    setTokens([]);
    setGrants([]);
    setIssued(null);
    setMcpUrl(`${window.location.origin}/api/mcp`);
    api<AiConnectionsResponse>(`/api/ai/connections?ws=${encodeURIComponent(wsKey)}`)
      .then((res) => {
        if (loadSeq.current !== seq) return;
        setMcpUrl(res.mcpUrl);
        setGrants(res.grants);
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
    return () => { ++loadSeq.current; };
  }, [wsKey]);

  const resetForm = () => {
    setScope(INITIAL.scope);
    setExpiry(INITIAL.expiry);
    setName(INITIAL.name);
    setDidCopy(false);
    setIssued(null);
  };

  const create = async () => {
    if (!wsKey || creating) return;
    const seq = loadSeq.current;
    setCreating(true);
    try {
      const body: ApiTokenCreateRequest = { client: "other", scope, expiresInDays: expiresInDays(expiry) };
      const trimmed = name.trim();
      if (trimmed) body.name = trimmed;
      const res = await api<ApiTokenCreateResponse>(`/api/tokens?ws=${wsKey}`, { body });
      if (loadSeq.current !== seq) return;
      setTokens((list) => [res.token, ...list.filter((t) => t.id !== res.token.id)]);
      setLoadError(null);
      setLoading(false);
      setDidCopy(false);
      setIssued({ secret: res.secret, mcpUrl: res.mcpUrl });
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

  const revokeConnection = async (grant: OAuthGrantSummary) => {
    if (revoking) return;
    setRevoking(grant.id);
    try {
      const ok = await confirmDialog({
        title: `「${grant.clientName}」の接続を解除しますか？`,
        message: "この AI ツールは、Sen に接続できなくなります。使うときは、AI ツールから接続し直してください。",
        confirmLabel: "解除する",
        danger: true,
      });
      if (!ok) return;
      await api(`/api/ai/connections/${grant.id}?ws=${encodeURIComponent(wsKey)}`, { method: "DELETE" });
      setGrants((list) => list.filter((g) => g.id !== grant.id));
      toast("接続を解除しました");
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
        description="Claude、ChatGPT、Claude Code、Cursor などの AI ツールから、Sen の課題を作成・整理できます。AI はあなたの権限で操作し、行った変更には「Claude 経由」のような印が付きます。"
      >
        <Field label="接続先の URL">
          <div data-testid="ai-mcp-url">
            <CodeBlock value={mcpUrl} onCopied={() => toast("コピーしました")} />
          </div>
        </Field>
        <Field label="AI ツール" className="field-top">
          <div className="ai-guide">
            <div className="segmented wide">
              {AI_CLIENTS.map((c) => (
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
            <div className="ai-guide" data-testid="ai-client-guide">
              <ClientGuide client={client} mcpUrl={mcpUrl} />
            </div>
          </div>
        </Field>
        <div className="ai-guide ai-examples">
          <h3 className="ai-step-title">話しかけ方の例</h3>
          <p>接続したら、AI ツールで次のように話しかけます。</p>
          <div className="ai-prompts">
            {examplePrompts(teamKey, "write").map((text) => (
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
        </div>
      </Section>
      <Section
        className="ai-tokens"
        testId="ai-connections"
        title="接続中の AI ツール"
        description="使わなくなった接続は解除してください。"
      >
        {loading && tokens.length === 0 && grants.length === 0 ? (
          <div className="ai-tokens-loading">
            <Spinner />
          </div>
        ) : loadError && tokens.length === 0 && grants.length === 0 ? (
          <p className="muted ai-tokens-status">{loadError}</p>
        ) : tokens.length === 0 && grants.length === 0 ? (
          <p className="muted settings-empty">まだ AI ツールを接続していません。</p>
        ) : (
          <>
            {grants.map((grant) => (
              <div key={grant.id} className="member-row ai-token-row" data-testid="ai-connection-row">
                <Plug size={16} className="muted" />
                <div className="member-info">
                  <span className="ai-token-name">
                    <b>{grant.clientName}</b>
                    <span className="pill">{grant.scope === "write" ? "作成と変更" : "閲覧のみ"}</span>
                  </span>
                  <span className="muted small ai-token-meta">
                    接続：{formatDate(grant.createdAt, true)}・
                    {grant.lastUsedAt ? `最後に使用：${timeAgo(grant.lastUsedAt)}` : "まだ使われていません"}
                  </span>
                </div>
                <button
                  type="button"
                  className="icon-btn"
                  aria-label="接続を解除する"
                  data-testid="ai-connection-revoke"
                  disabled={revoking === grant.id}
                  onClick={() => void revokeConnection(grant)}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
            {tokens.map((token) => {
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
            })}
          </>
        )}
      </Section>
      <Section
        className="ai-connect"
        testId="ai-token"
        title="トークンで接続"
        description="OAuth に対応していないツールやスクリプトからは、トークンで接続します。トークンは、接続先の URL と一緒にヘッダーに設定します。"
      >
        {issued ? (
          <IssuedPanel issued={issued} onCopied={() => setDidCopy(true)} onDone={() => void finish()} />
        ) : (
          <>
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
              <select data-testid="ai-expiry" aria-label="有効期限" value={expiry} onChange={(e) => setExpiry(e.target.value as ExpiryChoice)}>
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
                aria-label="名前"
                maxLength={40}
                placeholder="例：CI 用"
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (!e.nativeEvent.isComposing && e.key === "Enter") void create();
                }}
              />
            </Field>
            <div className="ai-create-row">
              <Button variant="primary" icon={<KeyRound size={14} />} data-testid="ai-token-create" disabled={creating || !wsKey} onClick={() => void create()}>
                {creating ? "発行しています…" : "トークンを発行"}
              </Button>
            </div>
          </>
        )}
      </Section>
    </>
  );
}
