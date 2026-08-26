import type { ModelProvider, ModelRequest, ModelResponse } from "@devflow/contracts";

/**
 * Deterministic mock provider (spec §28). Produces schema-conformant structured
 * output for every purpose so the whole product is demonstrable without paid APIs.
 * The `purpose` string selects which canned JSON to emit.
 */
export class MockModelProvider implements ModelProvider {
  readonly id = "mock";
  readonly model = "deterministic-mock-v1";

  async generate(request: ModelRequest): Promise<ModelResponse> {
    const raw = this.cannedResponse(request.purpose);
    return { raw: JSON.stringify(raw), tokensIn: null, tokensOut: null, degraded: false };
  }

  private cannedResponse(purpose: string): unknown {
    switch (purpose) {
      case "coverage_analysis":
        return mockCoverageAnalysis();
      case "next_question":
        return null; // engine falls back to deterministic templates
      case "risk_assessment":
        return {
          tier: "NORMAL",
          reasons: ["mock default assessment — touches application code without auth/payment surface"],
        };
      case "task_decomposition":
        return mockTaskDecomposition();
      case "review":
        return { findings: [], score: 88, summary: "Mock review: no blocking findings." };
      case "implementation_plan":
        return { steps: [{ action: "inspect existing patterns" }, { action: "implement minimal change" }, { action: "add tests" }] };
      case "agent_action":
        return { kind: "FINISH", summary: "Mock agent finished after minimal coherent change." };
      default:
        return {};
    }
  }
}

function mockCoverageAnalysis(): unknown {
  const full = (category: string, score: number, state: string, ambiguity = 0.3, risk = 0.4) => ({
    category,
    state,
    score,
    ambiguity,
    riskImpact: risk,
    notes: [],
  });
  return {
    coverage: [
      full("problem", 0.95, "CLEAR", 0.1),
      full("target_user", 0.9, "CLEAR", 0.15),
      full("functional_behavior", 0.55, "PARTIAL", 0.5, 0.7),
      full("authentication", 0.2, "MISSING", 0.6, 0.9),
      full("authorization", 0.25, "MISSING", 0.55, 0.75),
      full("external_integrations", 0.35, "PARTIAL", 0.5, 0.65),
      full("data_model", 0.6, "PARTIAL", 0.4, 0.6),
      full("ux_states", 0.5, "PARTIAL", 0.45, 0.35),
      full("failure_behavior", 0.3, "MISSING", 0.55, 0.6),
      full("acceptance_criteria", 0.45, "PARTIAL", 0.5, 0.8),
      full("security", 0.3, "MISSING", 0.6, 0.85),
      full("non_goals", 0.7, "CLEAR", 0.2, 0.2),
      full("user_workflow", 0.75, "CLEAR", 0.25, 0.4),
      // Low-impact categories get moderate heuristic confidence; high-impact ones
      // stay demanding until actually clarified (deliberate asymmetry).
      full("performance", 0.7, "PARTIAL", 0.3, 0.3),
      full("observability", 0.7, "PARTIAL", 0.3, 0.3),
      full("constraints", 0.75, "CLEAR", 0.25, 0.3),
      full("deployment", 0.7, "PARTIAL", 0.3, 0.3),
      full("rollback", 0.7, "PARTIAL", 0.3, 0.25),
      full("privacy_compliance", 0.72, "PARTIAL", 0.3, 0.4),
      full("concurrency", 0.7, "PARTIAL", 0.3, 0.3),
      full("scalability", 0.7, "PARTIAL", 0.3, 0.25),
      full("reliability", 0.72, "PARTIAL", 0.3, 0.3),
    ],
    requirements: [
      { category: "functional_behavior", statement: "Users can sign in with Google OAuth.", priority: "MUST" },
      { category: "authentication", statement: "Sessions are stored server-side with secure cookies.", priority: "MUST" },
      { category: "failure_behavior", statement: "OAuth provider outage shows a retry screen instead of crashing.", priority: "SHOULD" },
    ],
    dangerousAssumptions: [],
  };
}

function mockTaskDecomposition(): unknown {
  return {
    tasks: [
      {
        objective: "Implement session data model and storage",
        ownerRoleName: "Backend Engineer",
        requirementStableKeys: [],
        dependsOnObjectives: [],
        plannedSteps: ["define session entity", "add storage adapter", "unit test round-trip"],
        acceptanceCriteria: ["session persists and reloads"],
        requiredEvidenceTypes: ["UNIT_TEST"],
        suggestedRiskTier: "NORMAL",
      },
      {
        objective: "Implement OAuth callback API endpoint",
        ownerRoleName: "Backend Engineer",
        requirementStableKeys: [],
        dependsOnObjectives: ["Implement session data model and storage"],
        plannedSteps: ["handle callback", "exchange code", "create session"],
        acceptanceCriteria: ["callback creates a valid session"],
        requiredEvidenceTypes: ["INTEGRATION_TEST"],
        suggestedRiskTier: "NORMAL",
      },
      {
        objective: "Build login UI with error states",
        ownerRoleName: "Frontend Engineer",
        requirementStableKeys: [],
        dependsOnObjectives: ["Implement OAuth callback API endpoint"],
        plannedSteps: ["login button", "loading state", "error state"],
        acceptanceCriteria: ["failed login shows recoverable error UI"],
        requiredEvidenceTypes: ["E2E_TEST"],
        suggestedRiskTier: "LOW",
      },
      {
        objective: "Auth end-to-end verification suite",
        ownerRoleName: "QA Engineer",
        requirementStableKeys: [],
        dependsOnObjectives: ["Build login UI with error states"],
        plannedSteps: ["e2e happy path", "e2e failure path"],
        acceptanceCriteria: ["both paths pass in CI"],
        requiredEvidenceTypes: ["E2E_TEST"],
        suggestedRiskTier: "NORMAL",
      },
    ],
  };
}
