import type { Context } from "hono";
import { attachmentUrl, cleanFileName, contentDisposition, sniffImageType, type AttachmentKind } from "../shared/attachments";
import { ATTACHMENT_DAILY_MAX, ATTACHMENT_FILE_MAX_BYTES, ATTACHMENT_IMAGE_MAX_BYTES, ATTACHMENT_WORKSPACE_MAX_BYTES } from "../shared/constants";
import type { AttachmentUploadResponse } from "../shared/types";
import { workspaceAccess } from "./access";
import { getSession } from "./auth";
import { first, run } from "./db";
import type { AppEnv, WorkspaceRow } from "./env";
import { publicOrigin } from "./tokens";

interface AttachmentRow {
  id: string;
  workspace_id: string;
  name: string;
  kind: AttachmentKind;
  content_type: string;
  size: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SIZE_ERROR = "画像は 10 MB、それ以外は 25 MB までです";

function err(c: Context, message: string, status = 400) {
  return c.json({ error: message }, status as 400);
}

export async function uploadFile(c: Context<AppEnv>) {
  const files = c.env.FILES;
  if (!files) return err(c, "ファイルの保存先が設定されていません", 503);
  const length = c.req.header("content-length");
  if (length === undefined || !/^\d+$/.test(length)) {
    return err(c, "ファイルの大きさが分かりません", 411);
  }
  const size = Number(length);
  if (size === 0) return err(c, "空のファイルは添付できません");
  if (size > ATTACHMENT_FILE_MAX_BYTES) return err(c, SIZE_ERROR, 413);
  let name: string;
  try {
    name = cleanFileName(decodeURIComponent(c.req.header("x-sen-filename") ?? "file"));
  } catch {
    return err(c, "ファイル名が不正です");
  }
  const body = await c.req.arrayBuffer();
  if (body.byteLength !== size) return err(c, "ファイルを受け取れませんでした");
  const imageType = sniffImageType(new Uint8Array(body));
  const kind: AttachmentKind = imageType ? "image" : "file";
  const contentType = imageType ?? "application/octet-stream";
  if (imageType && size > ATTACHMENT_IMAGE_MAX_BYTES) return err(c, SIZE_ERROR, 413);
  const db = c.env.DB;
  const workspace = c.get("workspace");
  const user = c.get("user");
  const now = Date.now();
  const id = crypto.randomUUID();
  // 件数と容量の確認を行の作成と同じ文で行い、同時アップロードの枠も確保する。
  const reserved = await db.prepare(
    `INSERT INTO attachments (id, workspace_id, uploader_id, name, kind, content_type, size, created_at, unreferenced_at)
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
     WHERE (SELECT COUNT(*) FROM attachments WHERE uploader_id = ? AND created_at >= ?) < ?
       AND (SELECT COALESCE(SUM(size), 0) FROM attachments WHERE workspace_id = ?) + ? <= ?`,
  ).bind(
    id, workspace.id, user.id, name, kind, contentType, size, now, now,
    user.id, now - 86_400_000, ATTACHMENT_DAILY_MAX,
    workspace.id, size, ATTACHMENT_WORKSPACE_MAX_BYTES,
  ).run();
  if (reserved.meta.changes === 0) {
    const usage = await first<{ count: number; size: number }>(db,
      `SELECT (SELECT COUNT(*) FROM attachments WHERE uploader_id = ? AND created_at >= ?) AS count,
              (SELECT COALESCE(SUM(size), 0) FROM attachments WHERE workspace_id = ?) AS size`,
      user.id, now - 86_400_000, workspace.id);
    if ((usage?.count ?? 0) >= ATTACHMENT_DAILY_MAX) {
      return err(c, "添付できるのは 1 日 500 件までです。しばらくしてからやり直してください", 429);
    }
    return err(c, "ワークスペースの保存容量（10 GB）がいっぱいです", 409);
  }
  const key = `${workspace.id}/${id}`;
  try {
    await files.put(key, body, { httpMetadata: { contentType } });
  } catch (e) {
    await run(db, "DELETE FROM attachments WHERE id = ?", id);
    throw e;
  }
  return c.json<AttachmentUploadResponse>({ id, url: attachmentUrl(publicOrigin(c), id, name), name, kind, size }, 201);
}

export async function serveFile(c: Context<AppEnv>) {
  const id = c.req.param("id");
  if (!id || !UUID.test(id)) return err(c, "ファイルが見つかりません", 404);
  const session = await getSession(c);
  if (!session) return err(c, "ログインが必要です", 401);
  const row = await first<AttachmentRow>(c.env.DB, "SELECT * FROM attachments WHERE id = ?", id.toLowerCase());
  if (!row) return err(c, "ファイルが見つかりません", 404);
  const workspace = await first<WorkspaceRow>(c.env.DB, "SELECT * FROM workspaces WHERE id = ?", row.workspace_id);
  if (!workspace || "error" in await workspaceAccess(c.env.DB, workspace, session.user)) {
    return err(c, "ファイルが見つかりません", 404);
  }
  const files = c.env.FILES;
  if (!files) return err(c, "ファイルが見つかりません", 404);
  const etag = `"${row.id}"`;
  // 認可を毎回確認した後でキャッシュを使う。304 では R2 を読まない。
  if (c.req.header("if-none-match") === etag) {
    c.header("ETag", etag);
    c.header("Cache-Control", "private, no-cache");
    return c.body(null, 304);
  }
  const key = `${row.workspace_id}/${row.id}`;
  let body: ReadableStream | null = null;
  if (c.req.method === "HEAD") {
    if (!await files.head(key)) return err(c, "ファイルが見つかりません", 404);
  } else {
    const object = await files.get(key);
    if (!object) return err(c, "ファイルが見つかりません", 404);
    // Workers と DOM の型定義は異なるが、実行時は同じ ReadableStream として渡せる
    body = object.body as unknown as ReadableStream;
  }
  c.header("Content-Type", row.content_type);
  c.header("Content-Disposition", contentDisposition(row.kind, row.name));
  c.header("Content-Length", String(row.size));
  c.header("ETag", etag);
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Content-Security-Policy", "default-src 'none'; sandbox");
  c.header("Cross-Origin-Resource-Policy", "same-origin");
  c.header("Cache-Control", "private, no-cache");
  return body ? c.body(body) : c.body(null);
}
