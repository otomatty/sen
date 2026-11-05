import type { JSONContent } from "@tiptap/core";

// 保存する Markdown だけを変える。画面に出している文書はそのまま。
// 移行の変換（worker/markdown.ts）と同じ規則で、bold・italic・strike の端の句読点から印を外す。
// どちらかの隣が、空白でも句読点でもない文字なら、両端の句読点の印を外す。
// 両側が段落の端、空白、句読点、テキストでないノードなら外さない。

const EMPHASIS = ["bold", "italic", "strike"] as const;

type Mark = NonNullable<JSONContent["marks"]>[number];

interface CharAtom {
  kind: "char";
  ch: string;
  marks: Mark[];
}
interface NodeAtom {
  kind: "node";
  node: JSONContent;
}
type Atom = CharAtom | NodeAtom;

function isPunct(ch: string): boolean {
  return /[\p{P}\p{S}]/u.test(ch);
}

function isWhitespace(ch: string): boolean {
  return /[\p{Zs}\t\n\f\r]/u.test(ch);
}

function isWordish(ch: string | null): boolean {
  return ch != null && !isWhitespace(ch) && !isPunct(ch);
}

function cloneMarks(marks: JSONContent["marks"]): Mark[] {
  if (!marks) return [];
  return marks.map((mark) => {
    const copy: Mark = { type: mark.type };
    if (mark.attrs) copy.attrs = { ...mark.attrs };
    return copy;
  });
}

function sameMarks(a: Mark[], b: Mark[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].type !== b[i].type) return false;
    if (JSON.stringify(a[i].attrs ?? null) !== JSON.stringify(b[i].attrs ?? null)) return false;
  }
  return true;
}

function hasMark(marks: Mark[], type: string): boolean {
  return marks.some((mark) => mark.type === type);
}

function flattenInline(content: JSONContent[]): Atom[] {
  const atoms: Atom[] = [];
  for (const node of content) {
    if (node.type === "text" && node.text) {
      const marks = cloneMarks(node.marks);
      for (const ch of node.text) atoms.push({ kind: "char", ch, marks });
      continue;
    }
    atoms.push({ kind: "node", node });
  }
  return atoms;
}

/** dir が -1 なら index の直前、1 なら index の位置。テキストでなければ null（段落の端も null） */
function neighborChar(atoms: Atom[], index: number, dir: -1 | 1): string | null {
  const at = dir === -1 ? index - 1 : index;
  if (at < 0 || at >= atoms.length) return null;
  const atom = atoms[at];
  if (atom.kind !== "char") return null;
  return atom.ch;
}

function stripMarkEdges(atoms: Atom[], mark: string): boolean {
  let changed = false;
  let i = 0;
  while (i < atoms.length) {
    const head = atoms[i];
    if (head.kind !== "char" || !hasMark(head.marks, mark)) {
      i++;
      continue;
    }
    let j = i + 1;
    while (j < atoms.length) {
      const atom = atoms[j];
      if (atom.kind !== "char" || !hasMark(atom.marks, mark)) break;
      j++;
    }
    const before = neighborChar(atoms, i, -1);
    const after = neighborChar(atoms, j, 1);
    if (isWordish(before) || isWordish(after)) {
      let start = i;
      let end = j;
      while (start < end && isEdgePunct(atoms[start])) start++;
      while (end > start && isEdgePunct(atoms[end - 1])) end--;
      for (let k = i; k < start; k++) removeMark(atoms[k], mark);
      for (let k = end; k < j; k++) removeMark(atoms[k], mark);
      if (start !== i || end !== j) changed = true;
    }
    i = j;
  }
  return changed;
}

function isEdgePunct(atom: Atom | undefined): boolean {
  return atom?.kind === "char" && isPunct(atom.ch);
}

function removeMark(atom: Atom, mark: string) {
  if (atom.kind !== "char") return;
  atom.marks = atom.marks.filter((item) => item.type !== mark);
}

function rebuildInline(atoms: Atom[]): JSONContent[] {
  const out: JSONContent[] = [];
  let text = "";
  let marks: Mark[] | null = null;
  const flush = () => {
    if (!text) return;
    const node: JSONContent = { type: "text", text };
    if (marks?.length) node.marks = marks;
    out.push(node);
    text = "";
    marks = null;
  };
  for (const atom of atoms) {
    if (atom.kind === "node") {
      flush();
      out.push(atom.node);
      continue;
    }
    if (marks && sameMarks(marks, atom.marks)) {
      text += atom.ch;
      continue;
    }
    flush();
    text = atom.ch;
    marks = atom.marks;
  }
  flush();
  return out;
}

function fixInline(content: JSONContent[]): JSONContent[] {
  if (!content.some((node) => node.type === "text" && node.marks?.some((mark) => (EMPHASIS as readonly string[]).includes(mark.type)))) return content;
  const atoms = flattenInline(content);
  let changed = false;
  for (const mark of EMPHASIS) {
    if (stripMarkEdges(atoms, mark)) changed = true;
  }
  if (!changed) return content;
  return rebuildInline(atoms);
}

function mapNode(node: JSONContent): JSONContent {
  if (!node.content?.length) return node;
  let childChanged = false;
  const content = node.content.map((child) => {
    const next = mapNode(child);
    if (next !== child) childChanged = true;
    return next;
  });
  const fixed = fixInline(content);
  if (!childChanged && fixed === content) return node;
  return { ...node, content: fixed };
}

/** 段落・見出しなど、行内を持つノードの強調から、端の句読点の印を外した JSON を返す */
export function adjustEmphasisPunctuation(doc: JSONContent): JSONContent {
  return mapNode(doc);
}
