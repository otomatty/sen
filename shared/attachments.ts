import { ATTACHMENT_NAME_MAX } from "./constants";

export type AttachmentKind = "image" | "file";

const UUID_SOURCE = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

/** 拡張子や申告された種類を信用せず、先頭のバイトだけで画像を判定する */
export function sniffImageType(bytes: Uint8Array): "image/png" | "image/jpeg" | "image/gif" | "image/webp" | null {
  const matches = (signature: number[], offset = 0) => signature.every((v, i) => bytes[offset + i] === v);
  if (matches([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (matches([0xff, 0xd8, 0xff])) return "image/jpeg";
  if (matches([0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) || matches([0x47, 0x49, 0x46, 0x38, 0x39, 0x61])) return "image/gif";
  if (matches([0x52, 0x49, 0x46, 0x46]) && matches([0x57, 0x45, 0x42, 0x50], 8)) return "image/webp";
  return null;
}

/** パスと制御文字を除き、コードポイント数で名前を制限する */
export function cleanFileName(name: string): string {
  return Array.from(name.replace(/[\u0000-\u001f\u007f/\\]/g, "").trim()).slice(0, ATTACHMENT_NAME_MAX).join("") || "file";
}

export function encodeFileNameForUrl(name: string): string {
  return encodeURIComponent(name).replace(/\(/g, "%28").replace(/\)/g, "%29");
}

export function attachmentUrl(origin: string, id: string, name: string): string {
  return `${origin.replace(/\/+$/, "")}/api/files/${id}/${encodeFileNameForUrl(name)}`;
}

/** オリジンにかかわらず本文中の添付 ID を拾う。所属は呼び出し側で確認する */
export function extractAttachmentIds(markdown: string): string[] {
  const ids = new Set<string>();
  const pattern = new RegExp(`/api/files/(${UUID_SOURCE})(?![0-9a-z-])`, "gi");
  for (const match of markdown.matchAll(pattern)) {
    ids.add(match[1].toLowerCase());
    if (ids.size >= 200) break;
  }
  return [...ids];
}

export function isAttachmentUrl(href: string, origin: string): boolean {
  try {
    const url = new URL(href);
    return url.origin === new URL(origin).origin && new RegExp(`^/api/files/${UUID_SOURCE}(?:/.*)?$`, "i").test(url.pathname);
  } catch {
    return false;
  }
}

/** ASCII の代替名と RFC 5987 の名前を併記する */
export function contentDisposition(kind: AttachmentKind, name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, "_");
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${kind === "image" ? "inline" : "attachment"}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
