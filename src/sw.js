// Sen のサービスワーカー（ビルド時に vite.config.ts が版とファイルの一覧を埋め込み、sw.js として書き出す）
// アプリ本体（HTML・JS・CSS・フォント・アイコン）をインストール時にまとめて保存し、オフラインでも起動できるようにする。
// データは IndexedDB のキャッシュから表示され、変更は接続が戻ったときに送信される。
// API と使い方動画はキャッシュしない。
// 新しい版は裏で保存しておき、画面の「更新」を押したとき（またはアプリをすべて閉じたとき）に切り替える。

const VERSION = __SEN_SW_VERSION__;
const PRECACHE = __SEN_SW_PRECACHE__;
const CACHE = `sen-${VERSION}`;
const PRECACHED = new Set(PRECACHE);
// 画面を開くとき、通信がこれより遅ければ保存しておいた版で先に起動する
const NAVIGATE_TIMEOUT = 3000;

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      // 1つでも取れなければインストールをやり直す（欠けた版でオフライン起動させない）
      await cache.addAll(PRECACHE.map((url) => new Request(url, { cache: "no-cache" })));
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k.startsWith("sen-") && k !== CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "skip-waiting") self.skipWaiting();
  // 画面で動いているコードがこの版に含まれるか（含まれるなら、再読み込みせずに切り替えてよい）
  if (event.data?.type === "has") event.ports[0]?.postMessage(PRECACHED.has(event.data.path));
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/tutorials/")) return;

  if (req.mode === "navigate") {
    event.respondWith(navigate(req));
    return;
  }
  if (url.pathname.startsWith("/assets/") || PRECACHED.has(url.pathname)) {
    event.respondWith(cacheFirst(req, url));
  }
});

/** 画面の移動：まずネットワーク。オフラインや遅い回線では、保存しておいた HTML で起動する */
async function navigate(req) {
  const network = fetch(req);
  // 保存しておいた HTML を先に返したあとで通信が失敗しても、エラーにしない
  network.catch(() => {});
  const cached = async () => (await caches.open(CACHE)).match("/");
  const slow = new Promise((resolve) => setTimeout(resolve, NAVIGATE_TIMEOUT)).then(cached);
  try {
    return await Promise.race([network, slow.then((res) => res ?? network)]);
  } catch {
    return (await cached()) ?? Response.error();
  }
}

/** ビルド済みのファイル（名前にハッシュ入り）とアイコンなど：保存済みならそれを使う */
async function cacheFirst(req, url) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  // 中身が変わらないファイルは、あとからオフラインで使えるよう保存しておく
  if (res.ok && url.pathname.startsWith("/assets/")) cache.put(req, res.clone());
  return res;
}
