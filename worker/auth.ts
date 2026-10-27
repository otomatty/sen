import type { Context } from "hono";
import { betterAuth, type BetterAuthPlugin } from "better-auth";
import { APIError, createAuthEndpoint } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import { bearer } from "better-auth/plugins/bearer";
import { AVATAR_COLORS } from "../shared/constants";
import type { Me } from "../shared/types";
import { first, run } from "./db";
import type { AppEnv, Env } from "./env";
import { toMe } from "./serialize";

// ログインは Google のみ（Better Auth）。
// ログインの情報は auth_* テーブル、アプリのプロフィール（表示名・設定など）は users テーブルが持ち、同じ ID で結び付ける。

const SESSION_TTL = 60 * 60 * 24 * 30; // 秒
/** DEV_TOOLS=1 の環境（ローカル開発・テスト・デモ）で BETTER_AUTH_SECRET が無いときだけ使う */
const DEV_SECRET = "sen-local-development-only-secret-0000000000";
/** 開発用ログインで使えるのは、実在しない予約済みドメインのアドレスだけ */
const DEV_EMAIL = /^[^\s@]+@example\.com$/;

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function randomToken(bytes = 32): string {
  return b64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** Better Auth のテーブルも、ほかのテーブルと同じ snake_case の列名にそろえる */
function snakeCase(...fields: string[]): Record<string, string> {
  return Object.fromEntries(fields.map((f) => [f, f.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`)]));
}

export function isGoogleConfigured(env: Env): boolean {
  return !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
}

/**
 * 開発・テスト・動画収録・ブラウザ内デモ用のログイン（DEV_TOOLS=1 のときだけ有効）。
 * Google を通さずに、@example.com のアドレスでログインする。
 */
function devSignIn(env: Env): BetterAuthPlugin {
  return {
    id: "sen-dev-sign-in",
    endpoints: {
      devSignIn: createAuthEndpoint("/dev/sign-in", { method: "POST" }, async (ctx) => {
        const body = (ctx.body ?? {}) as { email?: unknown; name?: unknown };
        const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
        if (!DEV_EMAIL.test(email)) throw new APIError("BAD_REQUEST", { message: "開発用のログインには @example.com のアドレスを使ってください" });
        const name = typeof body.name === "string" && body.name.trim() ? body.name.trim() : email.split("@")[0];
        const found = await ctx.context.internalAdapter.findUserByEmail(email);
        const user = found?.user ?? (await ctx.context.internalAdapter.createUser({ email, name, emailVerified: true }, { method: "dev-sign-in" }));
        const session = await ctx.context.internalAdapter.createSession(user.id);
        await setSessionCookie(ctx, { session, user });
        // ブラウザ内デモは Cookie を使えないので、Authorization: Bearer 用にトークンを返す
        return ctx.json(env.DEMO_MODE === "1" ? { token: session.token } : {});
      }),
    },
  };
}

function createAuth(env: Env, baseURL: string) {
  const dev = env.DEV_TOOLS === "1";
  const secret = env.BETTER_AUTH_SECRET || (dev ? DEV_SECRET : undefined);
  if (!secret) throw new Error("BETTER_AUTH_SECRET が設定されていません（bunx wrangler secret put BETTER_AUTH_SECRET）");
  return betterAuth({
    appName: "Sen",
    baseURL,
    basePath: "/api/auth",
    secret,
    database: env.DB,
    telemetry: { enabled: false },
    emailAndPassword: { enabled: false },
    socialProviders: isGoogleConfigured(env)
      ? { google: { clientId: env.GOOGLE_CLIENT_ID!, clientSecret: env.GOOGLE_CLIENT_SECRET!, prompt: "select_account" } }
      : {},
    user: { modelName: "auth_users", fields: snakeCase("emailVerified", "createdAt", "updatedAt") },
    session: {
      modelName: "auth_sessions",
      fields: snakeCase("userId", "expiresAt", "ipAddress", "userAgent", "createdAt", "updatedAt"),
      expiresIn: SESSION_TTL,
    },
    account: {
      modelName: "auth_accounts",
      fields: snakeCase(
        "userId",
        "accountId",
        "providerId",
        "accessToken",
        "refreshToken",
        "idToken",
        "accessTokenExpiresAt",
        "refreshTokenExpiresAt",
        "createdAt",
        "updatedAt",
      ),
      // 以前のメール + パスワードのアカウント（メールアドレスは未確認）にも、
      // Google が確認した同じアドレスでログインすれば結び付ける
      accountLinking: { requireLocalEmailVerified: false },
    },
    verification: { modelName: "auth_verifications", fields: snakeCase("expiresAt", "createdAt", "updatedAt") },
    // ログインに失敗したら、ログイン画面で理由を表示する（/login?error=...）
    onAPIError: { errorURL: "/login" },
    advanced: {
      cookiePrefix: "sen",
      database: { generateId: () => crypto.randomUUID() },
      ipAddress: { ipAddressHeaders: ["cf-connecting-ip", "x-forwarded-for"] },
    },
    plugins: [...(dev ? [devSignIn(env)] : []), ...(env.DEMO_MODE === "1" ? [bearer()] : [])],
  });
}

type Auth = ReturnType<typeof createAuth>;

// Better Auth はスキーマの確認などを最初の 1 回だけ行うので、インスタンスを使い回す
const instances = new WeakMap<Env, Map<string, Auth>>();

export function getAuth(c: Context<AppEnv>): Auth {
  const baseURL = c.env.BETTER_AUTH_URL || new URL(c.req.url).origin;
  let byUrl = instances.get(c.env);
  if (!byUrl) instances.set(c.env, (byUrl = new Map()));
  let auth = byUrl.get(baseURL);
  if (!auth) byUrl.set(baseURL, (auth = createAuth(c.env, baseURL)));
  return auth;
}

/** ログイン中のユーザー。初めてログインしたときは、アプリのプロフィールを作る */
export async function getSessionUser(c: Context<AppEnv>): Promise<Me | null> {
  const { headers, response } = await getAuth(c).api.getSession({ headers: c.req.raw.headers, returnHeaders: true });
  // セッションの期限を延ばした・消したときの Cookie をそのまま返す
  for (const cookie of headers.getSetCookie()) c.header("set-cookie", cookie, { append: true });
  if (!response) return null;
  const { user } = response;
  const select = () => first<Record<string, unknown>>(c.env.DB, "SELECT * FROM users WHERE id = ?", user.id);
  let row = await select();
  if (!row) {
    const now = Date.now();
    await run(
      c.env.DB,
      "INSERT OR IGNORE INTO users (id, email, name, avatar_color, settings, created_at, updated_at) VALUES (?, ?, ?, ?, '{}', ?, ?)",
      user.id,
      user.email,
      (user.name.trim() || user.email.split("@")[0]).slice(0, 40),
      AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)],
      now,
      now,
    );
    row = await select();
  }
  // 同じメールアドレスのプロフィールが別の ID で既にある（users と auth_users の ID がずれている）
  if (!row) throw new Error(`ログイン中のユーザー（${user.email}）のプロフィールを作成できませんでした`);
  return toMe(row);
}
