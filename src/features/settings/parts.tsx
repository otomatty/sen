import type { ReactNode } from "react";
import { cx } from "../../lib/utils";

export function Section({
  title,
  description,
  testId,
  className,
  children,
}: {
  title: string;
  description?: string;
  testId?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={cx("settings-section", className)} data-testid={testId}>
      <h2>{title}</h2>
      {description && <p className="muted">{description}</p>}
      <div className="settings-card">{children}</div>
    </section>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="field">
      <div className="field-label">
        <span>{label}</span>
        {hint && <span className="muted small">{hint}</span>}
      </div>
      <div className="field-control">{children}</div>
    </div>
  );
}
