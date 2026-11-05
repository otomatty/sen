// Webhook の署名と「設定が揃っているか」。
// ブラウザを使わないテストから読むため、db や env は import しない（WebCrypto だけ使う）。

export interface GitHubWebhookEnv {
  GITHUB_WORKSPACE?: string;
  GITHUB_TOKEN?: string;
  GITHUB_WEBHOOK_SECRET?: string;
  REALTIME?: unknown;
}

/** WORKSPACE・TOKEN・WEBHOOK_SECRET と REALTIME が揃っているか。githubConfig と同じ条件 */
export function githubWebhookReady(env: GitHubWebhookEnv): boolean {
  return Boolean(env.GITHUB_WORKSPACE?.trim() && env.GITHUB_TOKEN?.trim() && env.GITHUB_WEBHOOK_SECRET?.trim() && env.REALTIME);
}

/**
 * 設定が無ければ 503、署名が無いか違うなら 401。
 * 通ったときは本文を返す（この先の処理は DB を使う）。
 */
export async function acceptGitHubWebhook(request: Request, env: GitHubWebhookEnv): Promise<Response | { raw: string }> {
  if (!githubWebhookReady(env)) {
    return Response.json({ error: "GitHub 連携は設定されていません" }, { status: 503 });
  }
  const raw = await request.text();
  const signature = request.headers.get("x-hub-signature-256");
  if (!(await verifyGitHubSignature(env.GITHUB_WEBHOOK_SECRET!.trim(), raw, signature))) {
    return Response.json({ error: "署名が正しくありません" }, { status: 401 });
  }
  return { raw };
}

export async function verifyGitHubSignature(secret: string, body: string, header: string | null): Promise<boolean> {
  if (!header) return false;
  const match = /^sha256=([0-9a-fA-F]+)$/.exec(header.trim());
  if (!match) return false;
  const actual = match[1].toLowerCase();
  const expected = await hmacHex(secret, body);
  return timingSafeEqual(expected, actual);
}

/** テストが Webhook と同じ署名を作るために使う */
export async function githubSignature(secret: string, body: string): Promise<string> {
  return `sha256=${await hmacHex(secret, body)}`;
}

async function hmacHex(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** 長さが違うときは false。同じ長さのときだけ全文字を比べる */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
