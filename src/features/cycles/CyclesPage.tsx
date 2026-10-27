import { useMemo } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { Plus } from "lucide-react";
import type { Cycle, Issue, WorkflowState } from "../../../shared/types";
import { diffDays } from "../../../shared/dates";
import { useData } from "../../store/data";
import { createCycle, updateTeam } from "../../store/actions";
import { cycleName, cycleStatus, useActiveIssues, useCycles, useTeamByKey } from "../../store/selectors";
import { toast } from "../../store/ui";
import { formatDate, localYmd } from "../../lib/utils";
import { Button, EmptyState } from "../../components/ui";
import { CycleIcon, TeamIcon } from "../../components/icons";
import { PageHeader } from "../../components/PageHeader";
import { BurnupChart, ChartLegend } from "../../components/BurnupChart";
import { useDocumentTitle, useWsPath } from "../../app/hooks";
import { IssuesView } from "../issues/IssuesView";

function stats(issues: Issue[], states: Record<string, WorkflowState>) {
  const s = { total: 0, done: 0, started: 0, todo: 0, points: 0, donePoints: 0 };
  for (const i of issues) {
    const t = states[i.stateId]?.type;
    if (t === "canceled") continue;
    s.total++;
    s.points += i.estimate ?? 0;
    if (t === "completed") {
      s.done++;
      s.donePoints += i.estimate ?? 0;
    } else if (t === "started") s.started++;
    else s.todo++;
  }
  return { ...s, percent: s.total ? Math.round((s.done / s.total) * 100) : 0 };
}

