import type { CompletenessModelPort } from "../../application/discovery/requirement-completeness-engine.js";
import { RequirementCoverageAnalysisOutput, parseModelJson } from "@devflow/contracts";
import type { ModelProviderRegistry } from "./model-provider-registry.js";

/** Adapts the ModelProviderRegistry to the CompletenessModelPort with schema validation. */
export async function buildCompletenessModelPort(providers: ModelProviderRegistry): Promise<CompletenessModelPort> {
  return {
    analyzeCoverage: async (input) => {
      const provider = providers.getDefault();
      const res = await provider.generate({
        purpose: "coverage_analysis",
        system: "You are the Discovery Interviewer. Analyze requirement coverage honestly.",
        messages: [{ role: "user", content: JSON.stringify(input).slice(0, 4000) }],
        responseSchemaHint:
          '{"coverage":[{"category":"problem","state":"CLEAR","score":0.9,"ambiguity":0.2,"riskImpact":0.4,"notes":[]}],"requirements":[{"category":"functional_behavior","statement":"...","priority":"MUST","sourceHint":"AI_PROPOSAL"}],"dangerousAssumptions":[]}',
        maxTokens: 2000,
      });
      const parsed = parseModelJson(res.raw, RequirementCoverageAnalysisOutput);
      if (!parsed.ok) {
        throw new Error(`[completeness-model/analyze] invalid model output: ${parsed.error}`);
      }
      return parsed.value;
    },
    proposeNextQuestion: async () => null,
  };
}
