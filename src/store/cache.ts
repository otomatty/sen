// ワークスペースのデータを IndexedDB に保存しておき、次回の起動で即座に表示するためのキャッシュ。
// 起動時はキャッシュから描画 → 差分（/api/sync）だけを取得して最新にする。

export const CACHE_VERSION = 3;

export interface Snapshot {
  v: number;
  key: string;
  savedAt: number;
  applied: number;
  meId: string;
  workspace: unknown;
  workspaces: unknown;
  collections: Record<string, unknown[]>;
}

const DB_NAME = "sen-cache";
const STORE = "snapshots";

function open(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      if (typeof indexedDB === "undefined") return resolve(null);
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

export async function loadSnapshot(key: string): Promise<Snapshot | null> {
  const db = await open();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const req = db.transaction(STORE).objectStore(STORE).get(key);
      req.onsuccess = () => {
        const s = req.result as Snapshot | undefined;
        resolve(s && s.v === CACHE_VERSION ? s : null);
      };
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

export async function saveSnapshot(s: Snapshot): Promise<void> {
  const db = await open();
  if (!db) return;
  try {
    db.transaction(STORE, "readwrite").objectStore(STORE).put(s, s.key);
  } catch {
    // 容量不足などは無視（キャッシュが無くても動く）
  }
}

export async function clearSnapshots(): Promise<void> {
  const db = await open();
  if (!db) return;
  try {
    db.transaction(STORE, "readwrite").objectStore(STORE).clear();
  } catch {
    // noop
  }
}
