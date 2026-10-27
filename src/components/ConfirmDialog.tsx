import { create } from "zustand";
import { Button, Modal } from "./ui";
import { SCOPE, useHotkeys } from "../lib/hotkeys";

// ブラウザ標準の confirm() の代わりに使う確認ダイアログ（見た目をアプリにそろえ、埋め込み環境でも動くように）

interface ConfirmRequest {
  title: string;
  message?: string;
  confirmLabel?: string;
  danger?: boolean;
  resolve: (ok: boolean) => void;
}

const useConfirm = create<{ req: ConfirmRequest | null }>(() => ({ req: null }));

export function confirmDialog(opts: Omit<ConfirmRequest, "resolve">): Promise<boolean> {
  return new Promise((resolve) => {
    useConfirm.getState().req?.resolve(false);
    useConfirm.setState({ req: { ...opts, resolve } });
  });
}

export function ConfirmHost() {
  const req = useConfirm((s) => s.req);
  if (!req) return null;
  return <Dialog req={req} />;
}

function Dialog({ req }: { req: ConfirmRequest }) {
  const done = (ok: boolean) => {
    useConfirm.setState({ req: null });
    req.resolve(ok);
  };
  useHotkeys("enter", () => done(true), { allowInInput: true, scope: SCOPE.overlay + 30 });
  return (
    <Modal onClose={() => done(false)} width={440} className="confirm-dialog" testId="confirm-dialog" align="center">
      <div className="confirm-body">
        <h2>{req.title}</h2>
        {req.message && <p>{req.message}</p>}
      </div>
      <div className="create-foot">
        <span className="spacer" />
        <Button variant="ghost" onClick={() => done(false)}>
          キャンセル
        </Button>
        <Button variant={req.danger ? "danger" : "primary"} onClick={() => done(true)} autoFocus data-testid="confirm-ok">
          {req.confirmLabel ?? "OK"}
        </Button>
      </div>
    </Modal>
  );
}
