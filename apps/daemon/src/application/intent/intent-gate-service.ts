import type { IntentRecord, ModelProvider, ProjectId, RiskTier } from "@devflow/contracts";
import { newId, parseModelJson, z } from "@devflow/contracts";
import type { DocumentRepository } from "../../infrastructure/db/document-repository.js";
import type { EventStore } from "../../infrastructure/db/event-store.js";

const IntentOutput = z.object({
  type: z.enum(["GOAL", "FEATURE", "BUG", "REFACTOR", "RESEARCH", "OPERATION", "CLARIFICATION"]),
  inferredGoal: z.string().min(3),
  confidence: z.number().min(0).max(1),
  hiddenDimensions: z.array(z.string()).default([]),
  recommendedEntryPoint: z.enum(["DISCOVERY_INTERVIEW", "DIRECT_IMPACT_ANALYSIS", "RESEARCH_FIRST", "BUG_INVESTIGATION"]),
});
export type IntentGateOutput = z.infer<typeof IntentOutput>;

/** Deterministic keyword classifier used as fallback and as validation cross-check. */
export function heuristicIntent(mission: string): IntentGateOutput {
  const t = mission.toLowerCase();
  if (/\bbug\b|버그|crash|fails|error|고장/.test(t)) {
    return { type: "BUG", inferredGoal: mission.slice(0, 140), confidence: 0.6, hiddenDimensions: ["reproduction steps", "regression window"], recommendedEntryPoint: "BUG_INVESTIGATION" };
  }
  if (/refactor|리팩터|clean ?up|restructure/.test(t)) {
    return { type: "REFACTOR", inferredGoal: mission.slice(0, 140), confidence: 0.6, hiddenDimensions: ["behavior-preservation proof", "blast radius"], recommendedEntryPoint: "DIRECT_IMPACT_ANALYSIS" };
  }
  if (/research|조사|compare|benchmark|evaluate/.test(t)) {
    return { type: "RESEARCH", inferredGoal: mission.slice(0, 140), confidence: 0.6, hiddenDimensions: ["decision criteria"], recommendedEntryPoint: "RESEARCH_FIRST" };
  }
  if (/deploy|restart|migrate prod|rotate key/.test(t)) {
    return { type: "OPERATION", inferredGoal: mission.slice(0, 140), confidence: 0.6, hiddenDimensions: ["rollback plan"], recommendedEntryPoint: "DIRECT_IMPACT_ANALYSIS" };
  }
  if (/what is|how does|explain|\?/.test(t)) {
    return { type: "CLARIFICATION", inferredGoal: mission.slice(0, 140), confidence: 0.5, hiddenDimensions: [], recommendedEntryPoint: "DISCOVERY_INTERVIEW" };
  }
  // Default: an ambiguous product/feature ask — always routed through discovery (spec §2.1).
  return {
    type: /build|create|make|만들|구축/.test(t) && !/login|auth|oauth/.test(t) ? "GOAL" : "FEATURE",
    inferredGoal: mission.slice(0, 140),
    confidence: 0.55,
    hiddenDimensions: inferHiddenDimensions(t),
    recommendedEntryPoint: "DISCOVERY_INTERVIEW",
  };
}

function inferHiddenDimensions(text: string): string[] {
  const dims: string[] = [];
  if (/login|auth|oauth|로그인/.test(text)) {
    dims.push("identity provider", "account model", "session strategy", "authorization", "public/private routing", "recovery/logout", "security requirements");
  }
  if (/payment|결제|billing/.test(text)) dims.push("payment provider", "refund policy", "tax handling", "idempotency");
  if (/dashboard|report|scout|트렌드/.test(text)) dims.push("data sources", "refresh cadence", "definition of a trend");
  return dims;
}

/**
 * IntentGateService (§2.14, Step 3A): classifies intent BEFORE execution/discovery.
 * Determines entry point and surfaces hidden implementation dimensions.
 * AI output is schema-validated; on any failure the deterministic classifier answers,
 * so a broken provider can never block the gate.
 */
export class IntentGateService {
  constructor(
    private readonly docs: DocumentRepository,
    private readonly events: EventStore,
    private readonly provider: ModelProvider,
  ) {}

  async classify(projectId: ProjectId, mission: string, riskTier: RiskTier): Promise<IntentRecord> {
    let analysis: IntentGateOutput;
    try {
      const response = await this.provider.generate({
        purpose: "intent_gate",
        system: "You are the Intent Gate. Classify what the user really needs before any work begins.",
        messages: [{ role: "user", content: `Mission: ${mission}\nRisk tier: ${riskTier}` }],
        responseSchemaHint:
          '{"type":"FEATURE","inferredGoal":"...","confidence":0.8,"hiddenDimensions":["..."],"recommendedEntryPoint":"DISCOVERY_INTERVIEW"}',
        maxTokens: 600,
      });
      const parsed = parseModelJson(response.raw, IntentOutput);
      analysis = parsed.ok ? parsed.value : heuristicIntent(mission);
      // Cross-check: a HIGH-risk mission must never be routed to direct implementation.
      if (riskTier === "HIGH" && analysis.recommendedEntryPoint === "DIRECT_IMPACT_ANALYSIS") {
        analysis = { ...analysis, recommendedEntryPoint: "DISCOVERY_INTERVIEW" };
      }
    } catch {
      analysis = heuristicIntent(mission);
    }

    const record: IntentRecord = {
      id: newId("intent"),
      projectId,
      taskId: null,
      type: analysis.type,
      literalRequest: mission,
      inferredGoal: analysis.inferredGoal,
      confidence: analysis.confidence,
      hiddenDimensions: analysis.hiddenDimensions,
      recommendedEntryPoint: analysis.recommendedEntryPoint,
      createdAt: new Date().toISOString(),
    };
    this.docs.put("intent_record", record.id, projectId, record);
    this.events.append({
      projectId,
      type: "intent.classified",
      entityType: "intent_record",
      entityId: record.id,
      actorType: "ENGINE",
      payload: { type: record.type, entryPoint: record.recommendedEntryPoint, confidence: record.confidence },
    });
    return record;
  }
}
