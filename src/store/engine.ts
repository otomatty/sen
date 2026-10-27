import type { BootstrapPayload, EntityName, Mutation, MutateResponse, SyncChange } from "../../shared/types";
import { api, ApiError } from "../lib/api";
import { uuid } from "../lib/utils";
import { useData, initialData, type DataState } from "./data";
import { CACHE_VERSION, loadSnapshot, saveSnapshot } from "./cache";

// ---------------------------------------------------------------------------
// 同期エンジン
//
// Linear と同じく「ローカルファースト」で動く。
//   1. 起動時に /api/bootstrap でワークスペース全体を手元に読み込む
//   2. 画面はすべて手元のデータから描画する（待ち時間ゼロ）
//   3. 変更は楽観的に即反映し、裏でキューから /api/mutate に送る
//   4. サーバーの変更は sync_log の連番（syncId）で差分取得する
//   5. Durable Object の WebSocket が「新しい変更がある」と知らせてくれる
//
// 手元の状態 = サーバー確定値（base） + 未確定の変更（pending）
// 確定値が届くたびに pending を上から重ね直すので、他人の変更と自分の変更が衝突しても画面が崩れない。
// ---------------------------------------------------------------------------

export type CollectionKey =
  | "users"
  | "teams"
  | "states"
  | "labels"
  | "projects"
  | "cycles"
  | "issues"
  | "comments"
  | "activities"
  | "notifications";

const COLLECTIONS: CollectionKey[] = [
  "users",
  "teams",
  "states",
  "labels",
  "projects",
  "cycles",
  "issues",
  "comments",
  "activities",
  "notifications",
];

const ENTITY_COLLECTION: Record<Exclude<EntityName, "workspace">, CollectionKey> = {
  user: "users",
  team: "teams",
  state: "states",
  label: "labels",
  project: "projects",
  cycle: "cycles",
  issue: "issues",
  comment: "comments",
  activity: "activities",
  notification: "notifications",
};

/* eslint-disable @typescript-eslint/no-explicit-any */
export interface Effect {
  c: CollectionKey;
  id: string;
  fn: (prev: any) => any;
}

interface PendingOp {
  clientId: string;
  mutation: Mutation;
  effects: Effect[];
  state: "queued" | "inflight" | "sent";
  syncId?: number;
  resolve: (ok: boolean) => void;
}

type Listener = (msg: string) => void;

