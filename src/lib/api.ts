import type { AttachmentUploadResponse } from "../../shared/types";

export class ApiError extends Error {
  status: number;
  code?: string;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

// 本番では window.fetch、ブラウザ内デモではブラウザ内バックエンドに差し替える
let transport: FetchLike = (input, init) => fetch(input, init);
let bearer: string | null = null;
let currentUserId: string | null = null;
let accountSwitchedHandler: (() => void) | null = null;

export function setTransport(fn: FetchLike) {
  transport = fn;
}
export function setBearerToken(token: string | null) {
  bearer = token;
}

/** 画面が今見ている利用者。リクエストに載せ、別タブで切り替わっていたらサーバーが止める */
export function setCurrentUserId(id: string | null) {
  currentUserId = id;
}

/** サーバーが「別のアカウントに切り替わった」と返したとき（画面の読み込み直しなど） */
export function setAccountSwitchedHandler(fn: (() => void) | null) {
  accountSwitchedHandler = fn;
}

export async function api<T>(path: string, opts: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  const headers: Record<string, string> = { "x-sen-client": "1" };
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  if (currentUserId) headers["x-sen-user"] = currentUserId;
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
    const body = data as { error?: string; message?: string; code?: string } | null;
    if (res.status === 409 && body?.code === "account-switched") accountSwitchedHandler?.();
    const msg = body?.error ?? body?.message ?? `エラーが発生しました (${res.status})`;
    throw new ApiError(msg, res.status, body?.code);
  }
  return data as T;
}

/** NDJSON など、本文を呼び出し側で読む POST。ヘッダーと transport は api() と同じ */
export async function apiStream(path: string, body: unknown, signal?: AbortSignal): Promise<Response> {
  const headers: Record<string, string> = { "x-sen-client": "1", "content-type": "application/json" };
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  if (currentUserId) headers["x-sen-user"] = currentUserId;
  let res: Response;
  try {
    res = await transport(path, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      credentials: "same-origin",
      signal,
    });
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    throw new ApiError("ネットワークに接続できません", 0);
  }
  if (!res.ok) {
    let data: unknown = null;
    try {
      data = await res.json();
    } catch {
      // 本文なし
    }
    const body = data as { error?: string; code?: string } | null;
    const code = body?.code;
    if (res.status === 409 && code === "account-switched") accountSwitchedHandler?.();
    const msg = body?.error ?? `エラーが発生しました (${res.status})`;
    throw new ApiError(msg, res.status, code);
  }
  return res;
}

/** ファイルそのものを送り、送信の進み具合を通知する */
export function uploadAttachment(
  wsKey: string,
  file: File,
  opts: { onProgress?: (ratio: number) => void; signal?: AbortSignal },
): Promise<AttachmentUploadResponse> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const cleanup = () => opts.signal?.removeEventListener("abort", abort);
    const aborted = () => {
      cleanup();
      reject(new DOMException("添付を取り消しました", "AbortError"));
    };
    const abort = () => {
      xhr.abort();
      aborted();
    };
    if (opts.signal?.aborted) {
      aborted();
      return;
    }
    xhr.open("POST", `/api/files?ws=${encodeURIComponent(wsKey)}`);
    xhr.setRequestHeader("x-sen-client", "1");
    if (currentUserId) xhr.setRequestHeader("x-sen-user", currentUserId);
    if (bearer) xhr.setRequestHeader("authorization", `Bearer ${bearer}`);
    xhr.setRequestHeader("x-sen-filename", encodeURIComponent(file.name));
    xhr.setRequestHeader("content-type", file.type || "application/octet-stream");
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) opts.onProgress?.(event.loaded / event.total);
    };
    xhr.onload = () => {
      cleanup();
      let data: AttachmentUploadResponse & { error?: string; code?: string } | null = null;
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        // 本文なし
      }
      if (xhr.status >= 200 && xhr.status < 300 && data) resolve(data);
      else {
        if (xhr.status === 409 && data?.code === "account-switched") accountSwitchedHandler?.();
        reject(new ApiError(data?.error ?? `エラーが発生しました (${xhr.status})`, xhr.status, data?.code));
      }
    };
    xhr.onerror = () => {
      cleanup();
      reject(new ApiError("ネットワークに接続できません", 0));
    };
    xhr.onabort = aborted;
    opts.signal?.addEventListener("abort", abort, { once: true });
    xhr.send(file);
  });
}
