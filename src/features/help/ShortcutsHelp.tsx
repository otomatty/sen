import { useState } from "react";
import { X } from "lucide-react";
import { useUI } from "../../store/ui";
import { fuzzyMatch } from "../../lib/utils";
import { Kbd, Modal } from "../../components/ui";
import { SHORTCUT_GROUPS } from "./shortcuts";

export function ShortcutsHelp() {
  const open = useUI((s) => s.shortcutsOpen);
  const [q, setQ] = useState("");
  if (!open) return null;
  const close = () => useUI.setState({ shortcutsOpen: false });
  return (
    <Modal onClose={close} width={720} className="shortcuts-modal" testId="shortcuts-help">
      <div className="modal-head">
        <h2>キーボードショートカット</h2>
        <span className="spacer" />
        <button className="icon-btn" onClick={close} aria-label="閉じる">
          <X size={16} />
        </button>
      </div>
      <input className="shortcuts-search" placeholder="ショートカットを検索…" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
      <div className="shortcuts-grid">
        {SHORTCUT_GROUPS.map((g) => {
          const items = g.items.filter(([, label]) => fuzzyMatch(label, q));
          if (!items.length) return null;
          return (
            <section key={g.title}>
              <h3>{g.title}</h3>
              {items.map(([combo, label]) => (
                <div key={combo + label} className="shortcut-row">
                  <span>{label}</span>
                  <Kbd combo={combo} />
                </div>
              ))}
            </section>
          );
        })}
      </div>
    </Modal>
  );
}