class SyncEngine {
  wsKey: string | null = null;
  private base = new Map<CollectionKey, Map<string, any>>();
  private pending: PendingOp[] = [];
  private applied = 0;
  private dirty = new Map<CollectionKey, Set<string>>();
  private commitScheduled = false;
  private flushing = false;
  private pulling = false;
  private pullAgain = false;
  private socket: WebSocket | null = null;
  private socketRetry = 1000;
  private flushRetry = 1000;
  private timers: ReturnType<typeof setTimeout>[] = [];
  private intervals: ReturnType<typeof setInterval>[] = [];
  private generation = 0;
  private errorListeners = new Set<Listener>();
  private unauthorizedListeners = new Set<() => void>();
  realtimeEnabled = true;
  cacheEnabled = true;
  private cacheKey: string | null = null;
  private snapshotTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    this.resetBase();
  }

  private resetBase() {
    for (const c of COLLECTIONS) this.base.set(c, new Map());
  }

  onError(fn: Listener) {
    this.errorListeners.add(fn);
    return () => this.errorListeners.delete(fn);
  }
  onUnauthorized(fn: () => void) {
    this.unauthorizedListeners.add(fn);
    return () => this.unauthorizedListeners.delete(fn);
  }
  private emitError(msg: string) {
    this.errorListeners.forEach((f) => f(msg));
  }

  // ---------------- ライフサイクル ----------------
  async start(wsKey: string, userId?: string | null) {
    if (this.wsKey === wsKey && useData.getState().status === "ready") return;
    this.stop();
    this.wsKey = wsKey;
    this.cacheKey = this.cacheEnabled && userId ? `${userId}:${wsKey}` : null;
    const gen = ++this.generation;
    useData.setState({ ...initialData, status: "loading" });
    try {
      // 前回のデータがあれば即座に表示し、差分だけを取りに行く
      const snap = this.cacheKey ? await loadSnapshot(this.cacheKey) : null;
      if (gen !== this.generation) return;
      if (snap) {
        this.hydrate(snap);
        this.pull();
      } else {
        await this.bootstrap();
      }
    } catch (e) {
      if (gen !== this.generation) return;
      if (e instanceof ApiError && e.status === 401) {
        this.unauthorizedListeners.forEach((f) => f());
        return;
      }
      const offline = e instanceof ApiError && (e.status === 0 || e.status >= 500);
      useData.setState({
        status: "error",
        error: offline ? "サーバーに接続できません。接続が戻ると自動で読み込み直します。" : (e as Error).message,
      });
      if (offline) {
        // 接続が戻ったら（または数秒おきに）読み込み直す
        const retry = () => {
          window.removeEventListener("online", retry);
          if (gen === this.generation) {
            this.wsKey = null;
            this.start(wsKey, userId);
          }
        };
        window.addEventListener("online", retry);
        this.timers.push(setTimeout(retry, 5000));
      }
      return;
    }
    if (gen !== this.generation) return;
    this.connectRealtime();
    // リアルタイム接続が無い環境でも追従できるよう、定期的に差分を取る
    this.intervals.push(
      setInterval(() => {
        if (document.visibilityState === "visible") this.pull();
      }, 15_000),
    );
    window.addEventListener("focus", this.onFocus);
    window.addEventListener("online", this.onOnline);
    window.addEventListener("beforeunload", this.onBeforeUnload);
    document.addEventListener("visibilitychange", this.onFocus);
  }

  /** キャッシュから状態を復元する */
  private hydrate(snap: { applied: number; meId: string; workspace: unknown; workspaces: unknown; collections: Record<string, unknown[]> }) {
    this.resetBase();
    for (const c of COLLECTIONS) {
      const m = this.base.get(c)!;
      for (const x of (snap.collections[c] ?? []) as { id: string }[]) m.set(x.id, x);
    }
    this.applied = snap.applied;
    const view: Partial<DataState> = {
      status: "ready",
      error: null,
      meId: snap.meId,
      workspace: snap.workspace as DataState["workspace"],
      workspaces: snap.workspaces as DataState["workspaces"],
      threads: {},
    };
    for (const c of COLLECTIONS) view[c] = this.computeCollection(c) as never;
    useData.setState(view);
  }

  /** 確定済みのデータをキャッシュに保存する（少し間をおいてまとめて） */
  private scheduleSnapshot() {
    if (!this.cacheKey) return;
    if (this.snapshotTimer) clearTimeout(this.snapshotTimer);
    const key = this.cacheKey;
    this.snapshotTimer = setTimeout(() => {
      const st = useData.getState();
      if (st.status !== "ready" || key !== this.cacheKey || !st.meId) return;
      const collections: Record<string, unknown[]> = {};
      for (const c of COLLECTIONS) collections[c] = [...this.base.get(c)!.values()];
      saveSnapshot({
        v: CACHE_VERSION,
        key,
        savedAt: Date.now(),
        applied: this.applied,
        meId: st.meId,
        workspace: st.workspace,
        workspaces: st.workspaces,
        collections,
      });
    }, 1500);
  }

  private onBeforeUnload = (e: BeforeUnloadEvent) => {
    // 未送信の変更があるときは、閉じる前に確認する
    if (this.pending.some((p) => p.state !== "sent")) {
      e.preventDefault();
      e.returnValue = "";
    }
  };

  stop() {
    this.generation++;
    this.timers.forEach(clearTimeout);
    this.intervals.forEach(clearInterval);
    this.timers = [];
    this.intervals = [];
    window.removeEventListener("focus", this.onFocus);
    window.removeEventListener("online", this.onOnline);
    window.removeEventListener("beforeunload", this.onBeforeUnload);
    document.removeEventListener("visibilitychange", this.onFocus);
    if (this.snapshotTimer) clearTimeout(this.snapshotTimer);
    if (this.socket) {
      this.socket.onclose = null;
      this.socket.close();
      this.socket = null;
    }
    this.pending.forEach((p) => p.resolve(false));
    this.pending = [];
    this.applied = 0;
    this.resetBase();
    this.wsKey = null;
  }

  private onFocus = () => {
    if (document.visibilityState === "visible") this.pull();
  };
  private onOnline = () => {
    this.flush();
    this.pull();
  };

  private async bootstrap() {
    const data = await api<BootstrapPayload>(`/api/bootstrap?ws=${encodeURIComponent(this.wsKey!)}`);
    this.resetBase();
    const put = (c: CollectionKey, list: { id: string }[]) => {
      const m = this.base.get(c)!;
      for (const x of list) m.set(x.id, x);
    };
    put("users", data.users);
    this.base.get("users")!.set(data.me.id, data.me);
    put("teams", data.teams);
    put("states", data.states);
    put("labels", data.labels);
    put("projects", data.projects);
    put("cycles", data.cycles);
    put("issues", data.issues);
    put("notifications", data.notifications);
    this.applied = data.lastSyncId;
    const view: Partial<DataState> = {
      status: "ready",
      error: null,
      meId: data.me.id,
      workspace: data.workspace,
      workspaces: data.workspaces,
      threads: {},
      comments: {},
      activities: {},
    };
    for (const c of COLLECTIONS) view[c] = this.computeCollection(c) as never;
    useData.setState(view);
    this.scheduleSnapshot();
  }

  // ---------------- 状態の再計算 ----------------
  private compute(c: CollectionKey, id: string): any {
    let v = this.base.get(c)!.get(id);
    for (const op of this.pending) {
      for (const e of op.effects) if (e.c === c && e.id === id) v = e.fn(v);
    }
    return v;
  }

  private computeCollection(c: CollectionKey): Record<string, any> {
    const out: Record<string, any> = {};
    const ids = new Set(this.base.get(c)!.keys());
    for (const op of this.pending) for (const e of op.effects) if (e.c === c) ids.add(e.id);
    for (const id of ids) {
      const v = this.compute(c, id);
      if (v !== undefined && v !== null) out[id] = v;
    }
    return out;
  }

  private markDirty(c: CollectionKey, id: string) {
    let s = this.dirty.get(c);
    if (!s) this.dirty.set(c, (s = new Set()));
    s.add(id);
    this.scheduleCommit();
  }

  private scheduleCommit() {
    if (!this.commitScheduled) {
      this.commitScheduled = true;
      queueMicrotask(() => this.commit());
    }
  }

  private commit() {
    this.commitScheduled = false;
    const state = useData.getState();
    const patch: Partial<DataState> = {};
    for (const [c, ids] of this.dirty) {
      const next = { ...(state[c] as Record<string, any>) };
      for (const id of ids) {
        const v = this.compute(c, id);
        if (v === undefined || v === null) delete next[id];
        else next[id] = v;
      }
      (patch as any)[c] = next;
    }
    this.dirty.clear();
    if (state.pendingCount !== this.pending.length) patch.pendingCount = this.pending.length;
    if (state.syncStatus !== "offline") {
      const s = this.pending.length ? "syncing" : "synced";
      if (state.syncStatus !== s) patch.syncStatus = s;
    }
    if (Object.keys(patch).length) useData.setState(patch);
  }

  // ---------------- 変更（楽観的更新） ----------------
  mutate(mutation: Mutation, effects: Effect[] = []): Promise<boolean> {
    return new Promise((resolve) => {
      const op: PendingOp = { clientId: uuid(), mutation, effects, state: "queued", resolve };
      this.pending.push(op);
      for (const e of effects) this.markDirty(e.c, e.id);
      if (!effects.length) this.scheduleCommit();
      queueMicrotask(() => this.flush());
    });
  }

  /** 現在の表示値（pending を含む） */
  current<T = any>(c: CollectionKey, id: string): T | undefined {
    return this.compute(c, id);
  }

  private async flush() {
    if (this.flushing || !this.wsKey) return;
    const batch = this.pending.filter((p) => p.state === "queued").slice(0, 100);
    if (!batch.length) return;
    this.flushing = true;
    batch.forEach((p) => (p.state = "inflight"));
    const gen = this.generation;
    try {
      const res = await api<MutateResponse>(`/api/mutate?ws=${encodeURIComponent(this.wsKey)}`, {
        body: { ops: batch.map((p) => ({ clientId: p.clientId, mutation: p.mutation })) },
      });
      if (gen !== this.generation) return;
      this.flushRetry = 1000;
      if (useData.getState().syncStatus === "offline") useData.setState({ syncStatus: "syncing" });
      for (const r of res.results) {
        const op = batch.find((p) => p.clientId === r.clientId);
        if (!op) continue;
        if (r.ok) {
          op.state = "sent";
          op.syncId = res.lastSyncId;
          op.resolve(true);
        } else {
          this.dropOp(op);
          this.emitError(r.error ?? "変更を保存できませんでした");
          op.resolve(false);
        }
      }
      if (res.lastSyncId > this.applied) await this.pull();
      else this.confirmApplied();
    } catch (e) {
      if (gen !== this.generation) return;
      const status = e instanceof ApiError ? e.status : 0;
      if (status === 401) {
        this.unauthorizedListeners.forEach((f) => f());
        return;
      }
      if (status === 0 || status >= 500 || status === 429) {
        // 通信エラー：変更は手元に残したまま、時間をおいて再送する
        batch.forEach((p) => (p.state = "queued"));
        useData.setState({ syncStatus: "offline" });
        const delay = this.flushRetry;
        this.flushRetry = Math.min(this.flushRetry * 2, 30_000);
        this.timers.push(setTimeout(() => this.flush(), delay));
      } else {
        batch.forEach((op) => {
          this.dropOp(op);
          op.resolve(false);
        });
        this.emitError((e as Error).message);
      }
    } finally {
      if (gen === this.generation) {
        this.flushing = false;
        if (this.pending.some((p) => p.state === "queued") && useData.getState().syncStatus !== "offline") {
          queueMicrotask(() => this.flush());
        }
      }
    }
  }

  private dropOp(op: PendingOp) {
    const i = this.pending.indexOf(op);
    if (i >= 0) this.pending.splice(i, 1);
    for (const e of op.effects) this.markDirty(e.c, e.id);
    this.scheduleCommit();
  }

  private confirmApplied() {
    const done = this.pending.filter((p) => p.state === "sent" && (p.syncId ?? Infinity) <= this.applied);
    done.forEach((op) => this.dropOp(op));
  }

  // ---------------- 差分取得 ----------------
  async pull(): Promise<void> {
    if (!this.wsKey || useData.getState().status !== "ready") return;
    if (this.pulling) {
      this.pullAgain = true;
      return;
    }
    this.pulling = true;
    const gen = this.generation;
    try {
      for (let i = 0; i < 20; i++) {
        const res = await api<{ changes: SyncChange[]; lastSyncId: number; hasMore: boolean }>(
          `/api/sync?ws=${encodeURIComponent(this.wsKey)}&after=${this.applied}`,
        );
        if (gen !== this.generation) return;
        if (res.lastSyncId < this.applied) {
          // サーバー側のデータが作り直された → 読み込み直す
          await this.bootstrap();
          break;
        }
        if ((res as { reset?: boolean }).reset) {
          // 古すぎて差分が残っていない → 全体を読み込み直す
          await this.bootstrap();
          break;
        }
        for (const ch of res.changes) this.applyChange(ch);
        if (res.changes.length || res.lastSyncId !== this.applied) this.scheduleSnapshot();
        this.applied = res.lastSyncId;
        if (!res.hasMore) break;
      }
      if (useData.getState().syncStatus === "offline") useData.setState({ syncStatus: "syncing" });
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) this.unauthorizedListeners.forEach((f) => f());
      else if (e instanceof ApiError && e.status === 0) useData.setState({ syncStatus: "offline" });
      else if (e instanceof ApiError && (e.status === 403 || e.status === 404)) {
        // メンバーから外された・ワークスペースが消えた など
        useData.setState({ status: "error", error: e.message });
      }
    } finally {
      if (gen === this.generation) {
        this.pulling = false;
        this.confirmApplied();
        this.scheduleCommit();
        if (this.pullAgain) {
          this.pullAgain = false;
          this.pull();
        }
      }
    }
  }

  private applyChange(ch: SyncChange) {
    if (ch.entity === "workspace") {
      if (ch.op === "upsert" && ch.data) useData.setState({ workspace: ch.data as DataState["workspace"] });
      return;
    }
    const c = ENTITY_COLLECTION[ch.entity];
    if (!c) return;
    const m = this.base.get(c)!;
    if (ch.op === "delete") m.delete(ch.entityId);
    else if (c === "users" && ch.entityId === useData.getState().meId) {
      m.set(ch.entityId, { ...m.get(ch.entityId), ...(ch.data as object) });
    } else m.set(ch.entityId, ch.data);
    this.markDirty(c, ch.entityId);
  }

  // ---------------- コメント・履歴の遅延読み込み ----------------
  async loadThread(issueId: string, force = false) {
    const st = useData.getState();
    if (!this.wsKey || (!force && st.threads[issueId])) return;
    useData.setState({ threads: { ...st.threads, [issueId]: "loading" } });
    try {
      const res = await api<{ comments: { id: string }[]; activities: { id: string }[] }>(
        `/api/issues/${issueId}/thread?ws=${encodeURIComponent(this.wsKey)}`,
      );
      const cm = this.base.get("comments")!;
      const am = this.base.get("activities")!;
      res.comments.forEach((x) => {
        cm.set(x.id, x);
        this.markDirty("comments", x.id);
      });
      res.activities.forEach((x) => {
        am.set(x.id, x);
        this.markDirty("activities", x.id);
      });
      useData.setState({ threads: { ...useData.getState().threads, [issueId]: "loaded" } });
      this.scheduleSnapshot();
    } catch {
      const t = { ...useData.getState().threads };
      delete t[issueId];
      useData.setState({ threads: t });
    }
  }

  // ---------------- リアルタイム ----------------
  private connectRealtime() {
    if (!this.realtimeEnabled || typeof WebSocket === "undefined" || !this.wsKey) return;
    const gen = this.generation;
    const proto = location.protocol === "https:" ? "wss" : "ws";
    let socket: WebSocket;
    try {
      socket = new WebSocket(`${proto}://${location.host}/api/realtime?ws=${encodeURIComponent(this.wsKey)}`);
    } catch {
      return;
    }
    this.socket = socket;
    let ping: ReturnType<typeof setInterval> | null = null;
    socket.onopen = () => {
      this.socketRetry = 1000;
      useData.setState({ realtime: true });
      ping = setInterval(() => socket.readyState === 1 && socket.send("ping"), 25_000);
      this.pull();
    };
    socket.onmessage = (ev) => {
      if (typeof ev.data !== "string" || ev.data === "pong") return;
      try {
        const msg = JSON.parse(ev.data) as { type: string; lastSyncId?: number };
        if (msg.type === "sync" && (msg.lastSyncId ?? 0) > this.applied) this.pull();
      } catch {
        // noop
      }
    };
    socket.onclose = () => {
      if (ping) clearInterval(ping);
      useData.setState({ realtime: false });
      if (gen !== this.generation) return;
      const delay = this.socketRetry;
      this.socketRetry = Math.min(this.socketRetry * 2, 30_000);
      this.timers.push(setTimeout(() => this.connectRealtime(), delay));
    };
  }
}

export const engine = new SyncEngine();

if (typeof window !== "undefined") {
  // デバッグ・E2E テスト用
  (window as unknown as { __senEngine: SyncEngine }).__senEngine = engine;
}
