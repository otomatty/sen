export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

// 本番では window.fetch、ブラウザ内デモではブラウザ内バックエンドに差し替える
let transport: FetchLike = (input, init) => fetch(input, init);
let bearer: string | null = null;

export function setTransport(fn: FetchLike) {
  transport = fn;
}
export function setBearerToken(token: string | null) {
  bearer = token;
}

export async function api<T>(path: string, opts: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  const headers: Record<string, string> = { "x-sen-client": "1" };
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  let res: Response;
  try {
    res = await transport(path, {
      method: opts.method ?? (opts.body !== undefined ? "POST" : "GET"),
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      credentials: "same-origin",
      signal: opts.signal,
    });
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    throw new ApiError("ネットワークに接続できません", 0);
  }
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    // 本文なし
  }
  if (!res.ok) {
    // アプリの API は { error }、Better Auth（/api/auth/*）は { message } でエラーを返す
    const body = data as { error?: string; message?: string } | null;
    const msg = body?.error ?? body?.message ?? `エラーが発生しました (${res.status})`;
    throw new ApiError(msg, res.status);
  }
  return data as T;
}
