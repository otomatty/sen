import { useMemo } from "react";
import type { Issue, WorkflowState } from "../../shared/types";
import { addDays, diffDays } from "../../shared/dates";
import { localYmd } from "../lib/utils";

/** 範囲（スコープ）と完了数の推移を描くシンプルなバーンアップチャート */
export function BurnupChart({
  issues,
  states,
  start,
  end,
  height = 160,
}: {
  issues: Issue[];
  states: Record<string, WorkflowState>;
  start: string;
  end: string;
  height?: number;
}) {
  const data = useMemo(() => {
    const days = Math.max(1, diffDays(start, end));
    const today = localYmd();
    const startTs = new Date(`${start}T00:00:00`).getTime();
    const pts: { day: number; scope: number; done: number; started: number; future: boolean }[] = [];
    for (let d = 0; d <= days; d++) {
      const ymd = addDays(start, d);
      const endOfDay = new Date(`${ymd}T23:59:59`).getTime();
      const future = ymd > today;
      let scope = 0;
      let done = 0;
      let started = 0;
      for (const i of issues) {
        if (states[i.stateId]?.type === "canceled") continue;
        if (Math.max(i.createdAt, startTs) <= endOfDay || i.createdAt < startTs) scope++;
        if (i.completedAt && i.completedAt <= endOfDay) done++;
        else if (i.startedAt && i.startedAt <= endOfDay) started++;
      }
      pts.push({ day: d, scope, done, started, future });
    }
    return { pts, days };
  }, [issues, states, start, end]);

  const w = 560;
  const h = height;
  const pad = { l: 28, r: 10, t: 10, b: 22 };
  const max = Math.max(1, ...data.pts.map((p) => p.scope));
  const x = (d: number) => pad.l + (d / data.days) * (w - pad.l - pad.r);
  const y = (v: number) => h - pad.b - (v / max) * (h - pad.t - pad.b);
  const past = data.pts.filter((p) => !p.future);
  const line = (key: "scope" | "done" | "started") =>
    past.map((p, i) => `${i ? "L" : "M"} ${x(p.day).toFixed(1)} ${y(key === "started" ? p.started + p.done : p[key]).toFixed(1)}`).join(" ");
  const area = (key: "done" | "started") =>
    past.length
      ? `${line(key)} L ${x(past[past.length - 1].day)} ${y(0)} L ${x(past[0].day)} ${y(0)} Z`
      : "";
  const ticks = [0, Math.round(max / 2), max];
  const todayIdx = past.length - 1;

  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="burnup" role="img" aria-label="進捗チャート">
      {ticks.map((t) => (
        <g key={t}>
          <line x1={pad.l} x2={w - pad.r} y1={y(t)} y2={y(t)} className="grid" />
          <text x={pad.l - 6} y={y(t) + 4} className="tick" textAnchor="end">
            {t}
          </text>
        </g>
      ))}
      <path d={area("started")} className="area-started" />
      <path d={area("done")} className="area-done" />
      <path d={line("scope")} className="line-scope" />
      <path d={line("done")} className="line-done" />
      {/* 理想線 */}
      <line x1={x(0)} y1={y(0)} x2={x(data.days)} y2={y(data.pts[data.pts.length - 1]?.scope ?? 0)} className="line-ideal" />
      {todayIdx >= 0 && todayIdx < data.days && (
        <line x1={x(past[todayIdx].day)} x2={x(past[todayIdx].day)} y1={pad.t} y2={h - pad.b} className="today" />
      )}
      <text x={pad.l} y={h - 6} className="tick">
        {start.slice(5).replace("-", "/")}
      </text>
      <text x={w - pad.r} y={h - 6} className="tick" textAnchor="end">
        {end.slice(5).replace("-", "/")}
      </text>
    </svg>
  );
}

export function ChartLegend() {
  return (
    <div className="chart-legend">
      <span>
        <i className="lg-scope" />
        スコープ
      </span>
      <span>
        <i className="lg-started" />
        進行中
      </span>
      <span>
        <i className="lg-done" />
        完了
      </span>
      <span>
        <i className="lg-ideal" />
        目安
      </span>
    </div>
  );
}
