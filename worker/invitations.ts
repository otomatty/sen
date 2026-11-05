// メールアドレスを指定した招待。リンクのトークンは SHA-256 だけを保存し、平文は作ったときだけ返す。

import type { Context } from "hono";
import {
  isEmailAllowed,
  isValidEmail,
  maskEmail,
  normalizeEmail,
  parseAllowedDomains,
} from "../shared/domains";
import type {
  InvitationCreateRequest,
  InvitationCreateResponse,
  InvitationIssued,
  InvitationListResponse,
  InvitationSummary,
  InvitePreview,
  PendingInvitation,
  Role,
} from "../shared/types";
import { getSession, randomToken } from "./auth";
import { all, first, run } from "./db";
import { sendInvitationEmail, emailEnabled } from "./email";
import type { AppEnv } from "./env";
import { notifyRealtime, writeChanges } from "./sync";
import { hashToken, publicOrigin } from "./tokens";

const DAY_MS = 86_400_000;
/** 招待リンクの有効期限 */
const INVITE_TTL = 7 * DAY_MS;
/** 1 回の依頼で招待できる人数 */
const MAX_EMAILS_PER_REQUEST = 20;
/** ワークスペースの未承諾の招待の上限 */
const MAX_PENDING = 200;

const INVALID_INVITE = "招待リンクが無効か、期限が切れています";

interface InviteRow {
  id: string;
  workspace_id: string;
  email: string;
  role: string;
  created_at: number;
  expires_at: number;
  email_sent_at: number | null;
  accepted_at: number | null;
  revoked_at: number | null;
  workspace_name: string;
  url_key: string;
  allowed_domains: string;
  inviter_name: string | null;
}

const INVITE_SELECT = `SELECT i.id, i.workspace_id, i.email, i.role, i.created_at, i.expires_at, i.email_sent_at,
       i.accepted_at, i.revoked_at, w.name AS workspace_name, w.url_key, w.allowed_domains, u.name AS inviter_name
     FROM invitations i
     JOIN workspaces w ON w.id = i.workspace_id
     LEFT JOIN users u ON u.id = i.invited_by`;

function err(c: Context, message: string, status = 400) {
  return c.json({ error: message }, status as 400);
}

/** ルートに無い名前は空文字。空なら招待は見つからず 404 になる */
function routeParam(c: Context, name: string): string {
  return c.req.param(name) ?? "";
}

function requireAdmin(c: Context<AppEnv>) {
  if (c.get("role") !== "admin") return err(c, "管理者のみ実行できます", 403);
  return null;
}

function asRole(role: string): Role {
  return role === "admin" ? "admin" : "member";
}

function domainMessage(domains: string[]): string {
  return `このワークスペースは ${domains.join("、")} のメールアドレスだけが利用できます`;
}

function isOpen(row: InviteRow, now: number): boolean {
  return row.accepted_at == null && row.revoked_at == null && row.expires_at > now;
}

async function readJson<T>(c: Context): Promise<T> {
  try {
    return (await c.req.json()) as T;
  } catch {
    return {} as T;
  }
}

/** 同じアドレスへの未承諾の招待を取り消す（再送は作り直す） */
async function revokePending(db: D1Database, workspaceId: string, email: string, now: number) {
  await run(
    db,
    "UPDATE invitations SET revoked_at = ? WHERE workspace_id = ? AND email = ? AND accepted_at IS NULL AND revoked_at IS NULL",
    now,
    workspaceId,
    email,
  );
}

