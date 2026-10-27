import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { cloudflare } from "@cloudflare/vite-plugin";

// SEN_PERSIST_DIR を指定すると、ローカル D1 / Durable Object の保存先を切り替えられる。
// （E2E テストやチュートリアル動画の収録で、毎回まっさらな DB を使うため）
const persistDir = process.env.SEN_PERSIST_DIR;

export default defineConfig(({ mode }) => {
  // デモ版（ブラウザ内でバックエンドごと動く単一 HTML）は Worker を含めない
  if (mode === "demo") {
    return {
      plugins: [react()],
      define: { __SEN_DEMO__: "true" },
      base: "./",
      build: {
        outDir: "dist-demo",
        assetsInlineLimit: 100_000_000,
        cssCodeSplit: false,
        copyPublicDir: false,
        chunkSizeWarningLimit: 5000,
        rollupOptions: { output: { inlineDynamicImports: true } },
      },
    };
  }
  return {
    plugins: [
      react(),
      cloudflare({
        persistState: persistDir ? { path: persistDir } : true,
        inspectorPort: false,
      }),
    ],
    define: { __SEN_DEMO__: "false" },
    server: { port: Number(process.env.PORT ?? 5173), strictPort: true },
    preview: { port: Number(process.env.PORT ?? 4173), strictPort: true },
    build: { chunkSizeWarningLimit: 1500 },
  };
});
