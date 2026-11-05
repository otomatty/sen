// 利用者向けガイドと画面一覧がずれていないか、知識が大きすぎないかを確かめる。
// `tsx scripts/assistant-check.ts --write` は、知識を .tmp/assistant-knowledge.md に書き出す。

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { SCREENS } from "../shared/navigation";
import { buildAssistantKnowledge, readGuidePages } from "./assistant-knowledge";

const FORBIDDEN = ["wrangler", "secret put", "bun run", ".dev.vars", "DEV_TOOLS", ".env"];

function segments(value: string): string[] {
  return value.split("/").filter((part) => part.length > 0);
}

/** 画面の path が、/:ws の下のルートのどれかに合うか。`*` のルートは使わない */
function routeMatches(screenPath: string, routePath: string): boolean {
  if (routePath.split("/").includes("*")) return false;
  const screen = segments(screenPath);
  const route = segments(routePath);
  if (screen.length !== route.length || screen.length === 0) return false;
  for (let i = 0; i < screen.length; i++) {
    const left = screen[i];
    const right = route[i];
    const screenParam = left.startsWith(":");
    const routeParam = right.startsWith(":");
    if (screenParam) {
      if (!routeParam) return false;
      continue;
    }
    if (routeParam) continue;
    if (left !== right) return false;
  }
  return true;
}

function workspaceRoutes(appSource: string): string[] {
  const routes: string[] = [];
  const re = /<Route\s+path="([^"]+)"/g;
  for (let match = re.exec(appSource); match; match = re.exec(appSource)) {
    const route = match[1];
    if (route.startsWith("/") || route.includes("*")) continue;
    routes.push(route);
  }
  return routes;
}

function main() {
  const root = path.resolve(import.meta.dirname, "..");
  const write = process.argv.includes("--write");
  const problems: string[] = [];
  const appSource = readFileSync(path.join(root, "src", "App.tsx"), "utf8");
  const routes = workspaceRoutes(appSource);
  for (const screen of SCREENS) {
    if (!routes.some((route) => routeMatches(screen.path, route))) {
      problems.push(`画面 ${screen.id}（${screen.path}）が、src/App.tsx の /:ws の下のルートに合いません`);
    }
  }

  const pages = readGuidePages(root);
  const covered = new Set<string>();
  const known = new Set<string>(SCREENS.map((screen) => screen.id));
  for (const page of pages) {
    if (!page.title) problems.push(`${page.name} に title がありません`);
    if (page.screensError) problems.push(`${page.name} の ${page.screensError}`);
    for (const id of page.screens) {
      if (!known.has(id)) problems.push(`${page.name} の screens に、画面一覧に無い id「${id}」があります`);
      else covered.add(id);
    }
    for (const word of FORBIDDEN) {
      if (page.raw.includes(word)) problems.push(`${page.name} に開発者向けの言葉「${word}」があります`);
    }
  }
  for (const screen of SCREENS) {
    if (!covered.has(screen.id)) problems.push(`画面 ${screen.id} が、どのガイドのページの screens にも入っていません`);
  }

  const knowledge = buildAssistantKnowledge(root);
  const count = knowledge.text.length;
  console.log(`知識の文字数: ${count}`);
  if (count > 80_000) problems.push(`知識が 80000 文字を超えています（${count} 文字）`);

  if (write) {
    const dir = path.join(root, ".tmp");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "assistant-knowledge.md"), knowledge.text);
  }

  if (problems.length) {
    for (const problem of problems) console.error(problem);
    process.exitCode = 1;
    return;
  }
  console.log("問題はありません");
}

main();
