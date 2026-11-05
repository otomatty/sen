// AI アシスタントに渡す知識。画面一覧・コマンド・ショートカット・使い方動画・利用者向けガイドから作る。
// 同じ入力からは、いつも同じ文字列になる（日時・乱数・ファイルの更新時刻は入れない）。

import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { COMMANDS, SCREENS, commandCombo, type CommandDef } from "../shared/navigation";
import { SHORTCUT_GROUPS } from "../src/features/help/shortcuts";

export interface AssistantTutorial {
  id: string;
  title: string;
  summary: string;
  screen: string;
  chapters: { title: string; t: number }[];
}

export interface AssistantKnowledge {
  text: string;
  tutorials: AssistantTutorial[];
  sources: string[];
}

export interface GuidePage {
  file: string;
  name: string;
  title: string;
  screens: string[];
  /** front matter を除いた本文 */
  body: string;
  /** 禁止語の確認に使う、ファイルの中身 */
  raw: string;
  /** screens 行の形が違うとき */
  screensError: string | null;
}

const NAMED_KEYS: Record<string, string> = {
  escape: "Esc",
  enter: "Enter",
  backspace: "Backspace",
  delete: "Delete",
  arrowup: "↑",
  arrowdown: "↓",
  arrowleft: "←",
  arrowright: "→",
  space: "Space",
  tab: "Tab",
};

function keyLabel(key: string): string {
  const named = NAMED_KEYS[key.toLowerCase()];
  if (named) return named;
  if (key.length === 1 && /[a-z]/i.test(key)) return key.toUpperCase();
  return key;
}

function formatChord(combo: string): string {
  const parts = combo.split("+");
  if (!parts.includes("mod")) {
    return parts.map((p) => (p === "shift" ? "Shift" : p === "alt" ? "Alt" : p === "ctrl" ? "Ctrl" : keyLabel(p))).join("+");
  }
  const mac: string[] = [];
  const win: string[] = [];
  for (const p of parts) {
    if (p === "mod") {
      mac.push("⌘");
      win.push("Ctrl");
    } else if (p === "shift") {
      mac.push("⇧");
      win.push("Shift");
    } else if (p === "alt") {
      mac.push("⌥");
      win.push("Alt");
    } else if (p === "ctrl") {
      mac.push("Ctrl");
      win.push("Ctrl");
    } else {
      const label = keyLabel(p);
      mac.push(label);
      win.push(label);
    }
  }
  return `${mac.join("")}（Windows・Linux は ${win.join("+")}）`;
}

/** ショートカットを、人が読む形にする。例：mod+k → ⌘K（Windows・Linux は Ctrl+K） */
export function formatShortcut(combo: string): string {
  const sequence = combo.trim().split(/\s+/).filter(Boolean);
  if (sequence.length > 1) return sequence.map(formatChord).join(" のあと ");
  return formatChord(combo);
}

