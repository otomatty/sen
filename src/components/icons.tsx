import type { CSSProperties } from "react";
import type { ProjectStatus, StateType } from "../../shared/types";
import { PROJECT_STATUSES } from "../../shared/constants";

// Linear 風のステータス・優先度アイコン（独自に描いた SVG）

export function StatusIcon({
  type,
  color,
  size = 14,
  progress,
}: {
  type: StateType;
  color: string;
  size?: number;
  /** started のときの塗りつぶし割合（0〜1） */
  progress?: number;
}) {
  const s = size;
  const c = s / 2;
  const r = s / 2 - 1;
  const common = { width: s, height: s, viewBox: `0 0 ${s} ${s}`, className: "status-icon", "aria-hidden": true } as const;
  switch (type) {
    case "backlog":
      return (
        <svg {...common}>
          <circle cx={c} cy={c} r={r - 0.5} fill="none" stroke={color} strokeWidth={1.5} strokeDasharray="1.6 1.9" />
        </svg>
      );
    case "unstarted":
      return (
        <svg {...common}>
          <circle cx={c} cy={c} r={r - 0.5} fill="none" stroke={color} strokeWidth={1.5} />
        </svg>
      );
    case "started": {
      const p = progress ?? 0.5;
      const ir = r - 2.5;
      const a = 2 * Math.PI * p - Math.PI / 2;
      const x = c + ir * Math.cos(a);
      const y = c + ir * Math.sin(a);
      const large = p > 0.5 ? 1 : 0;
      return (
        <svg {...common}>
          <circle cx={c} cy={c} r={r - 0.5} fill="none" stroke={color} strokeWidth={1.5} />
          {p >= 0.999 ? (
            <circle cx={c} cy={c} r={ir} fill={color} />
          ) : (
            <path d={`M ${c} ${c} L ${c} ${c - ir} A ${ir} ${ir} 0 ${large} 1 ${x} ${y} Z`} fill={color} />
          )}
        </svg>
      );
    }
    case "completed":
      return (
        <svg {...common}>
          <circle cx={c} cy={c} r={r} fill={color} />
          <path
            d={`M ${s * 0.3} ${s * 0.52} L ${s * 0.44} ${s * 0.66} L ${s * 0.71} ${s * 0.38}`}
            fill="none"
            stroke="var(--icon-on-color)"
            strokeWidth={1.6}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      );
    case "canceled":
      return (
        <svg {...common}>
          <circle cx={c} cy={c} r={r} fill={color} />
          <path
            d={`M ${s * 0.36} ${s * 0.36} L ${s * 0.64} ${s * 0.64} M ${s * 0.64} ${s * 0.36} L ${s * 0.36} ${s * 0.64}`}
            stroke="var(--icon-on-color)"
            strokeWidth={1.6}
            strokeLinecap="round"
          />
        </svg>
      );
  }
}

/** 進行中ステータスの「どれくらい進んでいるか」をステータスの並び順から決める */
export function startedProgress(position: number, positions: number[]): number {
  if (positions.length <= 1) return 0.5;
  const idx = positions.indexOf(position);
  return 0.35 + (0.4 * idx) / (positions.length - 1);
}

