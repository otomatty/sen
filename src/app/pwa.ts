import { create } from "zustand";
import { useData } from "../store/data";
import { dismissToast, toast } from "../store/ui";
import { confirmDialog } from "../components/ConfirmDialog";
import { hasIssueDraft } from "../features/issues/CreateIssueModal";
import { hasCommentDraft } from "../features/issues/CommentComposer";

// PWA（インストールできるアプリ）としての振る舞い
//  - サービスワーカーを登録し、新しい版が届いたら「更新」を案内する
//  - ブラウザのインストールの提案を受け取り、メニューや設定からインストールできるようにする

/** Chrome / Edge などが出す、インストールの提案（標準化前の API なので型を自前で書く） */
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

interface PWAState {
  /** ブラウザのインストールの提案。インストールできるときだけ入る */
  installPrompt: BeforeInstallPromptEvent | null;
  /** インストールしたアプリとして（ブラウザのタブではなく）開いている */
  standalone: boolean;
  /** 新しい版が届いていて、更新を待っている */
  updateReady: boolean;
}

const DEMO = typeof __SEN_DEMO__ !== "undefined" && __SEN_DEMO__;
const standaloneQuery = typeof window !== "undefined" ? matchMedia("(display-mode: standalone)") : null;

function isStandalone() {
  return Boolean(standaloneQuery?.matches || (navigator as Navigator & { standalone?: boolean }).standalone);
}

export const usePWA = create<PWAState>(() => ({
  installPrompt: null,
  standalone: typeof window !== "undefined" && isStandalone(),
  updateReady: false,
}));

/** iPhone / iPad の Safari。インストールの提案が出ないので、ホーム画面への追加を案内する */
export function isIOS() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

/** ブラウザのインストール画面を出す */
export async function installApp() {
  const prompt = usePWA.getState().installPrompt;
  if (!prompt) return;
  try {
    await prompt.prompt();
  } catch {
    // 操作の直後でないなどの理由で出せなかった。提案は残しておき、もう一度押してもらう
    return;
  }
  await prompt.userChoice;
  // 提案は一度しか使えない
  usePWA.setState({ installPrompt: null });
}

// このファイルを含む JS のパス（/assets/index-xxxx.js）
const ENTRY = new URL(import.meta.url).pathname;
let waiting: ServiceWorker | null = null;
let reloadOnChange = false;
let updating = false;
let updateToast: number | null = null;

/** いま画面で使っている JS と CSS。新しい版にもすべてあれば、画面は最新 */
function currentFiles() {
  const css = [...document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')].map((l) => new URL(l.href).pathname);
  return [ENTRY, ...css].filter((p) => p.startsWith("/assets/"));
}

/** サービスワーカーに、いま動いている画面のコードがその版に含まれるかを尋ねる */
function hasCurrentCode(worker: ServiceWorker): Promise<boolean> {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = (e) => resolve(Boolean(e.data));
    worker.postMessage({ type: "has", paths: currentFiles() }, [channel.port2]);
    setTimeout(() => resolve(false), 3000);
  });
}

/** 未送信の変更がなくなるまで待つ。オフラインのときや時間内に送れなかったときは false */
function waitForSync(timeout: number): Promise<boolean> {
  return new Promise((resolve) => {
    const check = (s: ReturnType<typeof useData.getState>) => {
      if (s.pendingCount === 0) return finish(true);
      if (s.syncStatus === "offline") return finish(false);
    };
    const finish = (ok: boolean) => {
      clearTimeout(timer);
      off();
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), timeout);
    const off = useData.subscribe(check);
    check(useData.getState());
  });
}

