// Google Sheets API（サービスアカウントの JWT 認証と batchUpdate）。
// fetch と crypto.subtle だけを使う。鍵・JWT・アクセストークンはログにもエラーにも出さない。

const SCOPE = "https://www.googleapis.com/auth/spreadsheets";
const KEY_ERROR = "サービスアカウントの鍵を読み取れません（GOOGLE_SERVICE_ACCOUNT_KEY を確認してください）";
const AUTH_ERROR = "サービスアカウントの認証に失敗しました（鍵を確認してください）";
const API_DISABLED_ERROR =
  "Google Sheets API が有効になっていません。サービスアカウントの Google Cloud プロジェクトで Google Sheets API を有効にしてください";

export class SheetsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SheetsError";
  }
}

export interface ServiceAccountKey {
  clientEmail: string;
  privateKey: string;
}

interface CachedToken {
  token: string;
  /** この時刻まで使い回す（レスポンスの期限の 60 秒前） */
  exp: number;
  clientEmail: string;
}

/** キーは clientEmail + tokenUrl。同じワーカー内では期限の 60 秒前まで使い回す */
const tokenCache = new Map<string, CachedToken>();

export function parseServiceAccountKey(raw: string): ServiceAccountKey {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new SheetsError(KEY_ERROR);
  }
  if (!parsed || typeof parsed !== "object") throw new SheetsError(KEY_ERROR);
  const record = parsed as { client_email?: unknown; private_key?: unknown };
  if (typeof record.client_email !== "string" || !record.client_email.trim()) throw new SheetsError(KEY_ERROR);
  if (typeof record.private_key !== "string" || !record.private_key.trim()) throw new SheetsError(KEY_ERROR);
  return { clientEmail: record.client_email.trim(), privateKey: record.private_key };
}

/** RS256 の JWT でアクセストークンを取る。期限の 60 秒前まではキャッシュする */
export async function getAccessToken(key: ServiceAccountKey, tokenUrl: string, now: number): Promise<string> {
  const cacheId = `${key.clientEmail}\n${tokenUrl}`;
  const cached = tokenCache.get(cacheId);
  if (cached && cached.exp > now) return cached.token;
  try {
    const assertion = await signJwt(key, tokenUrl, now);
    const token = await requestToken(tokenUrl, assertion);
    const ttlMs = (token.expiresIn ?? 3600) * 1000 - 60_000;
    tokenCache.set(cacheId, { token: token.accessToken, exp: now + Math.max(0, ttlMs), clientEmail: key.clientEmail });
    return token.accessToken;
  } catch (e) {
    if (e instanceof SheetsError) throw e;
    throw new SheetsError(AUTH_ERROR);
  }
}

/**
 * スプレッドシートのタブ一覧。
 * clientEmail は 403 の案内に使う（省略時はトークンのキャッシュから引く）。
 */
export async function getSheets(
  base: string,
  spreadsheetId: string,
  token: string,
  clientEmail = "",
): Promise<{ sheetId: number; title: string }[]> {
  const url = `${base}/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}?fields=sheets.properties`;
  const res = await sheetsFetch(url, token, clientEmail, { headers: { authorization: `Bearer ${token}` } });
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new SheetsError("Google Sheets API でエラーが発生しました（応答を読み取れませんでした）");
  }
  const sheets = (body as { sheets?: { properties?: { sheetId?: unknown; title?: unknown } }[] }).sheets ?? [];
  const out: { sheetId: number; title: string }[] = [];
  for (const sheet of sheets) {
    const id = sheet.properties?.sheetId;
    const title = sheet.properties?.title;
    if (typeof id === "number" && typeof title === "string") out.push({ sheetId: id, title });
  }
  return out;
}

/** spreadsheets.batchUpdate。clientEmail は 403 の案内に使う */
export async function batchUpdate(
  base: string,
  spreadsheetId: string,
  token: string,
  requests: object[],
  clientEmail = "",
): Promise<void> {
  const url = `${base}/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}:batchUpdate`;
  const res = await sheetsFetch(url, token, clientEmail, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ requests }),
  });
  await discard(res);
}

