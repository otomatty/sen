import { isEmailAllowed, parseAllowedDomains } from "../shared/domains";
import type { Me, Role } from "../shared/types";
import { first } from "./db";
import type { WorkspaceRow } from "./env";

/** 通常の API と添付の取得で、所属とメールドメインを同じ条件で確認する */
export async function workspaceAccess(db: D1Database, ws: WorkspaceRow, user: Me): Promise<{ role: Role } | { error: string }> {
  const member = await first<{ role: Role }>(
    db,
    "SELECT role FROM members WHERE workspace_id = ? AND user_id = ?",
    ws.id,
    user.id,
  );
  if (!member) return { error: "このワークスペースへのアクセス権がありません" };
  const domains = parseAllowedDomains(ws.allowed_domains);
  if (!isEmailAllowed(user.email, domains)) {
    return { error: `このワークスペースは ${domains.join("、")} のメールアドレスだけが利用できます` };
  }
  return member;
}
