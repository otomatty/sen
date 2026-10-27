import { useState, type ReactNode } from "react";
import { useNavigate } from "react-router";
import { Copy, Flag, Link2, OctagonMinus, Plus, X } from "lucide-react";
import type { Issue } from "../../../shared/types";
import { RELATION_LABEL, unrelateIssue, type RelationKind } from "../../store/actions";
import { useData } from "../../store/data";
import { useIssueRelations } from "../../store/selectors";
import { openPicker, toast } from "../../store/ui";
import { cx, identifier } from "../../lib/utils";
import { Avatar, Menu, Tooltip } from "../../components/ui";
import { StateIcon } from "../../components/pickers";
import { useWsPath } from "../../app/hooks";

// 課題どうしの関係（ブロック・関連・重複）。Linear と同じく「何に止められているか」を課題の中で見えるようにする。

export const RELATION_ICON: Record<RelationKind, ReactNode> = {
  blockedBy: <OctagonMinus size={14} />,
  blocks: <Flag size={14} />,
  related: <Link2 size={14} />,
  duplicate: <Copy size={14} />,
  duplicatedBy: <Copy size={14} />,
};

/** 関係を追加する操作（メニュー・コマンドパレット・ショートカットで共通） */
export const RELATION_ACTIONS: { kind: RelationKind; label: string; combo: string; keywords: string }[] = [
  { kind: "blockedBy", label: "ブロックされている課題を指定…", combo: "m b", keywords: "blocked by depends 依存" },
  { kind: "blocks", label: "ブロックしている課題を指定…", combo: "m x", keywords: "blocking blocks 依存" },
  { kind: "related", label: "関連する課題を指定…", combo: "m r", keywords: "related relation 関連" },
  { kind: "duplicate", label: "重複としてマーク…", combo: "m m", keywords: "duplicate 重複" },
];

const ORDER: RelationKind[] = ["blockedBy", "blocks", "related", "duplicate", "duplicatedBy"];

export function openRelationPicker(issueIds: string[], kind: RelationKind, anchor: DOMRect | null = null) {
  openPicker({ kind: "relation", relation: kind, issueIds, anchor });
}

/** 関係の種類を選ぶメニュー */
export function RelationMenu({ issueIds, anchor, onClose }: { issueIds: string[]; anchor: DOMRect; onClose: () => void }) {
  return (
    <Menu
      anchor={anchor}
      onClose={onClose}
      items={RELATION_ACTIONS.map((a) => ({
        label: a.label.replace("…", ""),
        icon: RELATION_ICON[a.kind],
        combo: a.combo,
        onSelect: () => openRelationPicker(issueIds, a.kind, anchor),
      }))}
    />
  );
}

export function AddRelationButton({ issueId }: { issueId: string }) {
  const [menu, setMenu] = useState<DOMRect | null>(null);
  return (
    <>
      <button
        className="link-btn add-sub"
        data-popover-anchor
        data-testid="add-relation"
        onClick={(e) => setMenu(menu ? null : e.currentTarget.getBoundingClientRect())}
      >
        <Link2 size={14} /> 関係を追加
      </button>
      {menu && <RelationMenu issueIds={[issueId]} anchor={menu} onClose={() => setMenu(null)} />}
    </>
  );
}

export function Relations({ issue }: { issue: Issue }) {
  const entries = useIssueRelations(issue.id);
  const teams = useData((s) => s.teams);
  const states = useData((s) => s.states);
  const users = useData((s) => s.users);
  const navigate = useNavigate();
  const p = useWsPath();
  const [menu, setMenu] = useState<DOMRect | null>(null);
  if (!entries.length) return null;
  const groups = ORDER.map((kind) => ({ kind, items: entries.filter((e) => e.kind === kind) })).filter((g) => g.items.length);
  const openBlockers = entries.filter((e) => e.kind === "blockedBy" && !["completed", "canceled"].includes(states[e.issue.stateId]?.type ?? "")).length;
  return (
    <section className="relations" data-testid="relations">
      <div className="section-title">
        関係
        <span className="muted">{entries.length}</span>
        {openBlockers > 0 && <span className="chip blocked-chip">未解決のブロック {openBlockers}件</span>}
        <span className="spacer" />
        <Tooltip label="関係を追加">
          <button
            className="icon-btn"
            data-popover-anchor
            aria-label="関係を追加"
            onClick={(e) => setMenu(menu ? null : e.currentTarget.getBoundingClientRect())}
          >
            <Plus size={14} />
          </button>
        </Tooltip>
      </div>
      {groups.map((g) => (
        <div key={g.kind} className="relation-group" data-kind={g.kind}>
          <div className={cx("relation-label", `rel-${g.kind}`)}>
            {RELATION_ICON[g.kind]}
            {RELATION_LABEL[g.kind]}
          </div>
          {g.items.map(({ issue: other }) => {
            const id = identifier(other, teams);
            const type = states[other.stateId]?.type;
            const finished = type === "completed" || type === "canceled";
            return (
              <div
                key={other.id}
                className="sub-row relation-row"
                data-testid="relation-row"
                data-kind={g.kind}
                data-identifier={id}
                onClick={() => navigate(p(`/issue/${id}`))}
              >
                <StateIcon stateId={other.stateId} />
                <span className="row-id">{id}</span>
                <span className={cx("row-title-text", finished && "muted")}>{other.title}</span>
                <span className="spacer" />
                <Avatar user={other.assigneeId ? users[other.assigneeId] : null} size={18} />
                <Tooltip label="関係を外す">
                  <button
                    className="icon-btn relation-remove"
                    aria-label="関係を外す"
                    onClick={(e) => {
                      e.stopPropagation();
                      unrelateIssue(issue.id, g.kind, other.id);
                      toast(`${id} との関係を外しました`);
                    }}
                  >
                    <X size={13} />
                  </button>
                </Tooltip>
              </div>
            );
          })}
        </div>
      ))}
      {menu && <RelationMenu issueIds={[issue.id]} anchor={menu} onClose={() => setMenu(null)} />}
    </section>
  );
}
