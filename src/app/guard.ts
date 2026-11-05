import { useData } from "../store/data";

/** 未送信の変更がなくなるまで待つ。オフラインのときや時間内に送れなかったときは false */
export function waitForSync(timeout: number): Promise<boolean> {
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

/** 画面全体の操作を止める・戻す */
export function lockScreen(locked: boolean) {
  const root = document.getElementById("root");
  if (root) root.inert = locked;
}
