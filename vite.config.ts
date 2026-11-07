import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { cloudflare } from "@cloudflare/vite-plugin";
import { buildAssistantKnowledge } from "./scripts/assistant-knowledge";

// SEN_PERSIST_DIR を指定すると、ローカル D1 / Durable Object の保存先を切り替えられる。
// （E2E テストやチュートリアル動画の収録で、毎回まっさらな DB を使うため）
const persistDir = process.env.SEN_PERSIST_DIR;

/** public/ の中のファイル（使い方動画は大きいので除く） */
function publicFiles(dir: string, base = ""): string[] {
  return readdirSync(path.join(dir, base), { withFileTypes: true }).flatMap((e) => {
    const rel = path.posix.join(base, e.name);
    if (e.isDirectory()) return rel === "tutorials" ? [] : publicFiles(dir, rel);
    return [rel];
  });
}

/**
 * AI アシスタントに渡す知識。ガイドや manifest を直すと、開発中に作り直す。
 * Worker のコードはデモ版にも含まれるので、両方のビルドに入れる。
 */
function assistantKnowledge(): Plugin {
  const virtualId = "virtual:sen-assistant-knowledge";
  const resolvedId = `\0${virtualId}`;
  return {
    name: "sen:assistant-knowledge",
    // まだ import されていなくても、起動時とビルド時に一度作って壊れていないことを確かめる
    configResolved(config) {
      buildAssistantKnowledge(config.root);
    },
    resolveId(id) {
      if (id === virtualId) return resolvedId;
    },
    load(id) {
      if (id !== resolvedId) return null;
      const knowledge = buildAssistantKnowledge(this.environment.config.root);
      for (const file of knowledge.sources) this.addWatchFile(file);
      return `export const KNOWLEDGE = ${JSON.stringify(knowledge.text)};\nexport const TUTORIALS = ${JSON.stringify(knowledge.tutorials)};\n`;
    },
  };
}

/**
 * サービスワーカー（src/sw.js）に、オフライン起動に必要なファイルの一覧と版を埋め込んで sw.js として書き出す。
 * 遅れて読み込む画面（エディタ・ボード）やフォントも含めるので、一度開けばどの画面もオフラインで開ける。
 */
function serviceWorker(): Plugin {
  return {
    name: "sen:service-worker",
    apply: "build",
    enforce: "post",
    applyToEnvironment: (env) => env.name === "client",
    generateBundle(_, bundle) {
      const { root, publicDir } = this.environment.config;
      const source = readFileSync(path.join(root, "src/sw.js"), "utf8");
      if (!source.includes("__SEN_SW_VERSION__") || !source.includes("__SEN_SW_PRECACHE__")) {
        this.error("src/sw.js に __SEN_SW_VERSION__ / __SEN_SW_PRECACHE__ が見つかりません");
      }
      const statics = publicDir ? publicFiles(publicDir) : [];
      const assets = Object.keys(bundle).filter((f) => f.startsWith("assets/") && !f.endsWith(".map"));
      const urls = ["/", ...[...statics, ...assets].sort().map((f) => `/${f}`)];
      // 版は中身から決める：ファイル名（ハッシュ入り）・index.html・public/ の中身が同じなら、版も変わらない
      const hash = createHash("sha256").update(source).update(urls.join("\n"));
      const html = bundle["index.html"];
      if (html?.type === "asset") hash.update(html.source);
      for (const f of statics) hash.update(readFileSync(path.join(publicDir, f)));
      const version = hash.digest("hex").slice(0, 12);
      this.emitFile({
        type: "asset",
        fileName: "sw.js",
        source: source.replace("__SEN_SW_VERSION__", JSON.stringify(version)).replace("__SEN_SW_PRECACHE__", JSON.stringify(urls, null, 2)),
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  // デモ版（ブラウザ内でバックエンドごと動く単一 HTML）は Worker を含めない
  if (mode === "demo") {
    return {
      plugins: [react(), assistantKnowledge()],
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
      serviceWorker(),
      assistantKnowledge(),
    ],
    define: { __SEN_DEMO__: "false" },
    // CORS は Worker が決める。Vite が OPTIONS を先に返すと本番と挙動が変わるため無効にする。
    server: { port: Number(process.env.PORT ?? 5173), strictPort: true, cors: false },
    preview: { port: Number(process.env.PORT ?? 4173), strictPort: true, cors: false },
    build: { chunkSizeWarningLimit: 1500 },
  };
});
