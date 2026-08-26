import type { ModelProvider, ProjectId, ResearchRecord, RiskTier } from "@devflow/contracts";
import { newId } from "@devflow/contracts";
import type { DocumentRepository } from "../../infrastructure/db/document-repository.js";
import type { EventStore } from "../../infrastructure/db/event-store.js";

/** Deterministic triggers for the research gate (spec §4 Step 6). */
export function researchTriggers(mission: string, riskTier: RiskTier): string[] {
  const text = mission.toLowerCase();
  const triggers: string[] = [];
  if (/version|latest|upgrade|최신/.test(text)) triggers.push("technology facts may be stale");
  if (riskTier === "HIGH") triggers.push("security best practices matter");
  if (/api|oauth|webhook|integration/.test(text)) triggers.push("external API behavior matters");
  if (/gdpr|hipaa|compliance|개인정보/.test(text)) triggers.push("regulatory/compliance info matters");
  if (/architecture|framework|stack|database choice/.test(text)) triggers.push("choice depends on current ecosystem");
  return triggers;
}

/**
 * ResearchService (§4 Step 6): research output is decision evidence with sources,
 * dates, confidence — not decorative links. Mock provider yields deterministic findings.
 */
export class ResearchService {
  constructor(
    private readonly docs: DocumentRepository,
    private readonly events: EventStore,
    private readonly provider: ModelProvider,
  ) {}

  shouldResearch(mission: string, riskTier: RiskTier): boolean {
    return researchTriggers(mission, riskTier).length > 0;
  }

  async runResearch(projectId: ProjectId, question: string, impactedRequirementIds: string[]): Promise<ResearchRecord> {
    this.events.append({ projectId, type: "research.started", entityType: "research", actorType: "ENGINE", payload: { question } });
    const response = await this.provider.generate({
      purpose: "research",
      system: "You are the Researcher. Summarize current, sourced findings.",
      messages: [{ role: "user", content: `Research question: ${question}\nReturn JSON {"findings":["..."],"sources":[{"title":"...","url":"..."}],"confidence":0.8}` }],
      responseSchemaHint: '{"findings":[],"sources":[],"confidence":0.0}',
      maxTokens: 1200,
    });
    let findings: string[] = [`deterministic fallback finding for: ${question}`];
    let sources: ResearchRecord["sources"] = [];
    let confidence = 0.5;
    try {
      const parsed = JSON.parse(response.raw) as { findings?: string[]; sources?: Array<{ title: string; url: string }>; confidence?: number };
      if (parsed.findings?.length) findings = parsed.findings;
      if (parsed.sources?.length) sources = parsed.sources.map((s) => ({ ...s, retrievedAt: new Date().toISOString() }));
      if (typeof parsed.confidence === "number") confidence = parsed.confidence;
    } catch {
      // keep deterministic fallback — never write empty research silently
    }
    const record: ResearchRecord = {
      id: newId("res"),
      projectId,
      question,
      sources,
      findings,
      confidence,
      freshnessDate: new Date().toISOString().slice(0, 10),
      impactedRequirementIds,
    };
    this.docs.put("research_record", record.id, projectId, record);
    this.events.append({
      projectId,
      type: "research.completed",
      entityType: "research",
      entityId: record.id,
      actorType: "ENGINE",
      payload: { findingsCount: findings.length, sourcesCount: sources.length },
    });
    return record;
  }
}
