// 招待メール（Cloudflare Email Service）。
// EMAIL と INVITE_EMAIL_FROM が両方そろったときだけ送る。失敗しても招待自体は残す。
// 直近 24 時間に送れる数は、ワークスペースごと・招待した人ごとに 50 通まで。

import type { Env } from "./env";

const DAY_MS = 86_400_000;
/** ワークスペースごと・招待した人ごとに、直近 24 時間に送れる招待メールの数 */
const MAX_EMAILS_PER_DAY = 50;

const NOT_CONFIGURED = "招待メールの送信が設定されていません。リンクをコピーして本人に送ってください";
const OVER_LIMIT = "1日に送れる招待メールの上限（50通）に達しました。リンクをコピーして本人に送ってください";
const SEND_FAILED = "招待メールを送れませんでした。リンクをコピーして本人に送ってください";

export function emailEnabled(env: Env): boolean {
  return !!(env.EMAIL && env.INVITE_EMAIL_FROM);
}

export interface InvitationMail {
  invitationId: string;
  inviterId: string;
  to: string;
  workspaceName: string;
  inviterName: string;
  link: string;
  expiresAt: number;
}

export type InvitationMailResult = { sent: true; sentAt: number } | { sent: false; error: string };

/** 件名に改行を残すとヘッダーを分割できるので、空白に置き換える */
function oneLine(s: string): string {
  return s.replace(/[\r\n]/g, " ");
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** 日本時間の YYYY年M月D日 H:mm */
function formatExpiresAt(ms: number): string {
  const parts = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(ms));
  const pick = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
  return `${pick("year")}年${pick("month")}月${pick("day")}日 ${pick("hour")}:${pick("minute")}`;
}

function bodies(mail: InvitationMail): { subject: string; text: string; html: string } {
  const expires = formatExpiresAt(mail.expiresAt);
  const subject = oneLine(
    `${mail.inviterName} さんから Sen のワークスペース「${mail.workspaceName}」に招待されました`,
  );
  const text = [
    `${mail.inviterName} さんから Sen のワークスペース「${mail.workspaceName}」に招待されました。`,
    "",
    "参加するには、次のリンクを開いてください。",
    mail.link,
    "",
    `有効期限は ${expires} までです。`,
    "",
    `招待されたメールアドレス（${mail.to}）の Google アカウントでログインしてください。`,
    "",
    "心当たりがない場合は、このメールを無視してください。",
  ].join("\n");
  const name = escapeHtml(mail.inviterName);
  const workspace = escapeHtml(mail.workspaceName);
  const email = escapeHtml(mail.to);
  const link = escapeHtml(mail.link);
  const until = escapeHtml(expires);
  const html = `<div style="font-family:sans-serif;font-size:14px;line-height:1.7;color:#222">
<p>${name} さんから Sen のワークスペース「${workspace}」に招待されました。</p>
<p>参加するには、次のリンクを開いてください。<br><a href="${link}">${link}</a></p>
<p>有効期限は ${until} までです。</p>
<p>招待されたメールアドレス（${email}）の Google アカウントでログインしてください。</p>
<p>心当たりがない場合は、このメールを無視してください。</p>
</div>`;
  return { subject, text, html };
}

/**
 * 招待メールを送る。未設定・上限超過・送信エラーは例外にせず、理由を返す。
 * 送る前に 1 文の UPDATE で枠を確保する。直近 24 時間の email_sent_at で、ワークスペースごと・招待した人ごとの上限を数える。
 */
export async function sendInvitationEmail(
  env: Env,
  db: D1Database,
  workspaceId: string,
  mail: InvitationMail,
): Promise<InvitationMailResult> {
  if (!env.EMAIL || !env.INVITE_EMAIL_FROM) return { sent: false, error: NOT_CONFIGURED };
  const from = env.INVITE_EMAIL_FROM;
  const sentAt = Date.now();
  const since = sentAt - DAY_MS;
  const reserved = await db
    .prepare(
      `UPDATE invitations SET email_sent_at = ?
       WHERE id = ? AND email_sent_at IS NULL
         AND (SELECT COUNT(*) FROM invitations WHERE workspace_id = ? AND email_sent_at >= ?) < ?
         AND (SELECT COUNT(*) FROM invitations WHERE invited_by = ? AND email_sent_at >= ?) < ?`,
    )
    .bind(sentAt, mail.invitationId, workspaceId, since, MAX_EMAILS_PER_DAY, mail.inviterId, since, MAX_EMAILS_PER_DAY)
    .run();
  if (reserved.meta.changes === 0) return { sent: false, error: OVER_LIMIT };
  const { subject, text, html } = bodies(mail);
  try {
    await env.EMAIL.send({
      from: { name: "Sen", email: from },
      to: mail.to,
      subject,
      text,
      html,
    });
    return { sent: true, sentAt };
  } catch (e) {
    console.error("招待メールを送れませんでした", e);
    await db.prepare("UPDATE invitations SET email_sent_at = NULL WHERE id = ?").bind(mail.invitationId).run();
    return { sent: false, error: SEND_FAILED };
  }
}
