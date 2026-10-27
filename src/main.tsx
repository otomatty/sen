import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/inter";
import "./styles/base.css";
import "./styles/components.css";
import "./styles/layout.css";
import "./styles/issues.css";
import "./styles/pages.css";
import { App } from "./App";
import { applyTheme, useUI } from "./store/ui";

applyTheme(useUI.getState().theme);

async function boot() {
  // ブラウザ内デモ版では、バックエンドをブラウザ内で動かす
  if (typeof __SEN_DEMO__ !== "undefined" && __SEN_DEMO__) {
    const { startDemoBackend } = await import("../demo/backend");
    await startDemoBackend();
  }
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
boot();

// オフラインでも起動できるよう、本番ビルドではサービスワーカーを登録する
if (import.meta.env.PROD && !(typeof __SEN_DEMO__ !== "undefined" && __SEN_DEMO__) && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {
      // 登録できなくても通常どおり動く
    });
  });
}