/** 招待を 1 件作る。メールを送れたときは email_sent_at が入っている。リンクはこの戻り値にだけ載る */
async function issueInvitation(c: Context<AppEnv>, email: string, role: Role): Promise<InvitationIssued> {
  const db = c.env.DB;
  const ws = c.get("workspace");
  const user = c.get("user");
  const id = crypto.randomUUID();
  const token = randomToken(32);
  const createdAt = Date.now();
  const expiresAt = createdAt + INVITE_TTL;
  await run(
    db,
    `INSERT INTO invitations (id, workspace_id, email, role, token_hash, invited_by, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    ws.id,
    email,
    role,
    await hashToken(token),
    user.id,
    createdAt,
    expiresAt,
  );
  const link = `${publicOrigin(c)}/invite/${token}`;
  const sent = await sendInvitationEmail(c.env, db, ws.id, {
    invitationId: id,
    inviterId: user.id,
    to: email,
    workspaceName: ws.name,
    inviterName: user.name,
    link,
    expiresAt,
  });
  const invitation: InvitationSummary = {
    id,
    email,
    role,
    invitedBy: { id: user.id, name: user.name },
    createdAt,
    expiresAt,
    emailSentAt: sent.sent ? sent.sentAt : null,
    status: "pending",
  };
  return sent.sent ? { invitation, link, emailSent: true } : { invitation, link, emailSent: false, emailError: sent.error };
}

export async function listInvitations(c: Context<AppEnv>) {
  const denied = requireAdmin(c);
  if (denied) return denied;
  const now = Date.now();
  const rows = await all<{
    id: string;
    email: string;
    role: string;
    created_at: number;
    expires_at: number;
    email_sent_at: number | null;
    inviter_id: string | null;
    inviter_name: string | null;
  }>(
    c.env.DB,
    `SELECT i.id, i.email, i.role, i.created_at, i.expires_at, i.email_sent_at, u.id AS inviter_id, u.name AS inviter_name
     FROM invitations i
     LEFT JOIN users u ON u.id = i.invited_by
     WHERE i.workspace_id = ? AND i.accepted_at IS NULL AND i.revoked_at IS NULL
     ORDER BY i.created_at DESC`,
    c.get("workspace").id,
  );
  const body: InvitationListResponse = {
    invitations: rows.map((r) => ({
      id: r.id,
      email: r.email,
      role: asRole(r.role),
      invitedBy: r.inviter_id ? { id: r.inviter_id, name: r.inviter_name ?? "" } : null,
      createdAt: r.created_at,
      expiresAt: r.expires_at,
      emailSentAt: r.email_sent_at,
      status: r.expires_at > now ? "pending" : "expired",
    })),
    emailEnabled: emailEnabled(c.env),
  };
  return c.json(body);
}

export async function createInvitations(c: Context<AppEnv>) {
  const denied = requireAdmin(c);
  if (denied) return denied;
  const body = await readJson<InvitationCreateRequest>(c);
  const emails: string[] = [];
  const seen = new Set<string>();
  for (const raw of Array.isArray(body.emails) ? body.emails : []) {
    if (typeof raw !== "string") continue;
    const email = normalizeEmail(raw);
    if (!email || seen.has(email)) continue;
    seen.add(email);
    emails.push(email);
  }
  if (emails.length === 0) return err(c, "メールアドレスを指定してください");
  if (emails.length > MAX_EMAILS_PER_REQUEST) return err(c, `一度に招待できるのは${MAX_EMAILS_PER_REQUEST}件までです`);
  const role = body.role;
  if (role !== "admin" && role !== "member") return err(c, "権限が不正です");

  const db = c.env.DB;
  const ws = c.get("workspace");
  const domains = parseAllowedDomains(ws.allowed_domains);
  const members = await all<{ email: string }>(
    db,
    "SELECT u.email AS email FROM users u JOIN members m ON m.user_id = u.id WHERE m.workspace_id = ?",
    ws.id,
  );
  const memberEmails = new Set(members.map((m) => normalizeEmail(m.email)));
  const blocked: string[] = [];
  for (const email of emails) {
    if (!isValidEmail(email)) blocked.push(`${email}（形式が正しくありません）`);
    else if (memberEmails.has(email)) blocked.push(`${email}（既にメンバーです）`);
    else if (!isEmailAllowed(email, domains)) blocked.push(`${email}（利用できるドメインではありません）`);
  }
  if (blocked.length) return err(c, `次のアドレスは招待できません：${blocked.join("、")}`);

  const now = Date.now();
  const pending = await first<{ c: number }>(
    db,
    "SELECT COUNT(*) AS c FROM invitations WHERE workspace_id = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?",
    ws.id,
    now,
  );
  const replacing = await first<{ c: number }>(
    db,
    `SELECT COUNT(*) AS c FROM invitations
     WHERE workspace_id = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ? AND email IN (${emails.map(() => "?").join(",")})`,
    ws.id,
    now,
    ...emails,
  );
  // 同じアドレスの作り直しは件数を増やさない
  if ((pending?.c ?? 0) - (replacing?.c ?? 0) + emails.length > MAX_PENDING) {
    return err(c, `未承諾の招待は${MAX_PENDING}件までです`);
  }

  const results: InvitationIssued[] = [];
  for (const email of emails) {
    await revokePending(db, ws.id, email, now);
    results.push(await issueInvitation(c, email, role));
  }
  return c.json({ results } satisfies InvitationCreateResponse);
}

export async function resendInvitation(c: Context<AppEnv>) {
  const denied = requireAdmin(c);
  if (denied) return denied;
  const ws = c.get("workspace");
  const row = await first<InviteRow>(
    c.env.DB,
    `${INVITE_SELECT} WHERE i.id = ? AND i.workspace_id = ?`,
    routeParam(c, "id"),
    ws.id,
  );
  if (!row || row.accepted_at != null || row.revoked_at != null) return err(c, "招待が見つかりません", 404);
  const domains = parseAllowedDomains(ws.allowed_domains);
  if (!isEmailAllowed(row.email, domains)) return err(c, domainMessage(domains));
  await revokePending(c.env.DB, ws.id, row.email, Date.now());
  return c.json(await issueInvitation(c, row.email, asRole(row.role)));
}

export async function deleteInvitation(c: Context<AppEnv>) {
  const denied = requireAdmin(c);
  if (denied) return denied;
  const ws = c.get("workspace");
  const row = await first<{ id: string }>(
    c.env.DB,
    "SELECT id FROM invitations WHERE id = ? AND workspace_id = ? AND accepted_at IS NULL AND revoked_at IS NULL",
    routeParam(c, "id"),
    ws.id,
  );
  if (!row) return err(c, "招待が見つかりません", 404);
  await run(c.env.DB, "UPDATE invitations SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL", Date.now(), row.id);
  return c.json({ ok: true });
}

export async function previewInvitation(c: Context<AppEnv>) {
  const row = await first<InviteRow>(
    c.env.DB,
    `${INVITE_SELECT} WHERE i.token_hash = ?`,
    await hashToken(routeParam(c, "token")),
  );
  if (!row || !isOpen(row, Date.now())) return err(c, INVALID_INVITE, 404);
  // ログイン判定に失敗しても、招待の内容は見せる
  let forCurrentUser: boolean | null = null;
  try {
    const session = await getSession(c);
    if (session) forCurrentUser = normalizeEmail(session.user.email) === row.email;
  } catch (e) {
    console.error(e);
  }
  const body: InvitePreview = {
    workspaceName: row.workspace_name,
    invitedByName: row.inviter_name,
    maskedEmail: maskEmail(row.email),
    role: asRole(row.role),
    expiresAt: row.expires_at,
    forCurrentUser,
  };
  return c.json(body);
}

/** 未承諾・未取り消し・期限内か、確認済みの同じメールか、許可ドメインかを順に確かめて参加させる */
async function acceptInvitation(c: Context<AppEnv>, row: InviteRow | null) {
  const now = Date.now();
  if (!row || !isOpen(row, now)) return err(c, INVALID_INVITE, 404);
  if (!c.get("emailVerified")) return err(c, "Google で確認済みのメールアドレスでログインしてください", 403);
  const user = c.get("user");
  if (normalizeEmail(user.email) !== row.email) {
    return err(
      c,
      `この招待は ${maskEmail(row.email)} あてです。招待されたメールアドレスの Google アカウントでログインしてください`,
      403,
    );
  }
  const domains = parseAllowedDomains(row.allowed_domains);
  if (!isEmailAllowed(user.email, domains)) return err(c, domainMessage(domains), 403);
  const [updated] = await c.env.DB.batch([
    c.env.DB.prepare(
      "UPDATE invitations SET accepted_at = ?, accepted_by = ? WHERE id = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?",
    ).bind(now, user.id, row.id, now),
    c.env.DB.prepare(
      `INSERT OR IGNORE INTO members (workspace_id, user_id, role, created_at)
       SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM invitations WHERE id = ? AND accepted_by = ? AND accepted_at = ?)`,
    ).bind(row.workspace_id, user.id, asRole(row.role), now, row.id, user.id, now),
  ]);
  if (updated.meta.changes === 0) return err(c, INVALID_INVITE, 404);
  const last = await writeChanges(c.env.DB, row.workspace_id, [{ entity: "user", entityId: user.id, op: "upsert" }]);
  c.executionCtx?.waitUntil?.(notifyRealtime(c.env, row.workspace_id, last));
  return c.json({ ok: true, workspaceKey: row.url_key });
}

export async function acceptInvitationByToken(c: Context<AppEnv>) {
  const row = await first<InviteRow>(
    c.env.DB,
    `${INVITE_SELECT} WHERE i.token_hash = ?`,
    await hashToken(routeParam(c, "token")),
  );
  return acceptInvitation(c, row);
}

export async function acceptInvitationById(c: Context<AppEnv>) {
  const row = await first<InviteRow>(c.env.DB, `${INVITE_SELECT} WHERE i.id = ?`, routeParam(c, "id"));
  return acceptInvitation(c, row);
}

/** ログイン中の人あての、まだ参加できる招待（新しい順、最大 20 件） */
export async function listPendingInvitations(db: D1Database, userId: string, email: string): Promise<PendingInvitation[]> {
  const normalized = normalizeEmail(email);
  const now = Date.now();
  const rows = await all<{
    id: string;
    role: string;
    expires_at: number;
    workspace_name: string;
    allowed_domains: string;
    inviter_name: string | null;
  }>(
    db,
    `SELECT i.id, i.role, i.expires_at, w.name AS workspace_name, w.allowed_domains, u.name AS inviter_name
     FROM invitations i
     JOIN workspaces w ON w.id = i.workspace_id
     LEFT JOIN users u ON u.id = i.invited_by
     WHERE i.email = ? AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > ?
       AND NOT EXISTS (SELECT 1 FROM members m WHERE m.workspace_id = i.workspace_id AND m.user_id = ?)
     ORDER BY i.created_at DESC`,
    normalized,
    now,
    userId,
  );
  return rows
    .filter((r) => isEmailAllowed(normalized, parseAllowedDomains(r.allowed_domains)))
    .slice(0, 20)
    .map((r) => ({
      id: r.id,
      workspaceName: r.workspace_name,
      invitedByName: r.inviter_name,
      role: asRole(r.role),
      expiresAt: r.expires_at,
    }));
}
