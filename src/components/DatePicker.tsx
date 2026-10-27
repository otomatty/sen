import { useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { addDays } from "../../shared/dates";
import { cx, localYmd } from "../lib/utils";
import { Popover } from "./ui";

const WEEK = ["日", "月", "火", "水", "木", "金", "土"];

export function DatePicker({
  anchor,
  value,
  onChange,
  onClose,
  title = "期日を設定",
  allowClear = true,
}: {
  anchor: DOMRect | null | undefined;
  value: string | null;
  onChange: (v: string | null) => void;
  onClose: () => void;
  title?: string;
  allowClear?: boolean;
}) {
  const today = localYmd();
  const init = value ?? today;
  const [month, setMonth] = useState(() => init.slice(0, 7));
  const [y, m] = month.split("-").map(Number);
  const first = new Date(y, m - 1, 1);
  const start = addDays(localYmd(first), -first.getDay());
  const days = Array.from({ length: 42 }, (_, i) => addDays(start, i));
  const shift = (n: number) => {
    const d = new Date(y, m - 1 + n, 1);
    setMonth(localYmd(d).slice(0, 7));
  };
  const nextMonday = (() => {
    const d = new Date();
    const diff = ((8 - d.getDay()) % 7) || 7;
    return addDays(today, diff);
  })();
  const quick: [string, string][] = [
    ["今日", today],
    ["明日", addDays(today, 1)],
    ["来週の月曜日", nextMonday],
    ["2週間後", addDays(today, 14)],
  ];
  const pick = (v: string | null) => {
    onChange(v);
    onClose();
  };
  return (
    <Popover anchor={anchor ?? null} onClose={onClose} className="datepicker" width={268} testId="date-picker">
      <div className="datepicker-title">{title}</div>
      <div className="datepicker-quick">
        {quick.map(([label, v]) => (
          <button key={label} className="chip-btn" onClick={() => pick(v)}>
            {label}
          </button>
        ))}
      </div>
      <div className="datepicker-head">
        <button className="icon-btn" onClick={() => shift(-1)} aria-label="前の月">
          <ChevronLeft size={15} />
        </button>
        <span>
          {y}年{m}月
        </span>
        <button className="icon-btn" onClick={() => shift(1)} aria-label="次の月">
          <ChevronRight size={15} />
        </button>
      </div>
      <div className="datepicker-grid">
        {WEEK.map((w, i) => (
          <span key={w} className={cx("datepicker-dow", i === 0 && "sun", i === 6 && "sat")}>
            {w}
          </span>
        ))}
        {days.map((d) => (
          <button
            key={d}
            className={cx(
              "datepicker-day",
              d.slice(0, 7) !== month && "other",
              d === today && "today",
              d === value && "selected",
            )}
            onClick={() => pick(d)}
          >
            {Number(d.slice(8))}
          </button>
        ))}
      </div>
      {allowClear && value && (
        <button className="datepicker-clear" onClick={() => pick(null)}>
          期日を削除
        </button>
      )}
    </Popover>
  );
}
