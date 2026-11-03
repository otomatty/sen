import type { Page } from "playwright";
import { defineScenario } from "../lib/types";

const ISSUE_TITLE = "決済画面の離脱を減らす";

export default defineScenario({
  id: "ai",
  order: 15,
  screen: "settings",
  title: "AI ツールとつなぐ",
  summary: "Claude Code や Cursor から、AI に課題の作成や整理を頼めるようにします。",
  start: "/settings/ai",
  async run(t) {
    await t.page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    await t.expect("[data-testid=ai-connect]");
    await t.caption("設定の「AI 連携」から、Claude Code や Cursor などの AI ツールをつなげます");
    await t.poster();
    await t.settle();

    await t.caption("使う AI ツールと、任せる範囲を選びます");
    await t.expect("[data-testid=ai-client-claude-code]");
    await t.highlight("[data-testid=ai-client-claude-code]", 1300);
    await t.expect("[data-testid=ai-scope-write]");
    await t.highlight("[data-testid=ai-scope-write]", 1300);

    await t.caption("トークンを発行すると、設定用のコマンドが表示されます");
    await t.click("[data-testid=ai-token-create]");

    // 発行した直後から、成功でも失敗でもトークンを無効にする。
    // 失敗時は画面のトークンを伏せてから投げ直し、収録のスクリーンショットに残さない。
    let issuedToken = "";
    let revoked = false;
    let failed = false;
    try {
      await t.expect("[data-testid=ai-issued]");
      await t.expect("[data-testid=ai-issued] code", { text: "claude mcp add" });
      try {
        issuedToken = await readIssuedToken(t.page);
      } catch (readErr) {
        console.error(readErr);
      }

      await t.caption("ターミナルでこのコマンドを実行すれば、準備は完了です");
      await t.page.locator(".code-block").first().scrollIntoViewIfNeeded();
      await t.highlight(".code-block", 1400);
      await t.click("[data-testid=ai-copy]");
      await t.expect("[data-testid=ai-copy]", { text: "コピーしました" });

      await t.caption("あとは AI に話しかけるだけです");
      await t.expect(".ai-prompts", { text: "課題として登録して" });
      await t.page.locator(".ai-prompts").scrollIntoViewIfNeeded();
      await t.highlight(".ai-prompts", 1500);

      // 表示中のコマンドからトークンを読み、AI ツールと同じ MCP で課題を作る。
      // 同期の応答を先に待ち、届く前に課題を開いて「見つかりません」と出さない。
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
      const createdIssue = await t.page.evaluate(async () => {
        const command = document.querySelector("[data-testid=ai-issued] code")?.textContent ?? "";
        const token = command.match(/sen_[A-Za-z0-9_-]{43}/)?.[0] ?? "";
        if (token.length !== 47) throw new Error("表示されたコマンドからトークンを読み取れませんでした");
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
        return { issueId: created, token };
      });
      issuedToken = createdIssue.token;
      await synced;
      const { issueId, token } = createdIssue;

      await t.caption("使わなくなったトークンは、ここから無効にできます");
      await t.click("[data-testid=ai-issued-done]", { pause: 700 });
      await t.expect("[data-testid=ai-issued]", { hidden: true });
      await t.expect("[data-testid=confirm-dialog]", { count: 0 });
      await t.expect("[data-testid=ai-token-row]", { text: "Claude Code" });
      await t.page.locator("[data-testid=ai-token-row]").first().scrollIntoViewIfNeeded();
      await t.highlight("[data-testid=ai-token-row]", 1600);
      const hint = `sen_…${token.slice(-4)}`;
      await t.click(t.page.locator("[data-testid=ai-token-row]", { hasText: hint }).getByTestId("ai-token-revoke"));
      await t.click("[data-testid=confirm-ok]");
      await t.expect(t.page.locator("[data-testid=ai-token-row]", { hasText: hint }), { count: 0 });
      await t.expect("[data-testid=toast]", { text: "トークンを無効にしました" });
      await t.page.evaluate(async (secret: string) => {
        const res = await fetch("/api/mcp", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            authorization: "Bearer " + secret,
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {
              protocolVersion: "2025-03-26",
              capabilities: {},
              clientInfo: { name: "tutorial", version: "1.0.0" },
            },
          }),
        });
        if (res.status !== 401) throw new Error(`無効にしたトークンが拒否されませんでした（${res.status}）`);
      }, token);
      revoked = true;

      await t.goto(`/issue/${issueId}`);
      await t.expect(`[data-testid=issue-detail][data-identifier="${issueId}"]`, { timeout: 15_000 });
      await t.caption("AI が作った課題や変更には「Claude Code 経由」の印が付きます");
      await t.expect("[data-testid=issue-description] ul[data-type='taskList']", { text: /計測を入れる[\s\S]*入力項目を見直す/ });
      await t.expect("[data-testid=issue-description] ul[data-type='taskList'] input[type=checkbox]", { count: 2 });
      await t.expect("[data-testid=activity] [data-testid=via-badge]", { text: "Claude Code 経由" });
      await t.page.locator("[data-testid=activity] [data-testid=via-badge]").first().scrollIntoViewIfNeeded();
      await t.highlight("[data-testid=activity] [data-testid=via-badge]", 1800);
    } catch (e) {
      failed = true;
      if (!issuedToken) {
        try {
          issuedToken = await readIssuedToken(t.page);
        } catch (readErr) {
          console.error(readErr);
        }
      }
      try {
        await maskIssuedTokens(t.page);
      } catch (maskErr) {
        console.error(maskErr);
      }
      throw e;
    } finally {
      if (!revoked && issuedToken) {
        try {
          await revokeIssuedToken(t.page, issuedToken);
        } catch (cleanupErr) {
          console.error(cleanupErr);
        }
      }
      // 無効化の通信で画面が描き直されても、スクリーンショットの前にもう一度伏せる
      if (failed) {
        try {
          await maskIssuedTokens(t.page);
        } catch (maskErr) {
          console.error(maskErr);
        }
      }
    }
  },
});

