/** Typed fetch client over the daemon HTTP API. The UI never touches fs/shell/git —
 * this boundary is the only control surface (spec §1.1, §29). */

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const errBody = (await res.json()) as { error?: string };
      if (errBody.error) detail = errBody.error;
    } catch {
      // keep statusText
    }
    throw new Error(`${method} ${path} → ${res.status}: ${detail}`);
  }
  return (await res.json()) as T;
}

export const api = {
  get: <T>(path: string) => call<T>("GET", path),
  post: <T>(path: string, body?: unknown) => call<T>("POST", path, body ?? {}),
  put: <T>(path: string, body?: unknown) => call<T>("PUT", path, body ?? {}),
};

// ---- Shared view models (loose mirrors of daemon projections) ----
export interface ProjectDTO {
  id: string;
  name: string;
  description: string;
  repositoryPath: string | null;
  riskProfile: string;
  createdAt: string;
}

export interface OverviewDTO {
  project: ProjectDTO;
  mission: { id: string; rawRequest: string } | null;
  openDecisions: DecisionDTO[];
  openApprovals: ApprovalDTO[];
  recommendations: RecommendationDTO[];
  driftFindings: DriftDTO[];
  checkpoints: CheckpointDTO[];
  actions: ActionDTO[];
  runs: RunDTO[];
}

export interface DecisionDTO {
  id: string;
  stableKey: string;
  question: string;
  context: string;
  severity: string;
  options: Array<{ key: string; label: string; consequence?: string }>;
  recommendation: string | null;
  taskId: string | null;
}

export interface ApprovalDTO {
  id: string;
  requestedActionSummary: string;
  reason: string;
  severity: string;
  requestingAgentRole: string;
}

export interface RecommendationDTO {
  id: string;
  actionType: string;
  reason: string;
  confidence: number | null;
  source: string;
}

export interface DriftDTO {
  id: string;
  severity: string;
  explanation: string;
  expectedScope: string[];
  observedScope: string[];
  status: string;
}

export interface CheckpointDTO {
  id: string;
  revision: string;
  completedSummary: string;
  verificationSummary: string;
  blockers: string[];
  nextAction: string;
  createdAt: string;
}

export interface ActionDTO {
  id: string;
  toolId: string;
  operation: string;
  risk: string;
  summary: string;
  status: string;
  resultSummary: string | null;
  createdAt: string;
}

export interface RunDTO {
  id: string;
  taskId: string | null;
  status: string;
  attempt: number;
  summary: string | null;
  failureReason: string | null;
}

export interface TaskDTO {
  id: string;
  stableKey: string;
  objective: string;
  riskTier: string;
  status: string;
  dependencyTaskIds: string[];
  requirementIds: string[];
  plannedSteps: string[];
  requiredEvidenceTypes: string[];
  verificationCommands: string[];
  blockers: string[];
  ownerRole: string;
}

export interface DiscoveryDTO {
  questions: Array<{
    id: string;
    category: string;
    question: string;
    whyItMatters: string;
    affectsDecision: string;
    options: Array<{ key: string; label: string }>;
    recommendedOption: string | null;
    status: string;
    answer: string | null;
  }>;
  openQuestion: DiscoveryDTO["questions"][number] | null;
  intent: IntentDTO[];
  requirements: RequirementDTO[];
}

export interface IntentDTO {
  id: string;
  type: string;
  inferredGoal: string;
  confidence: number;
  hiddenDimensions: string[];
  recommendedEntryPoint: string;
}

export interface RequirementDTO {
  id: string;
  stableKey: string;
  category: string;
  statement: string;
  priority: string;
  source: string;
}

export interface CoverageDTO {
  readyForPlanning: boolean;
  overallScore: number;
  missingForReady: string[];
  coverage: Array<{ category: string; state: string; score: number; riskImpact: number; ambiguity: number }>;
}

export interface EvidenceRowDTO {
  evidence: Array<{ id: string; type: string; status: string; freshness: string; revision: string; commandOrMethod: string; taskId: string | null; outputSummary: string; createdAt: string }>;
  reviews: ReviewDTO[];
}

export interface ReviewDTO {
  id: string;
  type: string;
  status: string;
  score: number;
  blockingCount: number;
  findings: Array<{ id: string; severity: string; confidence: number; statement: string; disposition: string; dispositionReason: string | null }>;
}

export interface EventDTO {
  id: string;
  sequence: number;
  type: string;
  entityType: string | null;
  entityId: string | null;
  actorType: string;
  payload: Record<string, unknown>;
  timestamp: string;
}

export interface CapabilityDTO {
  capability: string;
  status: string;
  version: string | null;
  diagnostic: string;
}

export interface ConflictDTO {
  id: string;
  type: string;
  severity: string;
  leftEntity: string;
  rightEntity: string;
  explanation: string;
  status: string;
}