export function CyclesPage() {
  const { teamKey } = useParams();
  const team = useTeamByKey(teamKey);
  const cycles = useCycles(team?.id);
  const issues = useActiveIssues();
  const states = useData((s) => s.states);
  const navigate = useNavigate();
  const p = useWsPath();
  const today = localYmd();
  useDocumentTitle(team ? `${team.name} › サイクル` : "サイクル");
  const byCycle = useMemo(() => {
    const m = new Map<string, Issue[]>();
    for (const i of issues) if (i.cycleId) m.set(i.cycleId, [...(m.get(i.cycleId) ?? []), i]);
    return m;
  }, [issues]);

  if (!team) return <EmptyState title="チームが見つかりません" />;
  const current = cycles.find((c) => cycleStatus(c, today) === "current");
  const upcoming = cycles.filter((c) => cycleStatus(c, today) === "upcoming");
  const past = cycles.filter((c) => cycleStatus(c, today) === "past").reverse();

  const add = () => {
    createCycle(team.id);
    toast("新しいサイクルを作成しました");
  };

  const row = (c: Cycle, label: string) => {
    const s = stats(byCycle.get(c.id) ?? [], states);
    return (
      <Link key={c.id} to={p(`/team/${team.key}/cycle/${c.number}`)} className="cycle-row" data-testid="cycle-row">
        <CycleIcon size={16} progress={label === "past" ? 1 : s.percent / 100} color={label === "past" ? "var(--text-tertiary)" : "var(--accent)"} />
        <b>{cycleName(c)}</b>
        <span className="muted">
          {formatDate(c.startsAt)} → {formatDate(c.endsAt)}
        </span>
        <span className="spacer" />
        <span className="muted small">{s.total}件</span>
        <span className="cycle-row-progress">
          <span className="progress-bar thin">
            <span style={{ width: `${s.percent}%` }} />
          </span>
          {s.percent}%
        </span>
      </Link>
    );
  };

  return (
    <div className="page cycles-page" data-testid="cycles-page">
      <PageHeader
        title={
          <span className="page-title-text">
            <TeamIcon team={team} size={18} />
            {team.name}
            <span className="crumb-sep">›</span>
            サイクル
          </span>
        }
        screen="cycles"
        actions={
          team.cyclesEnabled && (
            <Button size="sm" icon={<Plus size={14} />} onClick={add} data-testid="new-cycle">
              新しいサイクル
            </Button>
          )
        }
      />
      <div className="page-body scroll">
        {!team.cyclesEnabled ? (
          <EmptyState
            icon={<CycleIcon size={28} progress={0.5} />}
            title="サイクルは無効です"
            description="サイクルを使うと、1〜4週間のリズムで計画と振り返りができます。"
            action={<Button onClick={() => updateTeam(team.id, { cyclesEnabled: true })}>サイクルを有効にする</Button>}
          />
        ) : (
          <div className="cycles-inner">
            {current ? (
              (() => {
                const list = byCycle.get(current.id) ?? [];
                const s = stats(list, states);
                const left = diffDays(today, current.endsAt);
                return (
                  <section className="current-cycle" data-testid="current-cycle">
                    <div className="current-cycle-head">
                      <div>
                        <span className="pill accent">現在のサイクル</span>
                        <h2>{cycleName(current)}</h2>
                        <span className="muted">
                          {formatDate(current.startsAt)} → {formatDate(current.endsAt)}・残り{Math.max(0, left)}日
                        </span>
                      </div>
                      <span className="spacer" />
                      <Button onClick={() => navigate(p(`/team/${team.key}/cycle/${current.number}`))}>
                        課題を見る
                      </Button>
                    </div>
                    <div className="cycle-stats">
                      <div>
                        <b>{s.percent}%</b>
                        <span>
                          完了（{s.done}/{s.total}件）
                        </span>
                      </div>
                      <div>
                        <b>{s.total}</b>
                        <span>スコープ</span>
                      </div>
                      <div>
                        <b>{s.started}</b>
                        <span>進行中</span>
                      </div>
                      <div>
                        <b>
                          {s.donePoints}/{s.points}
                        </b>
                        <span>ポイント</span>
                      </div>
                    </div>
                    <BurnupChart issues={list} states={states} start={current.startsAt} end={current.endsAt} height={180} />
                    <ChartLegend />
                  </section>
                );
              })()
            ) : (
              <EmptyState
                icon={<CycleIcon size={28} progress={0} />}
                title="進行中のサイクルはありません"
                description="新しいサイクルを作ると、今日から始まる期間が設定されます。"
                action={
                  <Button variant="primary" onClick={add}>
                    サイクルを作成
                  </Button>
                }
              />
            )}
            {upcoming.length > 0 && (
              <section className="cycle-section">
                <h3>今後のサイクル</h3>
                {upcoming.map((c) => row(c, "upcoming"))}
              </section>
            )}
            {past.length > 0 && (
              <section className="cycle-section">
                <h3>過去のサイクル</h3>
                {past.map((c) => row(c, "past"))}
              </section>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export function CyclePage() {
  const { teamKey, number } = useParams();
  const team = useTeamByKey(teamKey);
  const cycles = useCycles(team?.id);
  const issues = useActiveIssues();
  const states = useData((s) => s.states);
  const p = useWsPath();
  const cycle = cycles.find((c) => String(c.number) === number);
  const scoped = useMemo(() => issues.filter((i) => i.cycleId === cycle?.id), [issues, cycle?.id]);
  useDocumentTitle(cycle ? cycleName(cycle) : "サイクル");
  if (!team || !cycle) return <EmptyState title="サイクルが見つかりません" />;
  const s = stats(scoped, states);
  const st = cycleStatus(cycle);
  return (
    <IssuesView
      key={cycle.id}
      viewKey={`cycle:${cycle.id}`}
      issues={scoped}
      teamId={team.id}
      screen="cycles"
      listLabel={`${team.name} › ${cycleName(cycle)}`}
      createDefaults={{ cycleId: cycle.id }}
      emptyTitle="このサイクルにはまだ課題がありません"
      emptyDescription="一覧で課題を選び、Shift + C でサイクルに追加できます。"
      title={
        <span className="page-title-text">
          <TeamIcon team={team} size={18} />
          <Link to={p(`/team/${team.key}/cycles`)} className="crumb">
            サイクル
          </Link>
          <span className="crumb-sep">›</span>
          {cycleName(cycle)}
        </span>
      }
      headerExtra={
        <span className="cycle-summary">
          <CycleIcon size={14} progress={s.percent / 100} color="var(--accent)" />
          {s.done}/{s.total} 完了
          <span className="muted">
            ・{formatDate(cycle.startsAt)} → {formatDate(cycle.endsAt)}
            {st === "current" && `・残り${Math.max(0, diffDays(localYmd(), cycle.endsAt))}日`}
          </span>
        </span>
      }
    />
  );
}
