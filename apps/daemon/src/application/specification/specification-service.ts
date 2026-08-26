import type {
  AcceptanceCriterion,
  CanonArtifact,
  Goal,
  ModelProvider,
  ProjectId,
  Requirement,
  RequirementCoverage,
} from "@devflow/contracts";
import { newId } from "@devflow/contracts";
import type { DocumentRepository } from "../../infrastructure/db/document-repository.js";
import type { EventStore } from "../../infrastructure/db/event-store.js";
import { nextStableKey } from "../discovery/discovery-service.js";

/**
 * Specification Service (spec §4 Step 7, §11).
 * Canonical truth lives in MASTER_SPEC; requirements get stable IDs (REQ-xxx / AC-yyy)
 * that tasks trace back to (anti plan-drift, spec §42).
 */
export class SpecificationService {
  constructor(
    private readonly docs: DocumentRepository,
    private readonly events: EventStore,
    private readonly provider: ModelProvider,
  ) {}

  async generateSpec(projectId: ProjectId, goalTitle: string, rawRequest: string): Promise<{ requirements: Requirement[]; artifact: CanonArtifact }> {
    const requirements = this.docs.list<Requirement>("requirement", projectId);
    const existing = this.docs.get<CanonArtifact>("artifact", `master_spec:${projectId}`);

    const response = await this.provider.generate({
      purpose: "specification",
      system: "You are the Specification Writer. Produce a concise canonical spec.",
      messages: [
        {
          role: "user",
          content: [
            `Goal: ${goalTitle}`,
            `Raw request: ${rawRequest}`,
            `Known requirements:\n${requirements.map((r) => `- [${r.stableKey}] (${r.category}) ${r.statement}`).join("\n") || "- none yet"}`,
            `Previous spec:\n${existing?.content ?? "(none)"}`,
          ].join("\n"),
        },
      ],
      responseSchemaHint: '{"markdown":"full MASTER_SPEC.md content"}',
      maxTokens: 3000,
    });

    let markdown: string;
    try {
      const parsed = JSON.parse(response.raw) as { markdown?: string };
      markdown = parsed.markdown ?? response.raw;
    } catch {
      markdown = response.raw;
    }
    if (!markdown.trim()) {
      // Graceful degradation: never write an empty canonical doc over a previous one.
      markdown = existing?.content ?? this.deterministicFallbackSpec(goalTitle, rawRequest, requirements);
    }

    const revision = (existing?.revision ?? 0) + 1;
    const artifact: CanonArtifact = {
      id: `master_spec:${projectId}`,
      projectId,
      type: "MASTER_SPEC",
      canonicalName: "MASTER_SPEC.md",
      content: markdown,
      revision,
      path: null,
      updatedAt: new Date().toISOString(),
    };
    this.docs.put("artifact", artifact.id, projectId, artifact);
    this.events.append({
      projectId,
      type: revision === 1 ? "spec.generated" : "spec.updated",
      entityType: "artifact",
      entityId: artifact.id,
      actorType: "ENGINE",
      payload: { revision },
    });
    return { requirements, artifact };
  }

  /** Adds acceptance criteria to a requirement with stable AC ids. */
  addAcceptanceCriterion(requirementId: string, statement: string, verificationType: AcceptanceCriterion["verificationType"]): AcceptanceCriterion {
    const requirement = this.docs.require<Requirement>("requirement", requirementId);
    const siblings = this.docs
      .list<AcceptanceCriterion>("acceptance_criterion")
      .filter((ac) => ac.requirementId === requirementId);
    const ac: AcceptanceCriterion = {
      id: newId("ac"),
      requirementId,
      stableKey: nextStableKey(siblings.map((s) => s.stableKey), "AC"),
      statement,
      verificationType,
      status: "PENDING",
    };
    this.docs.put("acceptance_criterion", ac.id, requirement.projectId, ac);
    this.events.append({
      projectId: requirement.projectId,
      type: "requirement.updated",
      entityType: "acceptance_criterion",
      entityId: ac.id,
      actorType: "ENGINE",
      payload: { stableKey: ac.stableKey },
    });
    return ac;
  }

  private deterministicFallbackSpec(goalTitle: string, rawRequest: string, requirements: Requirement[]): string {
    return [
      "# MASTER SPEC",
      "",
      "## Goal",
      goalTitle,
      "",
      "## Raw Request",
      rawRequest,
      "",
      "## Requirements",
      ...requirements.map((r) => `- [${r.stableKey}] **${r.category}** — ${r.statement}`),
      "",
      "_Generated deterministically by DevFlow fallback writer._",
    ].join("\n");
  }
}
