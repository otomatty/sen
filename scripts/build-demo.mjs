#!/usr/bin/env node
// ブラウザ内デモ版を「単一の HTML ファイル」にまとめる。
// JS と CSS をインライン化し、動画などは dist-demo/tutorials/ に並べる。
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist-demo");
let html = readFileSync(path.join(dist, "index.html"), "utf8");

const read = (p) => readFileSync(path.join(dist, p.replace(/^\.?\//, "")), "utf8");
html = html.replace(/<script type="module" crossorigin src="([^"]+)"><\/script>/g, (_, src) => {
  const js = read(src).replace(/<\/script/gi, "<\\/script");
  return `<script type="module">${js}</script>`;
});
html = html.replace(/<link rel="stylesheet" crossorigin href="([^"]+)">/g, (_, href) => `<style>${read(href)}</style>`);
html = html.replace(/<link rel="modulepreload"[^>]*>/g, "");
const favicon = readFileSync(path.join(root, "public", "favicon.svg"), "utf8");
html = html.replace(
  /<link rel="icon"[^>]*>/,
  `<link rel="icon" href="data:image/svg+xml,${encodeURIComponent(favicon)}" type="image/svg+xml" />`,
);
writeFileSync(path.join(dist, "index.html"), html);

// Claude のアーティファクトとして公開する版：外側の <html>/<head>/<body> は公開時に付くので取り除く
const titleTag = (html.match(/<title>[\s\S]*?<\/title>/) ?? ["<title>Sen 課題管理</title>"])[0];
let fragment = html
  .replace(/<!doctype html>/i, "")
  .replace(/<\/?html[^>]*>/gi, "")
  .replace(/<\/?head>/gi, "")
  .replace(/<\/?body>/gi, "")
  .replace(/<meta charset[^>]*>/i, "")
  .replace(/<meta name="viewport"[^>]*>/i, "")
  .replace(/<link rel="manifest"[^>]*>/i, "")
  .replace(titleTag, "");
fragment = `${titleTag.replace(/<title>[\s\S]*?<\/title>/, "<title>Sen 課題管理</title>")}\n${fragment.trim()}\n`;
writeFileSync(path.join(dist, "artifact.html"), fragment);
rmSync(path.join(dist, "assets"), { recursive: true, force: true });

// 操作説明動画
const tut = path.join(root, "public", "tutorials");
if (existsSync(tut)) {
  mkdirSync(path.join(dist, "tutorials"), { recursive: true });
  cpSync(tut, path.join(dist, "tutorials"), { recursive: true });
}
const size = (readFileSync(path.join(dist, "index.html")).length / 1024 / 1024).toFixed(2);
console.log(`dist-demo/index.html（${size} MB）と tutorials/（${existsSync(tut) ? readdirSync(tut).length : 0} ファイル）を書き出しました`);
