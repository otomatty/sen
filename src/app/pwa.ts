import { create } from "zustand";
import { useData } from "../store/data";
import { dismissToast, toast } from "../store/ui";

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

// このファイルを含む JS のパス（/assets/index-xxxx.js）。新しい版にも同じファイルがあれば、画面のコードは最新
const ENTRY = new URL(import.meta.url).pathname;
let waiting: ServiceWorker | null = null;
let reloadOnChange = false;
let updateToast: number | null = null;

/** サービスワーカーに、いま動いている画面のコードがその版に含まれるかを尋ねる */
function hasCurrentCode(worker: ServiceWorker): Promise<boolean> {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = (e) => resolve(Boolean(e.data));
    worker.postMessage({ type: "has", path: ENTRY }, [channel.port2]);
    setTimeout(() => resolve(false), 3000);
  });
}

/** 新しい版に切り替えて、画面を読み込み直す */
export function applyUpdate() {
  if (!waiting) return;
  // 未送信の変更は読み込み直すと失われるので、送信が終わるのを待ってもらう
  if (useData.getState().pendingCount > 0) {
    toast("送信中の変更があります。同期が終わってから、もう一度お試しください", { kind: "error" });
    return;
  }
  // 別のタブですでに切り替わっていれば、読み込み直すだけでよい
  if (waiting.state === "activating" || waiting.state === "activated") {
    window.location.reload();
    return;
  }
  reloadOnChange = true;
  waiting.postMessage({ type: "skip-waiting" });
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
