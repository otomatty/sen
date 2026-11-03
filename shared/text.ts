/** 平仮名⇔片仮名・全角⇔半角・大文字小文字の違いを吸収した検索用の正規化 */
export function normalizeSearch(s: string): string {
  return s
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
}

export function fuzzyMatch(text: string, query: string): boolean {
  if (!query) return true;
  const t = normalizeSearch(text);
  return normalizeSearch(query)
    .split(/\s+/)
    .filter(Boolean)
    .every((q) => t.includes(q));
}