/** 新しい版に切り替えて、画面を読み込み直す */
export async function applyUpdate() {
  const worker = waiting;
  if (!worker || updating) return;
  // 読み込み直すと消える書きかけの内容は、確かめてから捨てる
  if (hasIssueDraft() || hasCommentDraft()) {
    const ok = await confirmDialog({
      title: "書きかけの内容があります",
      message: "作成中の課題や書きかけのコメントは、更新すると失われます。更新しますか？",
      confirmLabel: "更新する",
      danger: true,
    });
    if (!ok) return;
  }
  updating = true;
  try {
    // 入力中の欄を確定させ、入力が止まってから保存する欄（説明文は 700 ミリ秒後）の送信が始まるのを待つ
    (document.activeElement as HTMLElement | null)?.blur?.();
    await new Promise((r) => setTimeout(r, 800));
    // 未送信の変更は読み込み直すと失われるので、送信が終わってから切り替える
    if (useData.getState().pendingCount > 0) toast("変更を送信してから更新します…");
    if (!(await waitForSync(15_000))) {
      toast("送信できていない変更があります。オンラインで同期が終わってから、もう一度お試しください", { kind: "error" });
      return;
    }
    // 別のタブですでに切り替わっていれば、読み込み直すだけでよい
    if (worker.state === "activating" || worker.state === "activated") {
      window.location.reload();
      return;
    }
    reloadOnChange = true;
    worker.postMessage({ type: "skip-waiting" });
  } finally {
    updating = false;
  }
}

function showToast(message: string, action: { label: string; run: () => void }) {
  if (updateToast !== null) dismissToast(updateToast);
  updateToast = toast(message, { action, duration: Infinity });
}

function showUpdate() {
  usePWA.setState({ updateReady: true });
  showToast("新しいバージョンがあります", { label: "更新", run: applyUpdate });
}

async function onWaiting(worker: ServiceWorker) {
  waiting = worker;
  if (await hasCurrentCode(worker)) {
    // 画面はすでに新しい版（ネットワークから読み込んだ）なので、保存内容だけ黙って入れ替える
    worker.postMessage({ type: "skip-waiting" });
  } else {
    showUpdate();
  }
}

async function register() {
  const sw = navigator.serviceWorker;
  const reg = await sw.register("/sw.js");
  let controller = sw.controller;

  sw.addEventListener("controllerchange", async () => {
    const prev = controller;
    controller = sw.controller;
    // 初めてのインストールでは何もしない
    if (!prev || !controller) return;
    if (reloadOnChange) {
      window.location.reload();
      return;
    }
    // 別のタブで更新された：この画面のコードが古ければ読み込み直しを案内する
    if (!(await hasCurrentCode(controller))) {
      waiting = controller;
      usePWA.setState({ updateReady: true });
      showToast("新しいバージョンに更新されました", { label: "再読み込み", run: applyUpdate });
    }
  });

  if (reg.waiting && sw.controller) onWaiting(reg.waiting);
  reg.addEventListener("updatefound", () => {
    const worker = reg.installing;
    worker?.addEventListener("statechange", () => {
      if (worker.state === "installed" && sw.controller) onWaiting(worker);
    });
  });

  // 開いたままのアプリでも新しい版に気づけるよう、ときどき確かめる
  let lastCheck = Date.now();
  const check = () => {
    if (Date.now() - lastCheck < 30 * 60_000) return;
    lastCheck = Date.now();
    reg.update().catch(() => {
      // オフラインなら次の機会に
    });
  };
  setInterval(check, 60 * 60_000);
  document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && check());
}

export function initPWA() {
  // ブラウザ内デモ（単一 HTML）はインストールもオフライン起動もしない
  if (DEMO) return;
  window.addEventListener("beforeinstallprompt", (e) => {
    // ブラウザ任せの案内は出さず、メニューや設定から好きなときにインストールしてもらう
    e.preventDefault();
    usePWA.setState({ installPrompt: e as BeforeInstallPromptEvent });
  });
  window.addEventListener("appinstalled", () => {
    usePWA.setState({ installPrompt: null });
    toast("アプリとしてインストールしました", { kind: "success" });
  });
  standaloneQuery?.addEventListener?.("change", () => usePWA.setState({ standalone: isStandalone() }));

  // オフラインでも起動できるよう、本番ビルドではサービスワーカーを登録する
  if (import.meta.env.PROD && "serviceWorker" in navigator) {
    const start = () =>
      register().catch(() => {
        // 登録できなくても通常どおり動く
      });
    if (document.readyState === "complete") start();
    else window.addEventListener("load", start, { once: true });
  }
}
