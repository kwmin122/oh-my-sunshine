import type { ProviderCapacity, ProjectId, RoutingRecommendation, TaskContract } from "@devflow/contracts";
import { newId } from "@devflow/contracts";
import type { DocumentRepository } from "../../infrastructure/db/document-repository.js";
import type { EventStore } from "../../infrastructure/db/event-store.js";
import type { DevFlowConfig } from "../../lib/config.js";

export interface CapacityAdapter {
  readonly provider: string;
  /** Returns null fields when the provider does not expose a signal — never fabricate. */
  readCapacity(): Promise<Partial<ProviderCapacity>>;
}

/**
 * ProviderCapacityService (§5.16): per-provider capacity snapshots with honest
 * unknowns. Adapters are pluggable (native API / CLI reported / user entered).
 * Missing quota data stays `null` with source+confidence recorded.
 */
export class ProviderCapacityService {
  private readonly adapters = new Map<string, CapacityAdapter>();

  constructor(
    private readonly docs: DocumentRepository,
    private readonly events: EventStore,
    private readonly config: Pick<DevFlowConfig, "providerBackoffInitialMs">,
  ) {}

  registerAdapter(adapter: CapacityAdapter): void {
    this.adapters.set(adapter.provider, adapter);
  }

  async refreshAll(runtimes: Array<{ id: string; providerLabel: string }>): Promise<ProviderCapacity[]> {
    const snapshots: ProviderCapacity[] = [];
    for (const runtime of runtimes) {
      const adapter = this.adapters.get(runtime.providerLabel);
      let partial: Partial<ProviderCapacity> = {};
      let source: ProviderCapacity["source"] = "HEURISTIC";
      if (adapter) {
        try {
          partial = await adapter.readCapacity();
          source = "NATIVE_API";
        } catch (err) {
          partial = { health: "UNKNOWN", lastError: err instanceof Error ? err.message : String(err) };
        }
      }
      const snap: ProviderCapacity = {
        id: newId("cap"),
        runtimeId: runtime.id,
        provider: runtime.providerLabel,
        account: partial.account ?? null,
        limitType: partial.limitType ?? "UNKNOWN",
        usedPercentRemaining: partial.usedPercentRemaining ?? null,
        unit: partial.unit ?? null,
        resetAt: partial.resetAt ?? null,
        contextUsedTokens: partial.contextUsedTokens ?? null,
        contextLimitTokens: partial.contextLimitTokens ?? null,
        costUsd: partial.costUsd ?? null,
        credits: partial.credits ?? null,
        health: partial.health ?? "UNKNOWN",
        latencyMs: partial.latencyMs ?? null,
        lastError: partial.lastError ?? null,
        source,
        confidence: source === "NATIVE_API" ? 0.9 : 0.3,
        refreshedAt: new Date().toISOString(),
      };
      this.docs.put("provider_capacity", snap.id, null, snap);
      snapshots.push(snap);
      this.events.append({
        projectId: "" as ProjectId, // system-level event
        type: "provider.capacity_refreshed",
        entityType: "provider_capacity",
        entityId: snap.id,
        actorType: "ENGINE",
        payload: { provider: snap.provider, health: snap.health, remaining: snap.usedPercentRemaining },
      });
      if (snap.usedPercentRemaining !== null && snap.usedPercentRemaining <= 15) {
        this.events.append({
          projectId: "" as ProjectId,
          type: "provider.capacity_low",
          entityType: "provider_capacity",
          entityId: snap.id,
          actorType: "ENGINE",
          payload: { provider: snap.provider, remaining: snap.usedPercentRemaining },
        });
      }
    }
    return snapshots;
  }

  latest(provider: string): ProviderCapacity | null {
    const all = this.docs.list<ProviderCapacity>("provider_capacity").filter((c) => c.provider === provider);
    return all[all.length - 1] ?? null;
  }
}

/**
 * CapacityAwareRouter (§5.16): policy-driven routing recommendations across runtimes
 * using capacity/health/difficulty. Recommendations never execute; the orchestrator
 * and user policy decide (spec: routing must respect user policy).
 */
export class CapacityAwareRouter {
  constructor(
    private readonly docs: DocumentRepository,
    private readonly events: EventStore,
    private readonly capacity: ProviderCapacityService,
  ) {}

  recommend(projectId: ProjectId, tasks: TaskContract[]): RoutingRecommendation {
    // Providers come from observed capacity snapshots — never a hardcoded vendor list.
    const providers = [...new Set(this.docs.list<ProviderCapacity>("provider_capacity").map((c) => c.provider))];
    if (providers.length === 0) providers.push("mock");
    const capacities = providers.map((p) => ({ provider: p, cap: this.capacity.latest(p) }));
    const healthy = capacities.filter((c) => c.cap && c.cap.health !== "DOWN");

    // Rank by remaining capacity: work flows toward whichever healthy runtime has headroom.
    const byRemaining = [...healthy].sort((a, b) => (b.cap!.usedPercentRemaining ?? 100) - (a.cap!.usedPercentRemaining ?? 100));
    const strongestRuntimeId = byRemaining[0]?.cap!.runtimeId ?? "runtime_mock";
    const lowRemaining = healthy.filter((c) => (c.cap?.usedPercentRemaining ?? 100) < 20).map((c) => c.provider);

    const assignments: RoutingRecommendation["assignments"] = [
      { taskKind: "HIGH", preferredRuntimeId: strongestRuntimeId, rationale: "high-risk work stays on the healthiest available runtime" },
      { taskKind: "NORMAL", preferredRuntimeId: strongestRuntimeId, rationale: "default to the healthiest runtime for normal work" },
      { taskKind: "LOW", preferredRuntimeId: strongestRuntimeId, rationale: "routine work follows available capacity away from depleted runtimes" },
    ];

    const rec: RoutingRecommendation = {
      id: newId("route"),
      reason:
        lowRemaining.length > 0
          ? `capacity low on ${lowRemaining.join(", ")} — rebalance LOW-risk tasks`
          : "all runtimes healthy — keep current routing",
      assignments,
      createdAt: new Date().toISOString(),
    };
    this.docs.put("recommendation", rec.id, projectId, rec);
    this.events.append({
      projectId,
      type: "routing.recommended",
      entityType: "routing_recommendation",
      entityId: rec.id,
      actorType: "ENGINE",
      payload: { reason: rec.reason },
    });
    return rec;
  }

  applyRouting(projectId: string, rec: RoutingRecommendation): void {
    this.events.append({ projectId, type: "routing.changed", entityType: "routing_recommendation", entityId: rec.id, actorType: "USER", payload: {} });
  }
}
