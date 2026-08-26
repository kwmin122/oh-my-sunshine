/** HTTP API surface shared by desktop UI, future CLI, and tests. */
import type {
  AgentRole,
  Approval,
  ArchitectureNode,
  CanonArtifact,
  Checkpoint,
  Conflict,
  Decision,
  DiscoveryQuestion,
  Evidence,
  GatewayAction,
  Goal,
  MemoryItem,
  Mission,
  Project,
  Recommendation,
  Requirement,
  RequirementCoverage,
  Review,
  SystemCapability,
  TaskContract,
  WorkflowDefinition,
  WorkflowInstance,
} from "./domain.js";

export interface ProjectOverview {
  project: Project;
  mission: Mission | null;
  goal: Goal | null;
  coverage: RequirementCoverage[];
  readinessScore: number;
  readyForPlanning: boolean;
  missingForReady: string[];
  assumptions: string[];
  openQuestion: DiscoveryQuestion | null;
  tasks: TaskContract[];
  openDecisions: Decision[];
  openApprovals: Approval[];
  recommendations: Recommendation[];
  conflicts: Conflict[];
}

export interface DashboardStats {
  requirementsPct: number;
  architecturePct: number;
  implementationPct: number;
  verificationPct: number;
  releaseReadinessPct: number;
  agentSummaries: Array<{ roleId: string; roleName: string; status: string; currentTask: string | null }>;
  needsYou: { decisions: number; approvals: number };
  risks: { high: number; medium: number };
  staleEvidenceCount: number;
}
