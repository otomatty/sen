// MCP Streamable HTTP（ステートレス）。セッションは発行しない。認証は API トークンだけ。

import { MARKDOWN_MAX_LENGTH } from "../../shared/constants";
import type { Context } from "hono";
import type { AppEnv } from "../env";
import { MutationError, type MutationCtx } from "../mutations";
import { notifyRealtime, writeChanges } from "../sync";
import { scheduleGitHubSync } from "../github/config";
import { scheduleSheetSync } from "../sheets/config";
import { authenticateApiToken, publicOrigin, type ApiTokenAuth } from "../tokens";
import { openResolver, ToolError } from "./context";
import { findTool, READ_ONLY_MESSAGE, toolDefinitions, type McpTool } from "./tools";

const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

const AUTH_MESSAGE =
  "Sen の API トークンが無効か、期限が切れています。Sen の 設定 → AI 連携 でトークンを発行し直してください。";

function rpcResult(id: unknown, result: unknown) {
  return { jsonrpc: "2.0" as const, id, result };
}

function rpcError(id: unknown, code: number, message: string) {
  return { jsonrpc: "2.0" as const, id, error: { code, message } };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function instructions(wsName: string, userName: string, readOnly: boolean): string {
  const lines = [`Sen は日本語の課題管理ツールです。ワークスペース「${wsName}」に、${userName} さんとして接続しています。`];
  if (readOnly) lines.push("このトークンは閲覧のみで、課題の作成や変更はできません。");
  lines.push(
    "- 最初に get_workspace で、チーム・ステータス・メンバー・ラベル・プロジェクト・今日の日付を確かめてください。",
    "- 課題は「ENG-12」の形式で指定します。チーム・ステータス・担当者・ラベル・プロジェクト・サイクルは名前で指定できます。",
    `- 説明とコメントは GitHub と同じ Markdown（GFM）です。見出し（h1〜h6）・箇条書き・チェックリスト・コード・リンク・表・画像（https の URL）・注記（> [!NOTE] など）・脚注が使えます。書いた文字列をそのまま保存します。最大 ${MARKDOWN_MAX_LENGTH.toLocaleString("en-US")} 文字です。`,
    "- 複数の課題を作る・変えるときは、create_issues / update_issues に配列でまとめて渡してください（1 回 50 件まで）。",
    "- 多くの課題をまとめて変える前には、何をどう変えるかをユーザーに確かめてください。",
    "- 結果をユーザーに伝えるときは、課題の ID（例: ENG-12）と URL を添えてください。",
  );
  return lines.join("\n");
}

function protocolVersion(params: unknown): string {
  const requested = isObject(params) ? params.protocolVersion : undefined;
  if (typeof requested === "string" && PROTOCOL_VERSIONS.includes(requested)) return requested;
  return "2025-11-25";
}

export async function handleMcp(c: Context<AppEnv>): Promise<Response> {
  if (c.req.method !== "POST") {
    return c.json(rpcError(null, -32600, "Invalid Request"), 405, { Allow: "POST" });
  }
  try {
    const auth = await authenticateApiToken(c.env.DB, c.req.header("authorization"), Date.now());
    if (!auth) {
      return c.json(rpcError(null, -32001, AUTH_MESSAGE), 401, {
        "WWW-Authenticate": 'Bearer realm="sen", error="invalid_token"',
      });
    }
    let payload: unknown;
    try {
      payload = await c.req.json();
    } catch {
      return c.json(rpcError(null, -32700, "Parse error"), 400);
    }

    const handleMessage = async (msg: unknown): Promise<Record<string, unknown> | null> => {
      if (!isObject(msg)) return null;
      if (typeof msg.method === "string" && msg.method.startsWith("notifications/")) return null;
      if (!Object.prototype.hasOwnProperty.call(msg, "id")) return null;
      if (!("method" in msg) && ("result" in msg || "error" in msg)) return null;
      const id = msg.id;
      if (id !== null && typeof id !== "string" && typeof id !== "number") return rpcError(null, -32600, "Invalid Request");
      if (msg.jsonrpc !== "2.0" || typeof msg.method !== "string") return rpcError(id, -32600, "Invalid Request");
      return dispatch(c, auth, id, msg.method, "params" in msg ? msg.params : undefined);
    };

    if (Array.isArray(payload)) {
      if (!payload.length) return c.json(rpcError(null, -32600, "Invalid Request"));
      const responses = [];
      for (const item of payload) {
        const res = await handleMessage(item);
        if (res) responses.push(res);
      }
      if (!responses.length) return c.body(null, 202);
      return c.json(responses);
    }
    if (!isObject(payload)) return c.json(rpcError(null, -32600, "Invalid Request"));
    const res = await handleMessage(payload);
    if (!res) return c.body(null, 202);
    return c.json(res);
  } catch (e) {
    console.error(e);
    return c.json(rpcError(null, -32603, "サーバーでエラーが発生しました。少し待ってからもう一度試してください。"), 500);
  }
}

async function dispatch(c: Context<AppEnv>, auth: ApiTokenAuth, id: unknown, method: string, params: unknown): Promise<Record<string, unknown>> {
  switch (method) {
    case "initialize":
      return rpcResult(id, {
        protocolVersion: protocolVersion(params),
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "sen", title: "Sen", version: "1.0.0" },
        instructions: instructions(auth.ws.name, auth.user.name, auth.scope === "read"),
      });
    case "ping":
      return rpcResult(id, {});
    case "tools/list":
      return rpcResult(id, { tools: toolDefinitions(auth.scope) });
    case "tools/call":
      return callTool(c, auth, id, params);
    case "resources/list":
      return rpcResult(id, { resources: [] });
    case "resources/templates/list":
      return rpcResult(id, { resourceTemplates: [] });
    case "prompts/list":
      return rpcResult(id, { prompts: [] });
    default:
      return rpcError(id, -32601, "Method not found");
  }
}

