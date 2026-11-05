// GitHub 側の操作を、どのメンバーの操作として記録するか。

import type { Me, Role } from "../../shared/types";
import { first } from "../db";
import type { WorkspaceRow } from "../env";
import { toMe } from "../serialize";

interface UserRow {
  id: string;
  name: string;
  email: string;
  avatar_color: string;
  role: Role;
  github_login: string | null;
  created_at: number;
  settings: string | null;
}

export async function loadWorkspace(db: D1Database, workspaceId: string): Promise<WorkspaceRow | null> {
  return first<WorkspaceRow>(db, "SELECT * FROM workspaces WHERE id = ?", workspaceId);
}

/** login のメンバー、いなければ連携した人、いなければ最初の管理者 */
export async function resolveGitHubActor(
  db: D1Database,
  workspaceId: string,
  linkedBy: string | null,
  login: string | null,
): Promise<{ user: Me; role: Role }> {
  const normalized = login?.trim().toLowerCase() || null;
  if (normalized) {
    const member = await userByLogin(db, workspaceId, normalized);
    if (member) return member;
  }
  if (linkedBy) {
    const linker = await userById(db, workspaceId, linkedBy);
    if (linker) return linker;
  }
  const admin = await first<UserRow>(
    db,
    `SELECT u.*, m.role AS role FROM users u
     JOIN members m ON m.user_id = u.id AND m.workspace_id = ?
     WHERE m.role = 'admin'
     ORDER BY m.created_at
     LIMIT 1`,
    workspaceId,
  );
  if (!admin) throw new Error("管理者が見つかりません");
  return toActor(admin);
}

export async function actorById(db: D1Database, workspaceId: string, userId: string): Promise<{ user: Me; role: Role } | null> {
  return userById(db, workspaceId, userId);
}

async function userByLogin(db: D1Database, workspaceId: string, login: string): Promise<{ user: Me; role: Role } | null> {
  const row = await first<UserRow>(
    db,
    `SELECT u.*, m.role AS role FROM users u
     JOIN members m ON m.user_id = u.id AND m.workspace_id = ?
     WHERE u.github_login = ?`,
    workspaceId,
    login,
  );
  return row ? toActor(row) : null;
}

async function userById(db: D1Database, workspaceId: string, userId: string): Promise<{ user: Me; role: Role } | null> {
  const row = await first<UserRow>(
    db,
    `SELECT u.*, m.role AS role FROM users u
     JOIN members m ON m.user_id = u.id AND m.workspace_id = ?
     WHERE u.id = ?`,
    workspaceId,
    userId,
  );
  return row ? toActor(row) : null;
}

function toActor(row: UserRow): { user: Me; role: Role } {
  const user = toMe(row);
  user.role = row.role ?? "member";
  return { user, role: user.role };
}
