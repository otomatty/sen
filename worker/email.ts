// 招待メール（Cloudflare Email Service）。
// EMAIL と INVITE_EMAIL_FROM が両方そろったときだけ送る。失敗しても招待自体は残す。
// 直近 24 時間に送れる数は、ワークスペースごと・招待した人ごとに 50 通まで。

import type { Role } from "../shared/types";
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
  role: Role;
  /** アプリの公開 URL の origin。末尾スラッシュなし */
  appOrigin: string;
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

const SANS =
  "-apple-system,BlinkMacSystemFont,'Segoe UI','Hiragino Sans','Hiragino Kaku Gothic ProN','Noto Sans JP',Meiryo,sans-serif";
const MONO = "ui-monospace,'SFMono-Regular',Menlo,Consolas,monospace";

/** ライト配色・パソコン幅が既定。幅とダークは class で上書きする */
const EMAIL_CSS = `@media (max-width: 600px) {
  .sen-bg { padding: 24px 12px 28px !important; }
  .sen-card { padding: 24px 20px 22px !important; }
  h1.sen-text { font-size: 20px !important; }
  .sen-btn-table { width: 100% !important; }
  .sen-btn { display: block !important; }
  .sen-label, .sen-value { display: block !important; width: auto !important; }
  .sen-value { padding: 0 !important; }
  .sen-label { font-size: 12px !important; }
}
@media (prefers-color-scheme: dark) {
  body, .sen-bg { background: #0b0c0e !important; }
  .sen-card { background: #111215 !important; border-color: #212226 !important; }
  .sen-sub { background: #17181b !important; border-color: #212226 !important; }
  .sen-text { color: #e6e6e9 !important; }
  .sen-text2 { color: #a1a3a9 !important; }
  .sen-text3 { color: #6b6d74 !important; }
  .sen-btn-cell { background: #6470e8 !important; }
  .sen-link { color: #a0a8ff !important; }
  .sen-rule { background: #212226 !important; }
}`;

function roleName(role: Role): string {
  return role === "admin" ? "管理者" : "メンバー";
}

/** 日本時間。full は YYYY年M月D日 H:mm、short は年を省いた M月D日 H:mm */
function formatExpiresAt(ms: number): { full: string; short: string } {
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
  const short = `${pick("month")}月${pick("day")}日 ${pick("hour")}:${pick("minute")}`;
  return { full: `${pick("year")}年${short}`, short };
}

function detailRow(label: string, value: string, first: boolean): string {
  const labelPadding = first ? "0 0 0 0" : "10px 0 0 0";
  const valuePadding = first ? "0 0 0 12px" : "10px 0 0 12px";
  return `<tr>
<td class="sen-label sen-text3" style="padding:${labelPadding};font-size:12.5px;line-height:1.6;color:#787b84;white-space:nowrap;vertical-align:top;width:128px;">${label}</td>
<td class="sen-value sen-text" style="padding:${valuePadding};font-size:13.5px;line-height:1.6;color:#1b1c21;overflow-wrap:anywhere;">${value}</td>
</tr>`;
}

