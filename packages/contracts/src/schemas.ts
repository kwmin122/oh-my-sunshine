/** Runtime validation schemas for every external boundary: HTTP API input and
 * structured LLM output. Core domain never trusts unvalidated data (spec §12.3, §29, §32).
 */
import { z } from "zod";
import {
  ActionRisk,
  CoverageState,
  FindingSeverity,
  RequirementCategory,
  RiskTier,
} from "./state-machines.js";

// ---- API input ----
export const CreateProjectInput = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(4000).default(""),
  repositoryPath: z.string().min(1).optional(),
});
export type CreateProjectInput = z.infer<typeof CreateProjectInput>;

export const SubmitMissionInput = z.object({
  rawRequest: z.string().min(3).max(8000),
});
export type SubmitMissionInput = z.infer<typeof SubmitMissionInput>;

export const AnswerQuestionInput = z.object({
  questionId: z.string().min(1),
  answer: z.string().min(1).max(4000),
  optionKey: z.string().min(1).max(40).optional(),
});

export const ResolveDecisionInput = z.object({
  decisionId: z.string().min(1),
  chosenOption: z.string().min(1).max(80),
  note: z.string().max(4000).optional(),
});

export const ResolveApprovalInput = z.object({
  approvalId: z.string().min(1),
  outcome: z.enum(["ALLOW_ONCE", "APPROVED", "REJECTED", "CANCELLED"]),
  note: z.string().max(4000).optional(),
});

// ---- Structured model output schemas (spec §32) ----
export const RequirementCoverageAnalysisOutput = z.object({
  coverage: z.array(
    z.object({
      category: RequirementCategory,
      state: CoverageState,
      score: z.number().min(0).max(1),
      ambiguity: z.number().min(0).max(1),
      riskImpact: z.number().min(0).max(1),
      notes: z.array(z.string()),
    }),
  ),
  requirements: z.array(
    z.object({
      category: RequirementCategory,
      statement: z.string().min(3),
      priority: z.enum(["MUST", "SHOULD", "COULD"]),
      sourceHint: z.enum(["USER", "AI_PROPOSAL", "ASSUMPTION"]).default("AI_PROPOSAL"),
    }),
  ),
  dangerousAssumptions: z.array(z.string()).default([]),
});
export type RequirementCoverageAnalysisOutput = z.infer<typeof RequirementCoverageAnalysisOutput>;

export const NextQuestionOutput = z.object({
  category: RequirementCategory,
  question: z.string().min(5),
  whyItMatters: z.string().min(5),
  affectsDecision: z.string().min(3),
  options: z.array(z.object({ key: z.string(), label: z.string() })).default([]),
  recommendedOption: z.string().nullable().default(null),
});
export type NextQuestionOutput = z.infer<typeof NextQuestionOutput>;

export const RiskAssessmentOutput = z.object({
  tier: RiskTier,
  reasons: z.array(z.string()).min(1),
});
export type RiskAssessmentOutput = z.infer<typeof RiskAssessmentOutput>;

export const TaskDecompositionOutput = z.object({
  tasks: z
    .array(
      z.object({
        objective: z.string().min(5),
        ownerRoleName: z.string().min(2),
        requirementStableKeys: z.array(z.string()).default([]),
        dependsOnObjectives: z.array(z.string()).default([]), // matched later by objective text
        plannedSteps: z.array(z.string()).default([]),
        acceptanceCriteria: z.array(z.string()).default([]),
        requiredEvidenceTypes: z.array(z.string()).default([]),
        suggestedRiskTier: RiskTier.default("NORMAL"),
      }),
    )
    .min(1)
    .max(24),
});
export type TaskDecompositionOutput = z.infer<typeof TaskDecompositionOutput>;

export const ReviewFindingsOutput = z.object({
  findings: z
    .array(
      z.object({
        severity: FindingSeverity,
        confidence: z.number().min(0).max(1),
        statement: z.string().min(3),
        evidence: z.string().min(1),
      }),
    )
    .default([]),
  score: z.number().min(0).max(100),
  summary: z.string().default(""),
});
export type ReviewFindingsOutput = z.infer<typeof ReviewFindingsOutput>;

export const ImplementationPlanOutput = z.object({
  steps: z.array(z.object({ action: z.string() })).min(1).max(30),
});
export type ImplementationPlanOutput = z.infer<typeof ImplementationPlanOutput>;

export const AgentActionProposal = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("WRITE_FILE"), path: z.string(), content: z.string(), summary: z.string() }),
  z.object({ kind: z.literal("RUN_COMMAND"), command: z.string(), summary: z.string() }),
  z.object({ kind: z.literal("FINISH"), summary: z.string() }),
  z.object({ kind: z.literal("RAISE_DECISION"), question: z.string(), options: z.array(z.string()), context: z.string() }),
]);
export type AgentActionProposal = z.infer<typeof AgentActionProposal>;

/** Bounded repair: try to parse a model response against schema; on failure attempt one JSON extraction pass. */
export function parseModelJson<T>(raw: string, schema: { parse(data: unknown): T }): { ok: true; value: T } | { ok: false; error: string } {
  const firstPass = safeParse(raw, schema);
  if (firstPass.ok) return firstPass;
  const extracted = extractJsonObject(raw);
  if (extracted !== null) {
    const secondPass = safeParse(extracted, schema);
    if (secondPass.ok) return secondPass;
  }
  return { ok: false, error: firstPass.error };
}

function safeParse<T>(text: string, schema: { parse(data: unknown): T }): { ok: true; value: T } | { ok: false; error: string } {
  try {
    const value = schema.parse(JSON.parse(text));
    return { ok: true, value };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function extractJsonObject(raw: string): string | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  return raw.slice(start, end + 1);
}

export { ActionRisk, RiskTier };
