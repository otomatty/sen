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
import { initPWA } from "./app/pwa";

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

// サービスワーカー（オフライン起動・更新の案内）とインストールの提案
initPWA();