async function callTool(c: Context<AppEnv>, auth: ApiTokenAuth, id: unknown, params: unknown): Promise<Record<string, unknown>> {
  if (!isObject(params) || typeof params.name !== "string" || !params.name) {
    return rpcError(id, -32602, "ツール名が不正です");
  }
  const tool = findTool(params.name);
  if (!tool) return rpcError(id, -32602, `不明なツールです: ${params.name}`);
  return rpcResult(id, await invokeTool(c, auth, tool, params.arguments));
}

async function invokeTool(c: Context<AppEnv>, auth: ApiTokenAuth, tool: McpTool, args: unknown): Promise<Record<string, unknown>> {
  const mutation: MutationCtx = {
    db: c.env.DB,
    ws: auth.ws,
    user: auth.user,
    role: auth.role,
    now: Date.now(),
    changes: [],
    via: auth.via,
  };
  let text = "";
  let isError = false;
  try {
    if (!tool.annotations.readOnlyHint && auth.scope !== "write") {
      text = READ_ONLY_MESSAGE;
      isError = true;
    } else {
      const resolver = await openResolver(c.env.DB, auth.ws, auth.user, publicOrigin(c));
      const result = await tool.handle({ resolver, mutation, scope: auth.scope }, args ?? {});
      text = JSON.stringify(result) ?? "{}";
    }
  } catch (e) {
    isError = true;
    if (e instanceof ToolError || e instanceof MutationError) text = e.message;
    else {
      console.error(e);
      text = "サーバーでエラーが発生しました。少し待ってからもう一度試してください。";
    }
  } finally {
    if (mutation.changes.length > 0) {
      const lastSyncId = await writeChanges(c.env.DB, auth.ws.id, mutation.changes);
      c.executionCtx?.waitUntil?.(notifyRealtime(c.env, auth.ws.id, lastSyncId));
      c.executionCtx?.waitUntil?.(scheduleSheetSync(c.env, auth.ws, mutation.changes, publicOrigin(c)));
      c.executionCtx?.waitUntil?.(scheduleGitHubSync(c.env, auth.ws, mutation.changes, auth.via));
    }
  }
  const body: Record<string, unknown> = { content: [{ type: "text", text }] };
  if (isError) body.isError = true;
  return body;
}
