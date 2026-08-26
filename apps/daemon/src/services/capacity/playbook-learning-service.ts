import type { EvidenceId, ModelProvider, Playbook, ProjectId } from "@devflow/contracts";
import { newId } from "@devflow/contracts";
import type { DocumentRepository } from "../../infrastructure/db/document-repository.js";
import type { EventStore } from "../../infrastructure/db/event-store.js";

/**
 * PlaybookLearningService (§2.18): reusable patterns are OBSERVED first and only
 * PROMOTED after verified reuse. One unverified session never becomes canon.
 */
export class PlaybookLearningService {
  constructor(
    private readonly docs: DocumentRepository,
    private readonly events: EventStore,
  ) {}

  observePattern(params: {
    projectId: ProjectId;
    title: string;
    triggerConditions: string[];
    procedure: string[];
    constraints?: string[];
    failureModes?: string[];
    evidenceRefs: EvidenceId[];
  }): Playbook {
    const existing = this.docs.list<Playbook>("playbook");
    const playbook: Playbook = {
      id: newId("pb"),
      projectId: params.projectId,
      stableKey: `PB-${String(existing.length + 1).padStart(3, "0")}`,
      title: params.title,
      triggerConditions: params.triggerConditions,
      procedure: params.procedure,
      constraints: params.constraints ?? [],
      failureModes: params.failureModes ?? [],
      evidenceRefs: params.evidenceRefs,
      lifecycle: "OBSERVED",
      reuseCount: 0,
      lastValidatedAt: null,
      createdAt: new Date().toISOString(),
    };
    this.docs.put("playbook", playbook.id, params.projectId, playbook);
    this.events.append({
      projectId: params.projectId,
      type: "playbook.observed",
      entityType: "playbook",
      entityId: playbook.id,
      actorType: "AGENT",
      payload: { stableKey: playbook.stableKey },
    });
    return playbook;
  }

  /** Records a successful reuse; only VERIFIED reuse (fresh passing evidence) counts toward promotion. */
  recordReuse(projectId: string, playbookId: string, evidenceRefs: EvidenceId[], verificationPassed: boolean): Playbook {
    const playbook = this.docs.require<Playbook>("playbook", playbookId);
    const nextLifecycle: Playbook["lifecycle"] =
      playbook.lifecycle === "PROMOTED"
        ? "PROMOTED"
        : !verificationPassed
          ? playbook.lifecycle
          : playbook.lifecycle === "OBSERVED"
            ? "REUSED"
            : "VERIFIED";
    const updated: Playbook = {
      ...playbook,
      lifecycle: nextLifecycle,
      reuseCount: playbook.reuseCount + (verificationPassed ? 1 : 0),
      evidenceRefs: [...playbook.evidenceRefs, ...evidenceRefs],
      lastValidatedAt: verificationPassed ? new Date().toISOString() : playbook.lastValidatedAt,
    };
    this.docs.put("playbook", updated.id, updated.projectId ?? projectId, updated);
    return updated;
  }

  /** Promotion gate: requires VERIFIED state + at least 2 successful reuses. */
  promote(playbookId: string): Playbook {
    const playbook = this.docs.require<Playbook>("playbook", playbookId);
    if (playbook.lifecycle !== "VERIFIED") {
      throw new Error(`[playbook/promote] '${playbook.stableKey}' is ${playbook.lifecycle}, not VERIFIED — promotion denied`);
    }
    if (playbook.reuseCount < 2) {
      throw new Error(`[playbook/promote] '${playbook.stableKey}' has only ${playbook.reuseCount} verified reuses — need 2`);
    }
    if (playbook.evidenceRefs.length === 0) {
      throw new Error(`[playbook/promote] '${playbook.stableKey}' has no evidence — promotion denied`);
    }
    const promoted: Playbook = { ...playbook, lifecycle: "PROMOTED" };
    this.docs.put("playbook", promoted.id, promoted.projectId, promoted);
    this.events.append({
      projectId: promoted.projectId ?? "",
      type: "playbook.promoted",
      entityType: "playbook",
      entityId: promoted.id,
      actorType: "ENGINE",
      payload: { stableKey: promoted.stableKey, reuses: promoted.reuseCount },
    });
    return promoted;
  }

  findRelevant(triggerText: string): Playbook[] {
    const text = triggerText.toLowerCase();
    return this.docs
      .list<Playbook>("playbook")
      .filter((p) => p.lifecycle === "PROMOTED")
      .filter((p) => p.triggerConditions.some((t) => text.includes(t.toLowerCase())));
  }
}

/**
 * ExpertConsult (§3.10): a specialist model advises; output becomes an artifact only.
 * It NEVER mutates lifecycle state — the owning lead/engine evaluates it.
 */
export class ExpertConsultService {
  constructor(
    private readonly docs: DocumentRepository,
    private readonly events: EventStore,
    private readonly provider: ModelProvider,
  ) {}

  async consult(params: { projectId: ProjectId; topic: string; question: string }): Promise<{ artifactId: string; summary: string }> {
    const response = await this.provider.generate({
      purpose: "expert_consult",
      system: `You are an expert consultant on ${params.topic}. Provide advice as an artifact. You cannot change any project state.`,
      messages: [{ role: "user", content: params.question }],
      responseSchemaHint: '{"summary":"...","advice":["..."]}',
      maxTokens: 1500,
    });
    let summary = response.raw.slice(0, 500);
    try {
      const parsed = JSON.parse(response.raw) as { summary?: string };
      if (parsed.summary) summary = parsed.summary;
    } catch {
      // advisory content is free-form safe
    }
    const artifactId = `consult:${params.projectId}:${Date.now()}`;
    this.docs.put(
      "artifact",
      artifactId,
      params.projectId,
      {
        id: artifactId,
        projectId: params.projectId,
        type: "STATE", // consults are operational records, not canon truth
        canonicalName: `EXPERT_CONSULT_${new Date().toISOString().slice(0, 10)}.md`,
        content: `# Expert Consult — ${params.topic}\n\nQuestion: ${params.question}\n\nAdvice:\n${response.raw}`,
        revision: 1,
        path: null,
        updatedAt: new Date().toISOString(),
        advisoryOnly: true,
      },
    );
    this.events.append({
      projectId: params.projectId,
      type: "recommendation.created",
      entityType: "artifact",
      entityId: artifactId,
      actorType: "AGENT",
      payload: { kind: "expert_consult", topic: params.topic, advisory: true },
    });
    return { artifactId, summary };
  }
}