export function PriorityIcon({ priority, size = 14 }: { priority: number; size?: number }) {
  const s = size;
  if (priority === 1) {
    return (
      <svg width={s} height={s} viewBox="0 0 16 16" className="priority-icon urgent" aria-hidden>
        <rect x="1" y="1" width="14" height="14" rx="3.5" fill="var(--urgent)" />
        <rect x="7.1" y="3.8" width="1.8" height="5.6" rx="0.9" fill="#fff" />
        <circle cx="8" cy="11.6" r="1.05" fill="#fff" />
      </svg>
    );
  }
  if (priority === 0) {
    return (
      <svg width={s} height={s} viewBox="0 0 16 16" className="priority-icon" aria-hidden>
        <rect x="1.5" y="7.25" width="3" height="1.5" rx="0.75" fill="currentColor" opacity="0.7" />
        <rect x="6.5" y="7.25" width="3" height="1.5" rx="0.75" fill="currentColor" opacity="0.7" />
        <rect x="11.5" y="7.25" width="3" height="1.5" rx="0.75" fill="currentColor" opacity="0.7" />
      </svg>
    );
  }
  const filled = priority === 2 ? 3 : priority === 3 ? 2 : 1;
  return (
    <svg width={s} height={s} viewBox="0 0 16 16" className="priority-icon" aria-hidden>
      {[0, 1, 2].map((i) => (
        <rect
          key={i}
          x={1.5 + i * 5}
          y={10 - i * 3.5}
          width="3"
          height={4.5 + i * 3.5}
          rx="1"
          fill="currentColor"
          opacity={i < filled ? 1 : 0.28}
        />
      ))}
    </svg>
  );
}

export function LabelDot({ color, size = 8 }: { color: string; size?: number }) {
  return <span className="label-dot" style={{ background: color, width: size, height: size }} />;
}

export function ProjectIcon({ color, size = 14, status }: { color: string; size?: number; status?: ProjectStatus }) {
  const st = PROJECT_STATUSES.find((s) => s.value === status);
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" className="project-icon" aria-hidden>
      <path
        d="M3 2.5h10a.5.5 0 0 1 .5.5v10a.5.5 0 0 1-.5.5H3a.5.5 0 0 1-.5-.5V3a.5.5 0 0 1 .5-.5Z"
        fill="none"
        stroke={color}
        strokeWidth="1.4"
        transform="rotate(45 8 8) scale(0.92) translate(0.7 0.7)"
      />
      <circle cx="8" cy="8" r="2.2" fill={st && st.value === "completed" ? color : color} opacity={status === "planned" || status === "backlog" ? 0.35 : 1} />
    </svg>
  );
}

export function CycleIcon({ size = 14, color = "currentColor", progress = 0 }: { size?: number; color?: string; progress?: number }) {
  const r = 5.6;
  const circ = 2 * Math.PI * r;
  if (progress >= 1) {
    // 終わったサイクル：塗りつぶしにチェック
    return (
      <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden className="cycle-icon">
        <circle cx="8" cy="8" r="6.4" fill={color} />
        <path d="M5.3 8.2 7.1 10l3.6-3.8" fill="none" stroke="var(--panel)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden className="cycle-icon">
      <circle cx="8" cy="8" r={r} fill="none" stroke={color} strokeOpacity="0.35" strokeWidth="1.6" />
      <circle
        cx="8"
        cy="8"
        r={r}
        fill="none"
        stroke={color}
        strokeWidth="1.6"
        strokeDasharray={`${circ * progress} ${circ}`}
        transform="rotate(-90 8 8)"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function TeamIcon({ team, size = 18 }: { team: { key: string; color: string }; size?: number }) {
  const style: CSSProperties = {
    width: size,
    height: size,
    background: team.color,
    fontSize: size * 0.46,
  };
  return (
    <span className="team-icon" style={style}>
      {team.key.slice(0, 2)}
    </span>
  );
}

export function Logo({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden className="logo">
      <rect width="24" height="24" rx="6" fill="var(--accent)" />
      <path d="M6.5 16.5 L17.5 6.5" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" />
      <path d="M6.5 11 L12 6.5" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" opacity="0.55" />
      <path d="M12 17.5 L17.5 12.5" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" opacity="0.55" />
    </svg>
  );
}

export function ProgressRing({ percent, size = 16, color = "var(--accent)" }: { percent: number; size?: number; color?: string }) {
  const r = size / 2 - 2;
  const circ = 2 * Math.PI * r;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--border-strong)" strokeWidth="2" />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke={color}
        strokeWidth="2"
        strokeDasharray={`${(circ * percent) / 100} ${circ}`}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
        strokeLinecap="round"
      />
    </svg>
  );
}