async function signJwt(key: ServiceAccountKey, tokenUrl: string, now: number): Promise<string> {
  const iat = Math.floor(now / 1000);
  const header = base64urlJson({ alg: "RS256", typ: "JWT" });
  const claims = base64urlJson({
    iss: key.clientEmail,
    scope: SCOPE,
    aud: tokenUrl,
    iat,
    exp: iat + 3600,
  });
  const unsigned = `${header}.${claims}`;
  const cryptoKey = await crypto.subtle.importKey(
    "pkcs8",
    pemToPkcs8(key.privateKey),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", cryptoKey, new TextEncoder().encode(unsigned));
  return `${unsigned}.${base64url(new Uint8Array(signature))}`;
}

async function requestToken(tokenUrl: string, assertion: string): Promise<{ accessToken: string; expiresIn?: number }> {
  let res: Response;
  try {
    res = await fetch(tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }),
      cache: "no-store",
    });
  } catch {
    throw new SheetsError(AUTH_ERROR);
  }
  if (!res.ok) {
    await discard(res);
    throw new SheetsError(AUTH_ERROR);
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new SheetsError(AUTH_ERROR);
  }
  const accessToken = (body as { access_token?: unknown }).access_token;
  const expiresIn = (body as { expires_in?: unknown }).expires_in;
  if (typeof accessToken !== "string" || !accessToken) throw new SheetsError(AUTH_ERROR);
  return { accessToken, expiresIn: typeof expiresIn === "number" ? expiresIn : undefined };
}

/**
 * 403 の本文から案内を決める。
 * API が無効（message の "has not been used" / "is disabled"、または details の SERVICE_DISABLED）なら有効化の案内。
 * それ以外と、本文を判別できないときは共有の案内。鍵・トークンはメッセージに含めない。
 */
export function forbiddenMessage(body: unknown, clientEmail: string): string {
  if (isSheetsApiDisabled(body)) return API_DISABLED_ERROR;
  return `スプレッドシートに書き込めません。サービスアカウント（${clientEmail}）を編集者として共有してください`;
}

function isSheetsApiDisabled(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  const error = (body as { error?: unknown }).error;
  if (!error || typeof error !== "object") return false;
  const message = (error as { message?: unknown }).message;
  if (typeof message === "string" && (message.includes("has not been used") || message.includes("is disabled"))) return true;
  const details = (error as { details?: unknown }).details;
  if (!Array.isArray(details)) return false;
  return details.some((detail) => {
    if (!detail || typeof detail !== "object") return false;
    return (detail as { reason?: unknown }).reason === "SERVICE_DISABLED";
  });
}

/** シートの取得・書き込み。トークン取得の失敗とはメッセージを分ける */
async function sheetsFetch(url: string, token: string, clientEmail: string, init: RequestInit): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, cache: "no-store" });
  } catch {
    throw new SheetsError("Google に接続できませんでした");
  }
  if (res.ok) return res;
  throw await sheetsHttpError(res, token, clientEmail);
}

async function sheetsHttpError(res: Response, token: string, clientEmail: string): Promise<SheetsError> {
  if (res.status === 403) {
    const email = clientEmail || emailForToken(token);
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      await discard(res);
    }
    return new SheetsError(forbiddenMessage(body, email));
  }
  if (res.status === 404) {
    await discard(res);
    return new SheetsError("スプレッドシートが見つかりません（SHEETS_SPREADSHEET_ID を確認してください）");
  }
  const detail = await googleErrorDetail(res);
  return new SheetsError(`Google Sheets API でエラーが発生しました（${res.status}）: ${detail}`);
}

/** 本文はエラーメッセージに使わない。捨てるのに失敗しても、呼び出し側のエラーは維持する */
async function discard(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    // 無視
  }
}

function emailForToken(token: string): string {
  for (const entry of tokenCache.values()) {
    if (entry.token === token) return entry.clientEmail;
  }
  return "";
}

async function googleErrorDetail(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: { message?: unknown } | string };
    const raw = typeof body.error === "string" ? body.error : body.error?.message;
    if (typeof raw !== "string") return "";
    return clip(redactSecrets(raw), 200);
  } catch {
    return "";
  }
}

/** 応答に鍵やトークンが紛れていても、利用者に見えるメッセージへは出さない */
function redactSecrets(text: string): string {
  return text
    .replace(/ya29\.[A-Za-z0-9_\-]+/g, "…")
    .replace(/eyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+/g, "…")
    .replace(/-----BEGIN[\s\S]*?-----END[^-]*-----/g, "…");
}

function clip(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : chars.slice(0, max).join("");
}

function pemToPkcs8(pem: string): ArrayBuffer {
  const b64 = pem.replace(/-----BEGIN [^-]+-----/g, "").replace(/-----END [^-]+-----/g, "").replace(/\s+/g, "");
  const binary = atob(b64);
  const buffer = new ArrayBuffer(binary.length);
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return buffer;
}

function base64urlJson(value: object): string {
  return base64url(new TextEncoder().encode(JSON.stringify(value)));
}

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
