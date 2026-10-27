// Sen のサービスワーカー
// アプリ本体（HTML・JS・CSS・フォント）を保存しておき、オフラインでも起動できるようにする。
// データは IndexedDB のキャッシュから表示され、変更は接続が戻ったときに送信される。
// API と使い方動画はキャッシュしない。

const CACHE = "sen-shell-v1";

async function precache() {
  const cache = await caches.open(CACHE);
  const res = await fetch("/", { cache: "no-store" });
  if (!res.ok) return;
  const html = await res.clone().text();
  await cache.put("/", res);
  const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((m) => m[1]);
  await Promise.all(
    [...new Set(["/favicon.svg", "/manifest.webmanifest", ...assets])].map((url) =>
      cache.add(url).catch(() => {
        // 取得できないものは次回に回す
      }),
    ),
  );
}

self.addEventListener("install", (event) => {
  event.waitUntil(precache().catch(() => {}));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/tutorials/")) return;

  // 画面の移動：まずネットワーク、だめなら保存しておいた HTML
  if (req.mode === "navigate") {
    event.respondWith(
      (async () => {
        try {
          const res = await fetch(req);
          if (res.ok) {
            const cache = await caches.open(CACHE);
            cache.put("/", res.clone());
          }
          return res;
        } catch {
          const cached = await caches.match("/");
          return cached ?? Response.error();
        }
      })(),
    );
    return;
  }

  // ビルド済みのファイル（名前にハッシュ入り）：保存済みならそれを使う
  if (url.pathname.startsWith("/assets/") || url.pathname === "/favicon.svg" || url.pathname === "/manifest.webmanifest") {
    event.respondWith(
      (async () => {
        const cached = await caches.match(req);
        if (cached) return cached;
        const res = await fetch(req);
        if (res.ok) (await caches.open(CACHE)).put(req, res.clone());
        return res;
      })(),
    );
  }
});
