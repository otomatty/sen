import type { MarkdownToken } from "@tiptap/core";

type BlockLexer = {
  blockTokens: (src: string) => MarkdownToken[];
  inlineTokens?: (src: string) => MarkdownToken[];
};

function inlineTokensFor(lexer: BlockLexer, text: string): MarkdownToken[] {
  if (lexer.inlineTokens) return lexer.inlineTokens(text);
  return text ? [{ type: "text", raw: text, text }] : [];
}

/**
 * リスト項目では marked が段落の代わりに、一番上の階層へ type:"text" のブロックを返す。
 * 注記と脚注の本文では、そのトークンだけ同じ中身の段落に戻す。
 * tokens は marked が後から行内トークンを書き込む配列なので、あるときはそのまま使う。
 */
export function readBlockTokens(lexer: BlockLexer, body: string): MarkdownToken[] {
  if (!body) return [];
  return lexer.blockTokens(body).map((token) => {
    if (token.type !== "text") return token;
    const text = token.text ?? "";
    return {
      type: "paragraph",
      raw: token.raw,
      text,
      tokens: token.tokens ?? inlineTokensFor(lexer, text),
    };
  });
}
