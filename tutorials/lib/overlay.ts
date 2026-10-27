// 収録中のページに注入するオーバーレイ（カーソル・クリック波紋・押したキー・字幕・タイトル）。
// アプリの DOM や CSS と干渉しないよう、Shadow DOM の中に描画する。
// この関数は文字列化してブラウザ側で実行されるため、外部の変数を参照してはいけない。

export function overlayScript(opts: { accent: string }) {
  const w = window as unknown as Record<string, unknown>;
  if (w.__tutor) return;
  const accent = opts.accent;

  const css = `
    :host { all: initial; }
    .layer { position: fixed; inset: 0; pointer-events: none; z-index: 2147483647; font-family: "Inter", "Hiragino Sans", "Noto Sans JP", "Noto Sans CJK JP", sans-serif; }
    .cursor { position: absolute; left: 0; top: 0; width: 26px; height: 26px; transform: translate(-100px, -100px); will-change: transform; filter: drop-shadow(0 2px 3px rgba(0,0,0,.45)); }
    .layer.titling .cursor { opacity: 0; }
    .cursor { transition: opacity .3s; }
    .cursor.down svg { transform: scale(.88); transform-origin: 3px 3px; }
    .ripple { position: absolute; width: 14px; height: 14px; margin: -7px 0 0 -7px; border-radius: 50%; border: 2px solid ${accent}; background: ${accent}33; animation: ripple .55s ease-out forwards; }
    @keyframes ripple { from { transform: scale(.6); opacity: 1 } to { transform: scale(3.4); opacity: 0 } }
    .keys { position: absolute; left: 50%; bottom: 112px; transform: translateX(-50%); display: flex; gap: 8px; opacity: 0; transition: opacity .18s, transform .18s; }
    .keys.show { opacity: 1; transform: translateX(-50%) translateY(-4px); }
    .key { min-width: 46px; height: 46px; padding: 0 14px; border-radius: 10px; background: rgba(20,21,26,.92); color: #fff; font-size: 21px; font-weight: 600; display: flex; align-items: center; justify-content: center; border: 1px solid rgba(255,255,255,.18); box-shadow: 0 6px 24px rgba(0,0,0,.45), inset 0 -3px 0 rgba(255,255,255,.08); }
    .key-then { color: rgba(255,255,255,.75); font-size: 15px; display: flex; align-items: center; font-weight: 600; text-shadow: 0 1px 4px rgba(0,0,0,.6); }
    .caption { position: absolute; left: 50%; bottom: 36px; transform: translateX(-50%) translateY(8px); max-width: 78%; padding: 14px 22px 14px 16px; border-radius: 14px; background: rgba(16,17,21,.9); color: #fff; font-size: 19px; line-height: 1.55; font-weight: 500; display: flex; gap: 12px; align-items: flex-start; opacity: 0; transition: opacity .25s, transform .25s; border: 1px solid rgba(255,255,255,.12); box-shadow: 0 10px 40px rgba(0,0,0,.45); backdrop-filter: blur(6px); letter-spacing: .01em; }
    .caption.show { opacity: 1; transform: translateX(-50%) translateY(0); }
    .caption .text, .title h1, .title p { word-break: auto-phrase; line-break: strict; text-wrap: balance; }
    .step { flex-shrink: 0; min-width: 28px; height: 28px; border-radius: 14px; background: ${accent}; color: #fff; font-size: 14px; font-weight: 700; display: flex; align-items: center; justify-content: center; margin-top: 1px; padding: 0 8px; }
    .highlight { position: absolute; border-radius: 10px; box-shadow: 0 0 0 2px ${accent}, 0 0 0 6px ${accent}40, 0 0 30px ${accent}66; transition: opacity .25s; opacity: 0; }
    .highlight.show { opacity: 1; }
    .title { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 14px; background: radial-gradient(ellipse at 50% 40%, ${accent}38, transparent 65%), rgba(9,10,12,.94); color: #fff; opacity: 0; transition: opacity .45s; text-align: center; padding: 40px; }
    .title.show { opacity: 1; }
    .title .badge { font-size: 14px; letter-spacing: .14em; color: ${accent}; font-weight: 700; background: ${accent}22; padding: 6px 14px; border-radius: 20px; border: 1px solid ${accent}55; }
    .title h1 { margin: 0; font-size: 46px; font-weight: 700; letter-spacing: .02em; }
    .title p { margin: 0; font-size: 20px; color: rgba(255,255,255,.72); max-width: 820px; line-height: 1.7; }
    .title .brand { position: absolute; bottom: 36px; display: flex; gap: 10px; align-items: center; font-size: 15px; color: rgba(255,255,255,.55); }
    .title .logo { width: 22px; height: 22px; border-radius: 6px; background: ${accent}; display: inline-flex; align-items: center; justify-content: center; }
  `;

  let root: ShadowRoot;
  let layer: HTMLDivElement;
  let cursor: HTMLDivElement;
  let keys: HTMLDivElement;
  let caption: HTMLDivElement;
  let highlight: HTMLDivElement;
  let titleEl: HTMLDivElement;
  let keyTimer: ReturnType<typeof setTimeout> | undefined;
  let lastX = -100;
  let lastY = -100;

  function mount() {
    if (document.getElementById("__tutor_host")) return;
    const host = document.createElement("div");
    host.id = "__tutor_host";
    document.documentElement.appendChild(host);
    root = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = css;
    root.appendChild(style);
    layer = document.createElement("div");
    layer.lang = "ja";
    layer.className = "layer";
    root.appendChild(layer);
    highlight = document.createElement("div");
    highlight.className = "highlight";
    layer.appendChild(highlight);
    keys = document.createElement("div");
    keys.className = "keys";
    layer.appendChild(keys);
    caption = document.createElement("div");
    caption.className = "caption";
    layer.appendChild(caption);
    titleEl = document.createElement("div");
    titleEl.className = "title";
    layer.appendChild(titleEl);
    cursor = document.createElement("div");
    cursor.className = "cursor";
    cursor.innerHTML =
      '<svg width="26" height="26" viewBox="0 0 26 26"><path d="M4 2.5 L4 21 L9 16.4 L12.4 24 L15.6 22.6 L12.3 15.2 L19 15.2 Z" fill="#fff" stroke="#111" stroke-width="1.4" stroke-linejoin="round"/></svg>';
    layer.appendChild(cursor);
    cursor.style.transform = `translate(${lastX - 3}px, ${lastY - 2}px)`;
  }

  if (document.documentElement) mount();
  document.addEventListener("DOMContentLoaded", mount);

  document.addEventListener(
    "mousemove",
    (e) => {
      lastX = e.clientX;
      lastY = e.clientY;
      if (cursor) cursor.style.transform = `translate(${e.clientX - 3}px, ${e.clientY - 2}px)`;
    },
    true,
  );
  document.addEventListener(
    "mousedown",
    (e) => {
      if (!layer) return;
      cursor.classList.add("down");
      const r = document.createElement("div");
      r.className = "ripple";
      r.style.left = `${e.clientX}px`;
      r.style.top = `${e.clientY}px`;
      layer.appendChild(r);
      setTimeout(() => r.remove(), 700);
    },
    true,
  );
  document.addEventListener("mouseup", () => cursor?.classList.remove("down"), true);

  w.__tutor = {
    keys(parts: string[]) {
      mount();
      keys.innerHTML = "";
      for (const p of parts) {
        const el = document.createElement("div");
        el.className = p === "→" ? "key-then" : "key";
        el.textContent = p === "→" ? "のあとに" : p;
        keys.appendChild(el);
      }
      keys.classList.add("show");
      if (keyTimer) clearTimeout(keyTimer);
      keyTimer = setTimeout(() => keys.classList.remove("show"), 1400);
    },
    caption(text: string, step: number | null) {
      mount();
      caption.innerHTML = "";
      if (step !== null) {
        const s = document.createElement("span");
        s.className = "step";
        s.textContent = String(step);
        caption.appendChild(s);
      }
      const t = document.createElement("span");
      t.lang = "ja";
      t.className = "text";
      t.textContent = text;
      caption.appendChild(t);
      caption.classList.add("show");
    },
    hideCaption() {
      caption?.classList.remove("show");
    },
    /** サムネイル撮影のため、重ね表示をまとめて隠す */
    setHidden(on: boolean) {
      mount();
      layer.style.visibility = on ? "hidden" : "";
    },
    highlight(rect: { x: number; y: number; width: number; height: number } | null) {
      mount();
      if (!rect) {
        highlight.classList.remove("show");
        return;
      }
      const pad = 5;
      highlight.style.left = `${rect.x - pad}px`;
      highlight.style.top = `${rect.y - pad}px`;
      highlight.style.width = `${rect.width + pad * 2}px`;
      highlight.style.height = `${rect.height + pad * 2}px`;
      highlight.classList.add("show");
    },
    title(badge: string, heading: string, sub: string) {
      mount();
      titleEl.innerHTML = "";
      const b = document.createElement("div");
      b.className = "badge";
      b.textContent = badge;
      const h = document.createElement("h1");
      h.textContent = heading;
      const p = document.createElement("p");
      p.textContent = sub;
      const brand = document.createElement("div");
      brand.className = "brand";
      brand.innerHTML = '<span class="logo"><svg width="14" height="14" viewBox="0 0 24 24"><path d="M5 19 L19 5" stroke="#fff" stroke-width="3" stroke-linecap="round"/></svg></span>Sen 使い方ガイド';
      titleEl.append(b, h, p, brand);
      titleEl.classList.add("show");
      layer.classList.add("titling");
    },
    hideTitle() {
      titleEl?.classList.remove("show");
      layer?.classList.remove("titling");
    },
  };
}