function parseFrontMatter(raw: string): { title: string; screens: string[]; body: string; screensError: string | null } {
  if (!raw.startsWith("---\n")) return { title: "", screens: [], body: raw, screensError: null };
  const end = raw.indexOf("\n---\n", 4);
  if (end < 0) return { title: "", screens: [], body: raw, screensError: null };
  const fm = raw.slice(4, end);
  const body = raw.slice(end + 5).replace(/^\n/, "").trim();
  let title = "";
  let screens: string[] = [];
  let screensError: string | null = null;
  for (const line of fm.split("\n")) {
    if (line.startsWith("title:")) {
      title = line.slice("title:".length).trim().replace(/^["']|["']$/g, "");
    } else if (line.startsWith("screens:")) {
      const m = /^screens:\s*\[(.*)\]\s*$/.exec(line.trim());
      if (!m) screensError = "screens の形が違います";
      else screens = m[1].split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
    }
  }
  return { title, screens, body, screensError };
}

/** `#` の見出しを 1 段下げる。囲みの中はそのまま */
export function demoteHeadings(md: string): string {
  let fence = false;
  return md
    .split("\n")
    .map((line) => {
      if (line.startsWith("```")) {
        fence = !fence;
        return line;
      }
      if (!fence && /^#{1,6} /.test(line)) return `#${line}`;
      return line;
    })
    .join("\n");
}

export function readGuidePages(root: string): GuidePage[] {
  const dir = path.join(root, "docs", "guide");
  const names = readdirSync(dir)
    .filter((name) => name.endsWith(".md") && name !== "README.md")
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return names.map((name) => {
    const file = path.join(dir, name);
    const raw = readFileSync(file, "utf8").replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
    const parsed = parseFrontMatter(raw);
    return { file, name, raw, ...parsed };
  });
}

function commandCondition(cmd: CommandDef): string {
  const parts: string[] = [];
  if (cmd.context === "single-issue") parts.push("課題を 1 件だけフォーカスまたは選択しているとき");
  else if (cmd.context === "issues") parts.push("課題をフォーカスまたは選択しているとき");
  if (cmd.team) parts.push("チームごとに出ます");
  if (cmd.availability) parts.push(cmd.availability);
  return parts.length ? parts.join("。") : "いつでも";
}

const COMMAND_GROUPS = ["課題", "作成", "移動", "ヘルプ", "表示", "その他"] as const;

function screensSection(): string {
  return SCREENS.map((raw) => {
    const screen = raw as {
      id: string;
      title: string;
      description: string;
      where: string;
      combo?: string;
    };
    return [
      `## ${screen.title}`,
      "",
      `- id：${screen.id}`,
      `- 説明：${screen.description}`,
      `- 開き方：${screen.where}`,
      `- ショートカット：${screen.combo ? formatShortcut(screen.combo) : "なし"}`,
    ].join("\n");
  }).join("\n\n");
}

function commandsSection(): string {
  const blocks: string[] = [];
  for (const group of COMMAND_GROUPS) {
    const cmds = COMMANDS.filter((c) => c.group === group);
    if (!cmds.length) continue;
    const items = cmds.map((raw) => {
      const cmd: CommandDef = raw;
      const combo = commandCombo(cmd);
      return [
        `### ${cmd.label.replaceAll("{team}", "チーム名")}`,
        "",
        `- ショートカット：${combo ? formatShortcut(combo) : "なし"}`,
        `- 説明：${cmd.description}`,
        `- 出る条件：${commandCondition(cmd)}`,
      ].join("\n");
    });
    blocks.push(`## ${group}\n\n${items.join("\n\n")}`);
  }
  return blocks.join("\n\n");
}

function shortcutsSection(): string {
  return SHORTCUT_GROUPS.map((group) => {
    const items = group.items.map(([combo, label]) => `- ${formatShortcut(combo)}：${label}`);
    return `## ${group.title}\n\n${items.join("\n")}`;
  }).join("\n\n");
}

interface ManifestTutorial {
  id: string;
  title: string;
  summary: string;
  screen: string;
  order: number;
  chapters: { title: string; t: number }[];
}

function readManifest(file: string): ManifestTutorial[] {
  const parsed = JSON.parse(readFileSync(file, "utf8")) as { tutorials?: unknown };
  if (!Array.isArray(parsed.tutorials)) throw new Error(`${file} に tutorials がありません`);
  return parsed.tutorials.map((item, index) => {
    if (!item || typeof item !== "object") throw new Error(`${file} の ${index + 1} 件目の形が違います`);
    const row = item as Record<string, unknown>;
    if (typeof row.id !== "string" || typeof row.title !== "string" || typeof row.summary !== "string" || typeof row.screen !== "string") {
      throw new Error(`${file} の ${index + 1} 件目に id・title・summary・screen がありません`);
    }
    const chapters = Array.isArray(row.chapters)
      ? row.chapters.map((chapter) => {
          const c = chapter as Record<string, unknown>;
          return { title: typeof c.title === "string" ? c.title : "", t: typeof c.t === "number" ? c.t : 0 };
        })
      : [];
    return {
      id: row.id,
      title: row.title,
      summary: row.summary,
      screen: row.screen,
      order: typeof row.order === "number" ? row.order : index,
      chapters,
    };
  });
}

function tutorialsSection(list: ManifestTutorial[]): { text: string; tutorials: AssistantTutorial[] } {
  if (!list.length) return { text: "動画はありません", tutorials: [] };
  const sorted = [...list].sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const tutorials = sorted.map(({ id, title, summary, screen, chapters }) => ({ id, title, summary, screen, chapters }));
  const text = tutorials
    .map((tutorial) => {
      const lines = [`## ${tutorial.title}（${tutorial.id}）`, "", tutorial.summary];
      if (tutorial.chapters.length) {
        lines.push("", tutorial.chapters.map((chapter, i) => `${i + 1}. ${chapter.title}`).join("\n"));
      }
      return lines.join("\n");
    })
    .join("\n\n");
  return { text, tutorials };
}

function guideSection(pages: GuidePage[]): string {
  if (!pages.length) return "ガイドはありません";
  return pages.map((page) => demoteHeadings(page.body).trim()).join("\n\n");
}

export function buildAssistantKnowledge(root: string): AssistantKnowledge {
  const resolved = path.resolve(root);
  const pages = readGuidePages(resolved);
  const manifestPath = path.join(resolved, "public", "tutorials", "manifest.json");
  const manifest = existsSync(manifestPath) ? readManifest(manifestPath) : [];
  const tutorials = tutorialsSection(manifest);
  const parts = [
    `# 画面の一覧\n\n${screensSection()}`,
    `# コマンドパレットのコマンド\n\n${commandsSection()}`,
    `# キーボードショートカット\n\n${shortcutsSection()}`,
    `# 使い方動画\n\n${tutorials.text.trim()}`,
    `# 利用者向けガイド\n\n${guideSection(pages)}`,
  ];
  const sources = pages.map((page) => page.file);
  if (existsSync(manifestPath)) sources.push(manifestPath);
  sources.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return {
    text: `${parts.join("\n\n")}\n`,
    tutorials: tutorials.tutorials,
    sources,
  };
}
