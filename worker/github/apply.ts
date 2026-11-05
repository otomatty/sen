// GitHub からの書き込み。applyMutation のあと、同期ログ・通知・シートまで行う。
// scheduleGitHubSync は呼ばない（同期そのものが、もう一度 GitHub へ戻らないように）。

import type { Me, Mutation, Role } from "../../shared/types";
import type { Env, WorkspaceRow } from "../env";
import { applyMutation, recordGitHubActivity, type MutationCtx } from "../mutations";
import { REPORT_ENTITIES, scheduleSheetSync, sheetsConfig } from "../sheets/config";
import { notifyRealtime, writeChanges, type Change } from "../sync";

export interface GitHubActivityData {
  action: "created" | "linked" | "unlinked" | "imported";
  repo: string;
  number: number;
  url: string;
}

export interface GitHubWrite {
  env: Env;
  ws: WorkspaceRow;
  actor: { user: Me; role: Role };
  /** 省略時は "GitHub"。手での紐づけは null */
  via?: string | null;
  now?: number;
  /** 設定したときだけ、コメントに github_author を入れ、メンションを検出しない */
  githubComment?: { author: string | null } | null;
  mutations?: Mutation[];
  activities?: { issueId: string; data: GitHubActivityData }[];
  /** 同じ Durable Object のシート予約。自分自身へ fetch しないため */
  scheduleSheets?: () => Promise<void>;
}

export async function applyGitHubChanges(write: GitHubWrite): Promise<void> {
  const ctx: MutationCtx = {
    db: write.env.DB,
    ws: write.ws,
    user: write.actor.user,
    role: write.actor.role,
    now: write.now ?? Date.now(),
    changes: [],
    via: write.via === undefined ? "GitHub" : write.via,
    githubComment: write.githubComment ?? null,
  };
  for (const mutation of write.mutations ?? []) await applyMutation(ctx, mutation);
  for (const activity of write.activities ?? []) await recordGitHubActivity(ctx, activity.issueId, activity.data);
  await commitGitHubChanges(write.env, write.ws, ctx.changes, write.scheduleSheets);
}

export async function commitGitHubChanges(
  env: Env,
  ws: WorkspaceRow,
  changes: Change[],
  scheduleSheets?: () => Promise<void>,
): Promise<void> {
  if (!changes.length) return;
  const last = await writeChanges(env.DB, ws.id, changes);
  await notifyRealtime(env, ws.id, last);
  const sheets = sheetsConfig(env);
  if (sheets && sheets.workspaceKey === ws.url_key && scheduleSheets) {
    if (!changes.some((change) => REPORT_ENTITIES.has(change.entity))) return;
    await scheduleSheets();
    return;
  }
  await scheduleSheetSync(env, ws, changes, "");
}
