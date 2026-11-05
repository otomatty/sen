// メールアドレスと、ワークスペースで利用できるドメインの判定。画面とサーバーの両方で使う。

/** 前後の空白を除き、小文字にする */
export function normalizeEmail(s: string): string {
  return s.trim().toLowerCase();
}

/** 最後の @ より後ろ（小文字）。@ が無ければ空文字 */
export function emailDomain(email: string): string {
  const at = email.lastIndexOf("@");
  return at >= 0 ? email.slice(at + 1).toLowerCase() : "";
}

const DOMAIN_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** 前後の空白と先頭の @ を除き、小文字にする */
export function normalizeDomain(s: string): string {
  return s.trim().toLowerCase().replace(/^@+/, "");
}

export function isValidDomain(s: string): boolean {
  return DOMAIN_RE.test(s);
}

/**
 * local@domain の形で、254 文字以内。
 * domain は isValidDomain（小文字）を満たす。先に normalizeEmail してから使う。
 */
export function isValidEmail(s: string): boolean {
  if (s.length > 254) return false;
  const at = s.indexOf("@");
  if (at <= 0 || at !== s.lastIndexOf("@")) return false;
  const local = s.slice(0, at);
  if (!local || /\s/.test(s)) return false;
  return isValidDomain(s.slice(at + 1));
}

/** JSON 配列を読む。壊れている・配列でないときは [] */
export function parseAllowedDomains(json: string | null | undefined): string[] {
  if (typeof json !== "string" || !json) return [];
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is string => typeof x === "string");
  } catch {
    return [];
  }
}

/**
 * domains が空なら誰でも可。
 * そうでなければメールのドメインが domains のどれかと完全一致する（サブドメインは含めない）。
 */
export function isEmailAllowed(email: string, domains: string[]): boolean {
  if (domains.length === 0) return true;
  return domains.includes(emailDomain(email));
}

export const MAX_ALLOWED_DOMAINS = 20;

/** ローカル部は先頭 1 文字だけ残す（例: t***@example.com） */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at < 0) {
    const head = email.slice(0, 1);
    return head ? `${head}***` : "***";
  }
  return `${email.slice(0, at).slice(0, 1)}***@${email.slice(at + 1)}`;
}
