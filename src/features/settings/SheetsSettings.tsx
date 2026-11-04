import { useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import type { SheetSyncStatus } from "../../../shared/types";
import { useData } from "../../store/data";
import { toast } from "../../store/ui";
import { formatDateTime } from "../../lib/utils";
import { ApiError, api } from "../../lib/api";
import { Button } from "../../components/ui";
import { Field, Section } from "./parts";

const POLL_MS = 5000;

/** 設定 → ワークスペースの「スプレッドシート連携」。未設定・デモ・読み込み中は出さない */
export function SheetsSection() {
  const isDemo = typeof __SEN_DEMO__ !== "undefined" && __SEN_DEMO__;
  const wsKey = useData((s) => s.workspace?.urlKey ?? "");
  const [status, setStatus] = useState<SheetSyncStatus | null>(null);
  const [syncing, setSyncing] = useState(false);
  const gen = useRef(0);
  const wsKeyRef = useRef(wsKey);
  const pollTimer = useRef<number | null>(null);
  const syncingRef = useRef(false);
  const mounted = useRef(true);
  wsKeyRef.current = wsKey;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (isDemo || !wsKey) return;
    const g = ++gen.current;
    let gone = false;
    setStatus(null);
    void api<SheetSyncStatus>(`/api/sheets/status?ws=${wsKey}`)
      .then((next) => {
        if (gone || gen.current !== g) return;
        setStatus(next);
      })
      .catch(() => {
        if (gone || gen.current !== g) return;
        // 読めないときは未設定と同じにする（区画を出さない）
        setStatus({ enabled: false });
      });
    return () => {
      gone = true;
    };
  }, [isDemo, wsKey]);

  const polling = !isDemo && !!wsKey && !syncing && status?.enabled === true && status.pending === true;

  useEffect(() => {
    if (!polling) return;
    const timer = window.setInterval(() => {
      const g = gen.current;
      const key = wsKeyRef.current;
      if (!key) return;
      void api<SheetSyncStatus>(`/api/sheets/status?ws=${key}`)
        .then((next) => {
          if (mounted.current && gen.current === g) setStatus(next);
        })
        .catch(() => {
          // 取り直しに失敗しても、今の表示は残す
        });
    }, POLL_MS);
    pollTimer.current = timer;
    return () => {
      window.clearInterval(timer);
      if (pollTimer.current === timer) pollTimer.current = null;
    };
  }, [polling]);

  const syncNow = async () => {
    const key = wsKey;
    if (!key || syncingRef.current) return;
    syncingRef.current = true;
    const g = ++gen.current;
    if (pollTimer.current != null) {
      window.clearInterval(pollTimer.current);
      pollTimer.current = null;
    }
    setSyncing(true);
    try {
      const next = await api<SheetSyncStatus>(`/api/sheets/sync?ws=${key}`, { method: "POST" });
      if (mounted.current && gen.current === g && wsKeyRef.current === key) setStatus(next);
      if (next.lastError) toast("反映に失敗しました", { kind: "error" });
      else toast("スプレッドシートに反映しました");
    } catch (e) {
      const message = e instanceof ApiError ? e.message : e instanceof Error ? e.message : "反映に失敗しました";
      toast(message, { kind: "error" });
    } finally {
      syncingRef.current = false;
      if (mounted.current) setSyncing(false);
    }
  };

  if (isDemo || !wsKey || !status?.enabled) return null;

  const lastSync = status.lastSuccessAt != null ? formatDateTime(status.lastSuccessAt) : "まだ反映していません";

  return (
    <Section
      title="スプレッドシート連携"
      description="Sen で保存すると、約 30 秒後にスプレッドシートへ自動で反映されます。毎日 3 時ごろにも期限などを計算し直します。"
    >
      <Field label="最終反映">
        <div>
          <span data-testid="sheets-last-sync">{lastSync}</span>
          {status.pending && (
            <>
              {" "}
              <span className="muted" data-testid="sheets-pending">
                反映待ち
              </span>
            </>
          )}
          {status.lastError && (
            <div className="text-danger" data-testid="sheets-error">
              反映に失敗しました：{status.lastError}
              {status.lastAttemptAt != null ? `（${formatDateTime(status.lastAttemptAt)}）` : ""}
            </div>
          )}
        </div>
      </Field>
      <div className="invite-row">
        {status.spreadsheetUrl && (
          <a
            className="btn btn-secondary btn-md"
            href={status.spreadsheetUrl}
            target="_blank"
            rel="noopener noreferrer"
            data-testid="sheets-open"
          >
            スプレッドシートを開く
          </a>
        )}
        <Button type="button" icon={<RefreshCw size={14} />} data-testid="sheets-sync-now" disabled={syncing} onClick={() => void syncNow()}>
          {syncing ? "反映しています…" : "今すぐ反映"}
        </Button>
      </div>
    </Section>
  );
}
