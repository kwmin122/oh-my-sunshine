/**
 * Branded identifier types. The marker is optional so plain `newId()` strings remain
 * assignable while structurally different ID types stay distinguishable in docs/intent.
 */
declare const brand: unique symbol;
export type Brand<T, B extends string> = T & { readonly [brand]?: B };

export type ProjectId = Brand<string, "ProjectId">;
export type GoalId = Brand<string, "GoalId">;
export type RequirementId = Brand<string, "RequirementId">;
export type AcceptanceCriterionId = Brand<string, "AcceptanceCriterionId">;
export type DecisionId = Brand<string, "DecisionId">;
export type AdrId = Brand<string, "AdrId">;
export type TaskId = Brand<string, "TaskId">;
export type AgentRoleId = Brand<string, "AgentRoleId">;
export type AgentRuntimeConfigId = Brand<string, "AgentRuntimeConfigId">;
export type AgentRunId = Brand<string, "AgentRunId">;
export type ActionId = Brand<string, "ActionId">;
export type ApprovalId = Brand<string, "ApprovalId">;
export type EvidenceId = Brand<string, "EvidenceId">;
export type ReviewId = Brand<string, "ReviewId">;
export type ReviewFindingId = Brand<string, "ReviewFindingId">;
export type CheckpointId = Brand<string, "CheckpointId">;
export type EventId = Brand<string, "EventId">;
export type ArtifactId = Brand<string, "ArtifactId">;
export type SessionId = Brand<string, "SessionId">;
export type WorkflowDefinitionId = Brand<string, "WorkflowDefinitionId">;
export type WorkflowInstanceId = Brand<string, "WorkflowInstanceId">;
export type WorkflowNodeId = Brand<string, "WorkflowNodeId">;
export type MemoryItemId = Brand<string, "MemoryItemId">;
export type ConflictId = Brand<string, "ConflictId">;
export type RecommendationId = Brand<string, "RecommendationId">;
export type ResearchRecordId = Brand<string, "ResearchRecordId">;
export type ArchitectureNodeId = Brand<string, "ArchitectureNodeId">;

export const newId = (prefix: string): string =>
  `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;

export const asProjectId = (v: string) => v as ProjectId;
export const asGoalId = (v: string) => v as GoalId;
export const asRequirementId = (v: string) => v as RequirementId;
export const asTaskId = (v: string) => v as TaskId;
export const asEvidenceId = (v: string) => v as EvidenceId;
