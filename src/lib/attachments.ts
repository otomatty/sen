import { useEffect, useState } from "react";
import { ATTACHMENT_FILE_MAX_BYTES, ATTACHMENT_IMAGE_MAX_BYTES } from "../../shared/constants";
import { api } from "./api";

let filesEnabled: Promise<boolean> | null = null;
let known: boolean | null = null;

/** 成功した添付設定だけを覚え、失敗した場合は次回の取得で読み直す */
export function loadFilesEnabled(): Promise<boolean> {
  return filesEnabled ??= api<{ files: boolean }>("/api/health").then((health) => {
    known = health.files === true;
    return known;
  }, () => {
    filesEnabled = null;
    return false;
  });
}

export function useFilesEnabled(): boolean {
  const [enabled, setEnabled] = useState(() => known ?? false);
  useEffect(() => {
    let mounted = true;
    const load = () => {
      void loadFilesEnabled().then((value) => { if (mounted) setEnabled(value); });
    };
    const onOnline = () => {
      if (known === null) load();
    };
    window.addEventListener("online", onOnline);
    load();
    return () => {
      mounted = false;
      window.removeEventListener("online", onOnline);
    };
  }, []);
  return enabled;
}

export function useOnline(): boolean {
  const [online, setOnline] = useState(() => navigator.onLine);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    update();
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);
  return online;
}

export function checkAttachment(file: File): string | null {
  if (file.size === 0) return "空のファイルは添付できません";
  const image = ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(file.type);
  if (file.size > (image ? ATTACHMENT_IMAGE_MAX_BYTES : ATTACHMENT_FILE_MAX_BYTES)) return "画像は 10 MB、それ以外は 25 MB までです";
  return null;
}
