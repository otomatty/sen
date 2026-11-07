import { createHash, randomBytes } from "node:crypto";
import type { Route } from "playwright";
import { defineScenario } from "../lib/types";

const ISSUE_TITLE = "決済画面の離脱を減らす";
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";
const CALLBACK_ROUTE = "https://claude.ai/**";

export default defineScenario({
  id: "ai",
  order: 15,
  screen: "settings",
  title: "AI ツールとつなぐ",
  summary: "Claude や ChatGPT などの AI ツールから、課題の作成や整理を頼めるようにします。",
  start: "/settings/ai",
  async run(t) {
    await t.page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    await t.expect("[data-testid=ai-connect]");
    await t.caption("設定の「AI 連携」から、Claude や ChatGPT などの AI ツールをつなげます");
    await t.poster();
    await t.settle();

    await t.caption("AI ツールには、この URL を入れるだけです");
    await t.highlight("[data-testid=ai-mcp-url]", 1500);
    await t.click("[data-testid=ai-mcp-url] [data-testid=ai-copy]");
    await t.expect("[data-testid=ai-mcp-url] [data-testid=ai-copy]", { text: "コピーしました" });

    await t.click("[data-testid=ai-client-claude]");
    await t.caption("ツールごとの手順が、ここに出ます");
    await t.expect("[data-testid=ai-client-guide]", { text: "カスタムコネクタ" });
    await t.highlight("[data-testid=ai-client-guide]", 1800);

    const origin = new URL(t.page.url()).origin;
    const connectionsUrl = `/api/ai/connections?ws=${encodeURIComponent(t.ws)}`;
    const before = await t.page.evaluate(async (url) => {
      const res = await fetch(url, { headers: { "x-sen-client": "1" } });
      if (!res.ok) throw new Error("接続一覧を取得できませんでした");
      const body = await res.json() as { grants: { id: string }[] };
      return body.grants.map((grant) => grant.id);
    }, connectionsUrl);
    let code = "";
    let receiveCode!: () => void;
    const codeReceived = new Promise<void>((resolve) => { receiveCode = resolve; });
    const callback = async (route: Route) => {
      const url = new URL(route.request().url());
      if (url.pathname === "/api/mcp/auth_callback" && url.searchParams.has("code")) {
        code = url.searchParams.get("code")!;
        if (code) receiveCode();
      }
      // 204 で Sen の画面を保ち、外部ツールの画面や認証情報を映さない。
      await route.fulfill({ status: 204 });
    };
    try {
      const verifier = randomBytes(32).toString("base64url");
      const challenge = createHash("sha256").update(verifier).digest("base64url");
      const client = await t.page.evaluate(async (redirectUri) => {
        const res = await fetch("/api/oauth/register", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ client_name: "Claude", redirect_uris: [redirectUri], token_endpoint_auth_method: "none" }),
        });
        if (!res.ok) throw new Error("AI ツールを登録できませんでした");
        const body = await res.json() as { client_id: string };
        return { id: body.client_id };
      }, REDIRECT);
      await t.page.route(CALLBACK_ROUTE, callback);
      const params = new URLSearchParams({
        client_id: client.id, redirect_uri: REDIRECT, response_type: "code",
        code_challenge: challenge, code_challenge_method: "S256", scope: "read write",
      });
      await t.page.goto(`${origin}/api/oauth/authorize?${params}`);
      await t.expect("[data-testid=oauth-consent]");
      await t.caption("AI ツールで接続を始めると、Sen の確認画面が開きます");
      await t.expect("[data-testid=oauth-destination]", { text: "claude.ai" });
      // ワークスペースが複数ある場合も、収録中のワークスペースを選ぶ。
      const workspaceId = await t.page.evaluate(async (ws) => {
        const request = new URLSearchParams(location.search).get("request");
        const res = await fetch(`/api/oauth/requests/${encodeURIComponent(request ?? "")}`, { headers: { "x-sen-client": "1" } });
        if (!res.ok) throw new Error("接続のリクエストを取得できませんでした");
        const body = await res.json() as { workspaces: { id: string; urlKey: string }[] };
        const workspace = body.workspaces.find((item) => item.urlKey === ws);
        if (!workspace) throw new Error("接続するワークスペースがありません");
        return workspace.id;
      }, t.ws);
      const workspace = t.page.getByTestId("oauth-workspace");
      if (await workspace.count()) await workspace.selectOption(workspaceId);
      await t.caption("ワークスペースとできることを選んで、「許可する」を押します");
      await t.highlight(t.page.locator("[data-testid=oauth-consent] dl > div").filter({ has: t.page.locator("dt", { hasText: "ワークスペース" }) }), 1300);
      await t.click("[data-testid=oauth-scope-write]");
      await t.highlight("[data-testid=oauth-consent] .ai-scope", 1300);
      await t.highlight("[data-testid=oauth-approve]", 1300);
      await t.click("[data-testid=oauth-approve]");
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("認可コードを受け取れませんでした")), 5000);
        void codeReceived.then(() => {
          clearTimeout(timer);
          resolve();
        });
      });
      await t.expect("[data-testid=oauth-done]");
      await t.page.waitForTimeout(1000);

      // Sen に戻って交換する。コードやトークンは DOM・字幕に入れない。
      await t.goto("/settings/ai");
      const accessToken = await t.page.evaluate(async (args) => {
        const res = await fetch("/api/oauth/token", {
          method: "POST",
          body: new URLSearchParams({ grant_type: "authorization_code", client_id: args.clientId,
            redirect_uri: args.redirectUri, code: args.code, code_verifier: args.verifier }),
        });
        if (!res.ok) throw new Error("トークンを取得できませんでした");
        const body = await res.json() as { access_token: string };
        return body.access_token;
      }, { clientId: client.id, redirectUri: REDIRECT, code, verifier });

      // 同期の応答を先に待ち、届く前に課題を開かない。
      const synced = t.page.waitForResponse(async (res) => {
        if (!res.url().includes("/api/sync") || !res.ok()) return false;
        try {
          const body = (await res.json()) as { changes?: { data?: { title?: string } | null }[] };
          return !!body.changes?.some((change) => change.data?.title === ISSUE_TITLE);
        } catch {
          return false;
        }
      }, { timeout: 20_000 });
      void synced.catch(() => {});
      const issueId = await t.page.evaluate(async (token: string) => {
        const res = await fetch("/api/mcp", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            authorization: "Bearer " + token,
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: {
              name: "create_issues",
              arguments: {
                issues: [
                  {
                    team: "ENG",
                    title: "決済画面の離脱を減らす",
                    priority: "high",
                    assignee: "me",
                    description: "## 目的\n- 購入完了までの離脱を減らす\n- [ ] 計測を入れる\n- [ ] 入力項目を見直す",
                  },
                ],
              },
            },
          }),
        });
        const payload = (await res.json()) as {
          result?: { content?: { text?: string }[]; isError?: boolean };
          error?: { message?: string };
        };
        const result = payload.result;
        if (!result || result.isError) {
          throw new Error(result?.content?.[0]?.text || payload.error?.message || "課題を作成できませんでした");
        }
        const text = result.content?.[0]?.text;
        if (!text) throw new Error("課題の作成結果が空です");
        const created = (JSON.parse(text) as { created?: { id?: string }[] }).created?.[0]?.id;
        if (!created) throw new Error("課題の ID を受け取れませんでした");
        window.dispatchEvent(new Event("focus"));
        return created;
      }, accessToken);
      await synced;

      await t.goto("/settings/ai");
      const row = t.page.getByTestId("ai-connection-row").filter({ hasText: "Claude" }).first();
      await t.expect(row, { text: "Claude" });
      await row.evaluate((el) => el.scrollIntoView({ block: "center" }));
      await t.caption("つないだ AI ツールは、ここに並びます。使わなくなったら解除できます");
      await t.highlight(row, 1800);

      await t.goto(`/issue/${issueId}`);
      await t.expect(`[data-testid=issue-detail][data-identifier="${issueId}"]`, { timeout: 15_000 });
      await t.caption("AI が作った課題や変更には「Claude 経由」の印が付きます");
      await t.expect("[data-testid=issue-description] ul[data-type='taskList']", { text: /計測を入れる[\s\S]*入力項目を見直す/ });
      await t.expect("[data-testid=issue-description] ul[data-type='taskList'] input[type=checkbox]", { count: 2 });
      await t.expect("[data-testid=activity] [data-testid=via-badge]", { text: "Claude 経由" });
      await t.page.locator("[data-testid=activity] [data-testid=via-badge]").first().scrollIntoViewIfNeeded();
      await t.highlight("[data-testid=activity] [data-testid=via-badge]", 1800);
    } finally {
      try {
        // 交換後に失敗した場合も一覧の差分で拾う。戻り先にいても同じ Cookie で片付ける。
        const list = await t.page.request.get(`${origin}${connectionsUrl}`, { headers: { "x-sen-client": "1" } });
        if (!list.ok()) throw new Error("片付け用の接続一覧を取得できませんでした");
        const body = await list.json() as { grants: { id: string; clientName: string }[] };
        for (const grant of body.grants) {
          if (before.includes(grant.id) || grant.clientName !== "Claude") continue;
          const res = await t.page.request.delete(`${origin}/api/ai/connections/${encodeURIComponent(grant.id)}?ws=${encodeURIComponent(t.ws)}`, {
            headers: { "x-sen-client": "1" },
          });
          if (!res.ok()) throw new Error("接続を解除できませんでした");
        }
      } finally {
        await t.page.unroute(CALLBACK_ROUTE, callback);
      }
    }
  },
});