function invitationHtml(mail: InvitationMail, subject: string, expires: { full: string; short: string }): string {
  const name = escapeHtml(mail.inviterName);
  const workspace = escapeHtml(mail.workspaceName);
  const email = escapeHtml(mail.to);
  const link = escapeHtml(mail.link);
  const until = escapeHtml(expires.full);
  const short = escapeHtml(expires.short);
  const role = escapeHtml(roleName(mail.role));
  const logo = escapeHtml(`${mail.appOrigin}/icons/icon-192.png`);
  const title = escapeHtml(subject);
  const rows = [
    detailRow("招待されたアドレス", email, true),
    detailRow("参加後の役割", role, false),
    detailRow("有効期限", `${until} まで`, false),
  ].join("\n");
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${title}</title>
<style>${EMAIL_CSS}</style>
</head>
<body style="margin:0;padding:0;background:#f3f3f5;">
<div class="sen-bg" style="background:#f3f3f5;padding:40px 24px 44px;font-family:${SANS};-webkit-font-smoothing:antialiased;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">Google アカウントでログインすると参加できます。有効期限は ${short} です。</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:520px;margin:0 auto;border-collapse:separate;border-spacing:0;">
<tr>
<td style="padding:0 4px 16px;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0">
<tr>
<td style="vertical-align:middle;">
<img src="${logo}" width="28" height="28" alt="Sen" style="display:block;border:0;border-radius:7px;">
</td>
<td class="sen-text" style="vertical-align:middle;padding-left:9px;font-size:15px;font-weight:600;letter-spacing:-0.01em;color:#1b1c21;">Sen</td>
</tr>
</table>
</td>
</tr>
<tr>
<td class="sen-card" style="background:#ffffff;border:1px solid #e7e7eb;border-radius:12px;padding:32px 36px 28px;">
<p class="sen-text3" style="margin:0 0 10px;font-size:12px;letter-spacing:0.06em;color:#787b84;">ワークスペースへの招待</p>
<h1 class="sen-text" style="margin:0;font-size:22px;line-height:1.45;font-weight:600;letter-spacing:-0.01em;color:#1b1c21;">${workspace}</h1>
<p class="sen-text" style="margin:10px 0 0;font-size:14.5px;line-height:1.75;color:#1b1c21;">${name} さんが、あなたをこのワークスペースに招待しています。</p>
<p class="sen-text2" style="margin:6px 0 0;font-size:13.5px;line-height:1.8;color:#5c5f68;">Sen はチームの課題を管理するアプリです。下のボタンから、Google アカウントでログインして参加できます。</p>
<table class="sen-btn-table" role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;margin-top:24px;">
<tr>
<td class="sen-btn-cell" align="center" style="border-radius:8px;background:#5865e3;">
<a class="sen-btn" href="${link}" style="display:inline-block;padding:13px 28px;font-family:${SANS};font-size:14.5px;font-weight:600;line-height:1.4;color:#ffffff;text-decoration:none;border-radius:8px;">「${workspace}」に参加する</a>
</td>
</tr>
</table>
<table class="sen-sub" role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;margin-top:24px;background:#f7f7f9;border:1px solid #e7e7eb;border-radius:8px;">
<tr>
<td style="padding:14px 16px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">
${rows}
</table>
</td>
</tr>
</table>
<p class="sen-text2" style="margin:14px 0 0;font-size:12.5px;line-height:1.75;color:#5c5f68;">招待されたアドレス（${email}）の Google アカウントでログインしてください。</p>
<div class="sen-rule" style="height:1px;background:#e7e7eb;margin:22px 0 18px;line-height:1px;font-size:0;">&nbsp;</div>
<p class="sen-text3" style="margin:0;font-size:12px;line-height:1.7;color:#787b84;">ボタンが開けない場合は、次のリンクをブラウザに貼り付けてください。</p>
<p style="margin:6px 0 0;font-family:${MONO};font-size:12px;line-height:1.6;word-break:break-all;">
<a class="sen-link" href="${link}" style="color:#4b58d8;text-decoration:none;">${link}</a>
</p>
</td>
</tr>
<tr>
<td class="sen-text3" style="padding:20px 4px 0;font-size:12px;line-height:1.8;color:#787b84;">心当たりがない場合は、このメールを無視してください。招待はそのまま期限切れになります。<br>Sen — 速く、静かに、チームの仕事を前へ。</td>
</tr>
</table>
</div>
</body>
</html>`;
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
    `有効期限は ${expires.full} までです。`,
    `参加後の役割は「${roleName(mail.role)}」です。`,
    "",
    `招待されたメールアドレス（${mail.to}）の Google アカウントでログインしてください。`,
    "",
    "心当たりがない場合は、このメールを無視してください。",
  ].join("\n");
  return { subject, text, html: invitationHtml(mail, subject, expires) };
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
