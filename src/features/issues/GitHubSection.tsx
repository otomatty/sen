import { useState } from "react";
import type { GitHubLink, GitHubPull, GitHubPullState } from "../../../shared/types";
import { ApiError, api } from "../../lib/api";
import { formatDateTime } from "../../lib/utils";
import { Button, Modal } from "../../components/ui";
import { useData } from "../../store/data";
import { engine } from "../../store/engine";
import { toast } from "../../store/ui";

const PULL_LABEL: Record<GitHubPullState, string> = {
  draft: "下書き",
  open: "レビュー待ち",
  merged: "マージ済み",
  closed: "閉じた",
};

/** 課題の詳細の GitHub 区画。今のチームの連携、紐づけ、プルリクエストのいずれかがあるとき出す */
export function IssueGitHubSection({ issueId, teamId }: { issueId: string; teamId: string }) {
  const repo = useData((s) => s.githubRepos[teamId]);
  const link = useData((s) => s.githubLinks[issueId]);
  const pullMap = useData((s) => s.githubPulls);
  const wsKey = useData((s) => s.workspace?.urlKey ?? "");
  const pulls = Object.values(pullMap)
    .filter((pull) => pull.issueId === issueId)
    .sort((a, b) => a.number - b.number || (a.repo < b.repo ? -1 : a.repo > b.repo ? 1 : 0));
  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState(false);
  if (!wsKey || (!repo && !link && pulls.length === 0)) return null;

  const run = async (path: string, method: "POST" | "DELETE", body?: unknown) => {
    setBusy(true);
    try {
      await api(`/api/github${path}?ws=${encodeURIComponent(wsKey)}`, { method, body });
      await engine.pull();
      setDialog(false);
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "GitHub との同期に失敗しました");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="github-issue" data-testid="github-issue">
      <div className="section-title">GitHub</div>
      {link ? (
        <Linked link={link} busy={busy} onUnlink={() => void run(`/issues/${issueId}/link`, "DELETE")} />
      ) : repo ? (
        <div className="github-issue-actions">
          <button className="link-btn" type="button" data-testid="github-create" disabled={busy} onClick={() => void run(`/issues/${issueId}/link`, "POST", { mode: "create" })}>
            GitHub に Issue を作る
          </button>
          <button className="link-btn" type="button" data-testid="github-link-existing" disabled={busy} onClick={() => setDialog(true)}>
            既存の Issue と紐づける
          </button>
        </div>
      ) : null}
      {dialog && repo && (
        <LinkDialog
          busy={busy}
          onClose={() => setDialog(false)}
          onSubmit={(ref, prefer) => void run(`/issues/${issueId}/link`, "POST", { mode: "link", ref, prefer })}
        />
      )}
      <PullList pulls={pulls} />
    </section>
  );
}

function PullList({ pulls }: { pulls: GitHubPull[] }) {
  if (!pulls.length) return null;
  return (
    <ul className="github-pulls" data-testid="github-pulls">
      {pulls.map((pull) => (
        <li key={pull.id} className="github-pull" data-testid="github-pull">
          <a href={pull.url} target="_blank" rel="noreferrer">
            #{pull.number} {pull.title}
          </a>
          <span className={`pr-badge pr-badge-${pull.state}`} data-testid="github-pull-state">
            {PULL_LABEL[pull.state]}
          </span>
          {pull.author && (
            <span className="muted" data-testid="github-pull-author">
              {pull.author}
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

function Linked({ link, busy, onUnlink }: { link: GitHubLink; busy: boolean; onUnlink: () => void }) {
  const label = `${link.repo}#${link.number}`;
  return (
    <div className="github-issue-body">
      <div className="github-issue-row">
        <a href={link.url} target="_blank" rel="noreferrer" data-testid="github-issue-link">
          {label}
        </a>
        {link.syncedAt != null && (
          <span className="muted" data-testid="github-synced-at">
            最終同期 {formatDateTime(link.syncedAt)}
          </span>
        )}
        <span className="spacer" />
        <button className="link-btn" type="button" data-testid="github-unlink" disabled={busy} onClick={onUnlink}>
          紐づけを外す
        </button>
      </div>
      {link.lastError && (
        <p className="github-issue-error" data-testid="github-last-error">
          {link.lastError}
        </p>
      )}
    </div>
  );
}

function LinkDialog({
  busy,
  onClose,
  onSubmit,
}: {
  busy: boolean;
  onClose: () => void;
  onSubmit: (ref: string, prefer: "sen" | "github") => void;
}) {
  const [ref, setRef] = useState("");
  const [prefer, setPrefer] = useState<"sen" | "github" | null>(null);
  return (
    <Modal onClose={onClose} width={420} testId="github-link-dialog">
      <div className="confirm-body">
        <h2>既存の Issue と紐づける</h2>
        <p>番号、owner/repo#番号、Issue の URL のどれかを入力してください。</p>
        <input
          className="input"
          value={ref}
          placeholder="acme/widgets#12"
          data-testid="github-link-ref"
          onChange={(e) => setRef(e.target.value)}
        />
        <div className="github-issue-prefer">
          <label>
            <input type="radio" name="github-prefer" data-testid="github-link-prefer-sen" checked={prefer === "sen"} onChange={() => setPrefer("sen")} />
            Sen に合わせる
          </label>
          <label>
            <input type="radio" name="github-prefer" data-testid="github-link-prefer-github" checked={prefer === "github"} onChange={() => setPrefer("github")} />
            GitHub に合わせる
          </label>
        </div>
      </div>
      <div className="create-foot">
        <span className="spacer" />
        <Button variant="ghost" onClick={onClose}>
          キャンセル
        </Button>
        <Button data-testid="github-link-submit" disabled={busy || !ref.trim() || !prefer} onClick={() => prefer && onSubmit(ref.trim(), prefer)}>
          紐づける
        </Button>
      </div>
    </Modal>
  );
}
