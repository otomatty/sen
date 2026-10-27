import type { Context } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { first, run } from "./db";
import type { AppEnv } from "./env";
import { toMe } from "./serialize";
import type { Me } from "../shared/types";

const enc = new TextEncoder();
// Workers の PBKDF2 は 100,000 回が上限
const ITERATIONS = 100_000;
export const SESSION_COOKIE = "sen_session";
const SESSION_TTL = 1000 * 60 * 60 * 24 * 30;

function b64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
function unb64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function b64url(bytes: Uint8Array): string {
  return b64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations },
    key,
    256,
  );
  return new Uint8Array(bits);
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(password, salt, ITERATIONS);
  return `pbkdf2$${ITERATIONS}$${b64(salt)}$${b64(hash)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [algo, iter, saltB64, hashB64] = stored.split("$");
  if (algo !== "pbkdf2" || !iter || !saltB64 || !hashB64) return false;
  const expected = unb64(hashB64);
  const actual = await pbkdf2(password, unb64(saltB64), Number(iter));
  if (actual.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < actual.length; i++) diff |= actual[i] ^ expected[i];
  return diff === 0;
}

async function sha256Hex(s: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s)));
  return [...d].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function randomToken(bytes = 32): string {
  return b64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function createSession(c: Context<AppEnv>, userId: string): Promise<string> {
  const token = randomToken();
  const now = Date.now();
  await run(
    c.env.DB,
    "INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)",
    await sha256Hex(token),
    userId,
    now + SESSION_TTL,
    now,
  );
  const secure = new URL(c.req.url).protocol === "https:";
  setCookie(c, SESSION_COOKIE, token, {
    path: "/",
    httpOnly: true,
    sameSite: "Lax",
    secure,
    maxAge: SESSION_TTL / 1000,
  });
  return token;
}

function readToken(c: Context<AppEnv>): string | undefined {
  const cookie = getCookie(c, SESSION_COOKIE);
  if (cookie) return cookie;
  if (c.env.DEMO_MODE === "1") {
    const h = c.req.header("authorization");
    if (h?.startsWith("Bearer ")) return h.slice(7);
  }
  return undefined;
}

export async function getSessionUser(c: Context<AppEnv>): Promise<Me | null> {
  const token = readToken(c);
  if (!token) return null;
  const row = await first<Record<string, unknown>>(
    c.env.DB,
    `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ? AND s.expires_at > ?`,
    await sha256Hex(token),
    Date.now(),
  );
  return row ? toMe(row) : null;
}

export async function destroySession(c: Context<AppEnv>): Promise<void> {
  const token = readToken(c);
  if (token) await run(c.env.DB, "DELETE FROM sessions WHERE id = ?", await sha256Hex(token));
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
}