/** 画面に出ている sen_ で始まる 47 文字を sen_… に置き換える */
async function maskIssuedTokens(page: Page) {
  await page.evaluate(() => {
    const re = /sen_[A-Za-z0-9_-]{43}/g;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node) {
      const text = node.textContent ?? "";
      const next = text.replace(re, "sen_…");
      re.lastIndex = 0;
      if (next !== text) node.textContent = next;
      node = walker.nextNode();
    }
  });
}

/** 表示中のコマンドなどから、発行したトークンを読む */
async function readIssuedToken(page: Page): Promise<string> {
  return page.evaluate(() => {
    const re = /sen_[A-Za-z0-9_-]{43}/;
    const code = document.querySelector("[data-testid=ai-issued] code")?.textContent ?? "";
    const fromCode = code.match(re)?.[0];
    if (fromCode) return fromCode;
    const parts: string[] = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node) {
      parts.push(node.textContent ?? "");
      node = walker.nextNode();
    }
    return parts.join("").match(re)?.[0] ?? "";
  });
}

/** 画面のログインのまま、末尾 4 文字が一致するトークンを API で無効にする */
async function revokeIssuedToken(page: Page, secret: string) {
  await page.evaluate(async (issued: string) => {
    const match = location.pathname.match(/^\/([^/]+)\/settings\/ai\/?$/);
    if (!match) throw new Error("ワークスペースのキーを URL から取れませんでした");
    const ws = decodeURIComponent(match[1]);
    const hint = issued.slice(-4);
    const headers = { "x-sen-client": "1" };
    const listRes = await fetch(`/api/tokens?ws=${encodeURIComponent(ws)}`, { headers, credentials: "same-origin" });
    if (!listRes.ok) throw new Error(`トークン一覧の取得に失敗しました（${listRes.status}）`);
    const body = (await listRes.json()) as { tokens?: { id?: string; hint?: string }[] };
    const ids = (body.tokens ?? []).flatMap((item) => (item.hint === hint && item.id ? [item.id] : []));
    for (const id of ids) {
      const delRes = await fetch(`/api/tokens/${encodeURIComponent(id)}?ws=${encodeURIComponent(ws)}`, {
        method: "DELETE",
        headers,
        credentials: "same-origin",
      });
      if (!delRes.ok) throw new Error(`トークンの無効化に失敗しました（${delRes.status}）`);
    }
  }, secret);
}
