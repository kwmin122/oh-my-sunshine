import type { ReactNode } from "react";

export function statusColor(status: string): string {
  const s = status.toUpperCase();
  if (["RUNNING", "ACTIVE_PROGRESS", "SUCCEEDED", "PASSED", "PASS_FRESH", "AVAILABLE", "DONE", "COMPLETED", "ANSWERED"].includes(s)) return "text-emerald-400";
  if (["BLOCKED", "FAILED", "FAIL", "STALLED", "REJECTED", "MISSING", "DOWN", "DENIED", "CRITICAL"].includes(s)) return "text-red-400";
  if (["WAITING", "WAITING_APPROVAL", "WAITING_DECISION", "WAITING_FOR_APPROVAL", "WAITING_FOR_DECISION", "PROVIDER_BACKOFF", "AWAITING_APPROVAL", "REVIEW", "VERIFYING", "DEGRADED", "STALE", "PASS_STALE", "PENDING_PAIRING"].includes(s)) return "text-amber-400";
  if (["READY", "QUEUED", "PAIRED"].includes(s)) return "text-sky-400";
  return "text-neutral-500";
}

export function StatusDot({ status }: { status: string }): JSX.Element {
  const filled = ["RUNNING", "ACTIVE_PROGRESS", "SUCCEEDED", "PASSED", "DONE", "BLOCKED", "FAILED", "STALLED", "WAITING_APPROVAL", "PROVIDER_BACKOFF"].includes(status.toUpperCase());
  return (
    <span className={`inline-block h-2 w-2 rounded-full mr-1.5 ${filled ? "bg-current" : "border border-current"} ${statusColor(status)}`} />
  );
}

export function Chip({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "good" | "warn" | "bad" | "info" }): JSX.Element {
  const tones = {
    neutral: "bg-neutral-800 text-neutral-300",
    good: "bg-emerald-950 text-emerald-300",
    warn: "bg-amber-950 text-amber-300",
    bad: "bg-red-950 text-red-300",
    info: "bg-sky-950 text-sky-300",
  } as const;
  return <span className={`chip ${tones[tone]}`}>{children}</span>;
}

export function Bar({ label, value, hint }: { label: string; value: number; hint?: string }): JSX.Element {
  const pct = Math.round(value * 100);
  const color = pct >= 85 ? "bg-emerald-500" : pct >= 50 ? "bg-sky-500" : pct >= 25 ? "bg-amber-500" : "bg-red-500";
  return (
    <div className="flex items-center gap-3 text-xs">
      <span className="w-40 shrink-0 text-neutral-400">{label}</span>
      <div className="h-1.5 flex-1 overflow-hidden rounded bg-neutral-800">
        <div className={`h-full ${color}`} style={{ width: `${Math.min(100, pct)}%` }} />
      </div>
      <span className="mono w-10 text-right text-neutral-300">{pct}%</span>
      {hint ? <span className="w-24 truncate text-neutral-600">{hint}</span> : null}
    </div>
  );
}

export function Panel({ title, right, children }: { title: string; right?: ReactNode; children: ReactNode }): JSX.Element {
  return (
    <section className="panel p-4">
      <header className="mb-3 flex items-center justify-between">
        <h2 className="text-[13px] font-semibold uppercase tracking-wider text-neutral-400">{title}</h2>
        {right}
      </header>
      {children}
    </section>
  );
}

export function Empty({ children }: { children: ReactNode }): JSX.Element {
  return <p className="py-6 text-center text-sm text-neutral-600">{children}</p>;
}

export function timeAgo(iso: string): string {
  const diff = Date.now() - Date.parse(iso);
  if (diff < 60_000) return `${Math.max(1, Math.round(diff / 1000))}s ago`;
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
  return iso.slice(0, 10);
}
