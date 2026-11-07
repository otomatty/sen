import { Extension } from "@tiptap/core";
import { Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import { Fragment } from "@tiptap/pm/model";
import { ATTACHMENT_BATCH_MAX, ATTACHMENT_UPLOAD_CONCURRENCY } from "../../../shared/constants";
import type { AttachmentUploadResponse } from "../../../shared/types";
import { uploadAttachment } from "../../lib/api";
import { checkAttachment } from "../../lib/attachments";
import { toast } from "../../store/ui";

const uploadKey = new PluginKey<DecorationSet>("senUpload");
let nextId = 1;
type UploadMeta = { add?: { id: number; pos: number; name: string }[]; update?: { id: number; progress: number }; remove?: number };

function placeholder(id: number, pos: number, name: string, progress = 0): Decoration {
  return Decoration.widget(pos, () => {
    const span = document.createElement("span");
    span.className = "upload-placeholder";
    span.dataset.testid = "upload-placeholder";
    span.textContent = `${name} をアップロード中… ${Math.round(progress * 100)}%`;
    return span;
  }, { id, name, side: 1, key: `${id}:${progress}` });
}

type Job = {
  id: number;
  file: File;
  wsKey: string;
  controller: AbortController;
  done: boolean;
  result?: AttachmentUploadResponse;
  error?: unknown;
};
type Batch = { jobs: Job[]; cursor: number; inserted: boolean };
const managers = new WeakMap<EditorView, UploadManager>();

/** 印だけを状態に持つ。進み具合の変更は本文や履歴に入れない */
export function uploadExtension(onUploadingChange: (uploading: boolean) => void) {
  return Extension.create({
    name: "senUpload",
    addProseMirrorPlugins() {
      return [new Plugin<DecorationSet>({
        key: uploadKey,
        state: {
          init: () => DecorationSet.empty,
          apply(tr, old) {
            let decorations = old.map(tr.mapping, tr.doc);
            const meta = tr.getMeta(uploadKey) as UploadMeta | undefined;
            if (!meta) return decorations;
            if (meta.remove !== undefined) decorations = decorations.remove(decorations.find().filter((d) => d.spec.id === meta.remove));
            if (meta.update) {
              const { id, progress } = meta.update;
              const found = decorations.find().find((d) => d.spec.id === id);
              if (found) decorations = decorations.remove([found]).add(tr.doc, [placeholder(id, found.from, found.spec.name, progress)]);
            }
            if (meta.add) decorations = decorations.add(tr.doc, meta.add.map((item) => placeholder(item.id, item.pos, item.name)));
            // 同じ位置の印も、進み具合の更新によって順序が変わらないようにする
            return DecorationSet.create(tr.doc, decorations.find().sort((a, b) => a.from - b.from || a.spec.id - b.spec.id));
          },
        },
        props: { decorations: (state) => uploadKey.getState(state) },
        view(view) {
          const manager = new UploadManager(view, onUploadingChange);
          managers.set(view, manager);
          return { destroy() { manager.destroy(); managers.delete(view); } };
        },
      })];
    },
  });
}

export function startUploads(view: EditorView, files: File[], pos: number, wsKey: string) {
  managers.get(view)?.start(files, pos, wsKey);
}

export function attachmentInCode(view: EditorView, pos = view.state.selection.from): boolean {
  const $pos = view.state.doc.resolve(pos);
  for (let depth = $pos.depth; depth >= 0; depth--) {
    if ($pos.node(depth).type.spec.code) return true;
  }
  return (pos === view.state.selection.from && !!view.state.storedMarks?.some((mark) => mark.type.spec.code))
    || $pos.marks().some((mark) => mark.type.spec.code);
}

class UploadManager {
  private batches: Batch[] = [];
  private queue: Job[] = [];
  private active = 0;
  private pending = 0;
  private destroyed = false;
  constructor(private view: EditorView, private onUploadingChange: (uploading: boolean) => void) {}

  private meta(meta: UploadMeta) {
    this.view.dispatch(this.view.state.tr.setMeta(uploadKey, meta).setMeta("addToHistory", false));
  }

  start(files: File[], pos: number, wsKey: string) {
    if (files.length > ATTACHMENT_BATCH_MAX) toast("一度に添付できるのは 10 ファイルまでです", { kind: "error" });
    const valid = files.slice(0, ATTACHMENT_BATCH_MAX).filter((file) => {
      const reason = checkAttachment(file);
      if (reason) toast(`${file.name} を添付できませんでした（${reason}）`, { kind: "error" });
      return !reason;
    });
    if (!valid.length) return;
    const jobs = valid.map((file): Job => ({ id: nextId++, file, wsKey, controller: new AbortController(), done: false }));
    const insertion = TextSelection.near(this.view.state.doc.resolve(pos)).from;
    this.meta({ add: jobs.map((job) => ({ id: job.id, pos: insertion, name: job.file.name })) });
    this.batches.push({ jobs, cursor: 0, inserted: false });
    this.queue.push(...jobs);
    const wasPending = this.pending;
    this.pending += jobs.length;
    if (!wasPending) this.onUploadingChange(true);
    this.pump();
  }

  private pump() {
    while (!this.destroyed && this.active < ATTACHMENT_UPLOAD_CONCURRENCY && this.queue.length) {
      const job = this.queue.shift()!;
      this.active++;
      void uploadAttachment(job.wsKey, job.file, {
        signal: job.controller.signal,
        onProgress: (progress) => { if (!this.destroyed) this.meta({ update: { id: job.id, progress } }); },
      }).then((result) => { job.result = result; }, (error: unknown) => { job.error = error; }).finally(() => {
        this.active--;
        if (this.destroyed) return;
        job.done = true;
        if (job.error) {
          this.meta({ remove: job.id });
          if ((job.error as Error).name !== "AbortError") {
            toast(`${job.file.name} を添付できませんでした（${job.error instanceof Error ? job.error.message : "エラーが発生しました"}）`, { kind: "error" });
          }
        }
        this.flush();
        this.pump();
      });
    }
  }

  private flush() {
    for (const batch of this.batches) {
      while (batch.cursor < batch.jobs.length && batch.jobs[batch.cursor].done) {
        const job = batch.jobs[batch.cursor++];
        const mark = uploadKey.getState(this.view.state)?.find().find((d) => d.spec.id === job.id);
        if (job.result && mark) {
          const { schema } = this.view.state;
          const result = job.result;
          const node = result.kind === "image"
            ? schema.nodes.image.create({ src: result.url, alt: result.name })
            : schema.text(result.name, [schema.marks.link.create({ href: result.url })]);
          // 成功した添付の間だけに改行を入れ、失敗したファイルの空行を残さない
          const nodes = batch.inserted ? [schema.nodes.hardBreak.create(), node] : [node];
          this.view.dispatch(this.view.state.tr.replaceWith(mark.from, mark.from, Fragment.fromArray(nodes)).setMeta(uploadKey, { remove: job.id }));
          batch.inserted = true;
        } else if (mark) {
          this.meta({ remove: job.id });
        }
        this.pending--;
      }
    }
    this.batches = this.batches.filter((batch) => batch.cursor < batch.jobs.length);
    if (!this.pending) this.onUploadingChange(false);
  }

  destroy() {
    this.destroyed = true;
    if (this.pending) {
      for (const batch of this.batches) for (const job of batch.jobs) job.controller.abort();
      toast("添付を取り消しました");
      this.onUploadingChange(false);
    }
    this.queue = [];
    this.batches = [];
    this.pending = 0;
  }
}
