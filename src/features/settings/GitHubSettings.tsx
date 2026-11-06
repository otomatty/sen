import { useEffect, useState } from "react";
import type { GitHubRepo, GitHubStatus, WorkflowState } from "../../../shared/types";
import { useIsAdmin } from "../../app/hooks";
import { ApiError, api } from "../../lib/api";
import { Button } from "../../components/ui";
import { confirmDialog } from "../../components/ConfirmDialog";
import { useData } from "../../store/data";
import { engine } from "../../store/engine";
import { useTeams } from "../../store/selectors";
import { toast } from "../../store/ui";
import { Field, Section } from "./parts";

/** 設定 → ワークスペースの「GitHub 連携」。対象のワークスペースだけで出す */
export function GitHubSection() {
  const isDemo = typeof __SEN_DEMO__ !== "undefined" && __SEN_DEMO__;
  const wsKey = useData((s) => s.workspace?.urlKey ?? "");
  const admin = useIsAdmin();
  const teams = useTeams();
  const repos = useData((s) => s.githubRepos);
  const states = useData((s) => s.states);
  const [status, setStatus] = useState<GitHubStatus | null>(null);

  useEffect(() => {
    if (isDemo || !wsKey) return;
    let gone = false;
    setStatus(null);
    void api<GitHubStatus>(`/api/github/status?ws=${encodeURIComponent(wsKey)}`)
      .then((next) => {
        if (!gone) setStatus(next);
      })
      .catch(() => {
        if (!gone) setStatus({ enabled: false, login: null, error: null, webhookUrl: "" });
      });
    return () => {
      gone = true;
    };
  }, [isDemo, wsKey]);

  if (isDemo || !wsKey || !status?.enabled) return null;

  const refresh = async () => {
    await engine.pull();
    try {
      const next = await api<GitHubStatus>(`/api/github/status?ws=${encodeURIComponent(wsKey)}`);
      setStatus(next);
    } catch {
      // 状態の取り直しに失敗しても、連携そのものは残す
    }
  };

  return (
    <Section
      title="GitHub 連携"
      testId="github-section"
      description="チーム 1 つと GitHub のリポジトリ 1 つを対応させます。トークンの値はここには出ません。"
    >
      <Field label="トークン">
        <div>
          <div data-testid="github-login">{status.login ? `トークンのユーザー：${status.login}` : "トークンのユーザーを取得できませんでした"}</div>
          {status.error && (
            <div className="text-danger" data-testid="github-error">
              {status.error}
            </div>
          )}
        </div>
      </Field>
      {teams.map((team) => {
        const repo = repos[team.id];
        const teamStates = Object.values(states)
          .filter((state) => state.teamId === team.id)
          .sort((a, b) => a.position - b.position);
        return (
          <div key={team.id} className="github-block" data-testid={`github-team-${team.key}`}>
            <div className="field-label">
              <span>{team.name}</span>
              <span className="muted small">{team.key}</span>
            </div>
            {repo ? (
              <LinkedRepo repo={repo} teamKey={team.key} states={teamStates} admin={admin} webhookUrl={status.webhookUrl} onChanged={refresh} />
            ) : admin ? (
              <LinkForm wsKey={wsKey} teamId={team.id} teamKey={team.key} onLinked={refresh} />
            ) : (
              <p className="muted">まだ連携していません</p>
            )}
          </div>
        );
      })}
    </Section>
  );
}

function LinkForm({ wsKey, teamId, teamKey, onLinked }: { wsKey: string; teamId: string; teamKey: string; onLinked: () => Promise<void> }) {
  const [repo, setRepo] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    const name = repo.trim();
    if (!name || busy) return;
    setBusy(true);
    try {
      await api(`/api/github/repos?ws=${encodeURIComponent(wsKey)}`, { method: "POST", body: { teamId, repo: name } });
      setRepo("");
      await onLinked();
      toast("リポジトリを連携しました");
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "連携に失敗しました", { kind: "error" });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="github-row">
      <input
        className="input"
        value={repo}
        placeholder="owner/name"
        aria-label={`${teamKey} のリポジトリ`}
        data-testid={`github-repo-${teamKey}`}
        onChange={(e) => setRepo(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") void submit();
        }}
      />
      <Button type="button" data-testid={`github-link-${teamKey}`} disabled={busy || !repo.trim()} onClick={() => void submit()}>
        {busy ? "連携しています…" : "連携する"}
      </Button>
    </div>
  );
}

