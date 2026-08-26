/**
 * Runtime circuit breaker (V3 §24). CLOSED → OPEN → (cooldown) → HALF_OPEN.
 * A runtime that fails repeatedly is temporarily taken out of routing so
 * fallbacks engage instead of hammering a degraded provider. UNKNOWN states
 * are never fabricated: the breaker tracks only observed outcomes.
 */
export interface BreakerSnapshot {
  runtimeId: string;
  state: "CLOSED" | "OPEN" | "HALF_OPEN";
  consecutiveFailures: number;
  openedAt: string | null;
}

export class RuntimeCircuitBreaker {
  private readonly failures = new Map<string, number>();
  private readonly openedAt = new Map<string, number>();
  /** Set when the cooldown elapsed — the next attempt probes (half-open). */
  private readonly probing = new Set<string>();
  /** Every runtime ever observed — keeps snapshots stable across resets. */
  private readonly seen = new Set<string>();

  constructor(
    private readonly failureThreshold: number,
    private readonly cooldownMs: number,
  ) {}

  recordSuccess(runtimeId: string): void {
    this.seen.add(runtimeId);
    this.failures.delete(runtimeId);
    this.openedAt.delete(runtimeId);
    this.probing.delete(runtimeId);
  }

  recordFailure(runtimeId: string): void {
    this.seen.add(runtimeId);
    const count = (this.failures.get(runtimeId) ?? 0) + 1;
    this.failures.set(runtimeId, count);
    if (count >= this.failureThreshold && !this.openedAt.has(runtimeId)) {
      this.openedAt.set(runtimeId, Date.now());
      this.probing.delete(runtimeId);
    }
  }

  /**
   * OPEN blocks traffic; after cooldown ONE probe is allowed (HALF_OPEN).
   * A probe failure re-opens via recordFailure; a success closes fully.
   */
  isOpen(runtimeId: string): boolean {
    const opened = this.openedAt.get(runtimeId);
    if (opened === undefined) return false;
    if (Date.now() - opened >= this.cooldownMs) {
      if (!this.probing.has(runtimeId)) {
        this.probing.add(runtimeId); // allow one probe
        return false;
      }
      return true; // already probing — block additional traffic until outcome
    }
    return true;
  }

  snapshot(): BreakerSnapshot[] {
    return [...this.seen].map((runtimeId) => ({
      runtimeId,
      state: this.isOpen(runtimeId) ? "OPEN" : this.probing.has(runtimeId) ? "HALF_OPEN" : "CLOSED",
      consecutiveFailures: this.failures.get(runtimeId) ?? 0,
      openedAt: this.openedAt.has(runtimeId) ? new Date(this.openedAt.get(runtimeId)!).toISOString() : null,
    }));
  }
}