function LinkedRepo({
  repo,
  teamKey,
  states,
  admin,
  webhookUrl,
  onChanged,
}: {
  repo: GitHubRepo;
  teamKey: string;
  states: WorkflowState[];
  admin: boolean;
  webhookUrl: string;
  onChanged: () => Promise<void>;
}) {
  const wsKey = useData((s) => s.workspace?.urlKey ?? "");
  const [draft, setDraft] = useState(repo.prDraftStateId ?? "");
  const [open, setOpen] = useState(repo.prOpenStateId ?? "");
  const [merged, setMerged] = useState(repo.prMergedStateId ?? "");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setDraft(repo.prDraftStateId ?? "");
    setOpen(repo.prOpenStateId ?? "");
    setMerged(repo.prMergedStateId ?? "");
  }, [repo.prDraftStateId, repo.prOpenStateId, repo.prMergedStateId]);

  const save = async () => {
    if (!wsKey || busy) return;
    setBusy(true);
    try {
      await api(`/api/github/repos/${repo.teamId}?ws=${encodeURIComponent(wsKey)}`, {
        method: "PATCH",
        body: {
          prDraftStateId: draft || null,
          prOpenStateId: open || null,
          prMergedStateId: merged || null,
        },
      });
      await onChanged();
      toast("保存しました");
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "保存に失敗しました", { kind: "error" });
    } finally {
      setBusy(false);
    }
  };

  const unlink = async () => {
    if (!wsKey || busy) return;
    const ok = await confirmDialog({
      title: "GitHub との連携を外しますか？",
      message: "このリポジトリの課題とプルリクエストの紐づけを消します。GitHub の Issue と Sen の課題そのものは残り、自動で作った Webhook も消します。",
      confirmLabel: "連携を外す",
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      await api(`/api/github/repos/${repo.teamId}?ws=${encodeURIComponent(wsKey)}`, { method: "DELETE" });
      await onChanged();
      toast("連携を外しました");
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "連携を外せませんでした", { kind: "error" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <div className="github-row">
        <a href={`https://github.com/${repo.repo}`} target="_blank" rel="noopener noreferrer" data-testid={`github-repo-name-${teamKey}`}>
          {repo.repo}
        </a>
        {admin && (
          <Button type="button" variant="ghost" data-testid={`github-unlink-${teamKey}`} disabled={busy} onClick={() => void unlink()}>
            連携を外す
          </Button>
        )}
      </div>
      <div className="github-hook" data-testid={`github-webhook-${teamKey}`}>
        {repo.hook === "auto" ? (
          <span>自動で作成済み</span>
        ) : (
          <div data-testid={`github-webhook-manual-${teamKey}`}>
            <p>手で設定してください。</p>
            <p>
              URL: <code className="github-url" data-testid={`github-webhook-url-${teamKey}`}>{webhookUrl}</code>
            </p>
            <p>選ぶイベント: Issues、Issue comments、Pull requests。Content type は application/json です。</p>
            <p>secret には、環境変数 GITHUB_WEBHOOK_SECRET の値を入れてください。</p>
          </div>
        )}
      </div>
      <div className="github-pr">
        <PrSelect label="下書きの PR" testId={`github-pr-draft-${teamKey}`} value={draft} states={states} disabled={!admin} onChange={setDraft} />
        <PrSelect label="レビュー待ちの PR" testId={`github-pr-open-${teamKey}`} value={open} states={states} disabled={!admin} onChange={setOpen} />
        <PrSelect label="マージした PR" testId={`github-pr-merged-${teamKey}`} value={merged} states={states} disabled={!admin} onChange={setMerged} />
      </div>
      {admin && (
        <div className="github-row">
          <Button type="button" data-testid={`github-pr-save-${teamKey}`} disabled={busy} onClick={() => void save()}>
            {busy ? "保存しています…" : "自動の移動を保存"}
          </Button>
        </div>
      )}
    </div>
  );
}

function PrSelect({
  label,
  testId,
  value,
  states,
  disabled,
  onChange,
}: {
  label: string;
  testId: string;
  value: string;
  states: WorkflowState[];
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <label className="github-pr-field">
      <span className="muted small">{label}</span>
      <select className="input" aria-label={label} data-testid={testId} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
        <option value="">変えない</option>
        {states.map((state) => (
          <option key={state.id} value={state.id}>
            {state.name}
          </option>
        ))}
      </select>
    </label>
  );
}
