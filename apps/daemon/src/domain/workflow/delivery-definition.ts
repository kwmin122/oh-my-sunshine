import type { WorkflowDefinition } from "@devflow/contracts";
import { newId } from "@devflow/contracts";

/**
 * The built-in delivery workflow (spec §4 Step 11A):
 * Discovery STEP → Readiness GATE → Risk SPLITTER → tier paths →
 * Planning STEP → Task Execution DELEGATE → Verification GATE → Review STEP → Completion GATE → TERMINAL.
 */
export function buildDeliveryWorkflowDefinition(): WorkflowDefinition {
  const n = (id: string) => newId(`node_${id}`);
  const ids = {
    discovery: n("discovery"),
    readinessGate: n("readiness"),
    splitter: n("riskSplitter"),
    researchHigh: n("researchHigh"),
    architectureHigh: n("architectureHigh"),
    approvalHigh: n("approvalHigh"),
    planning: n("planning"),
    executionDelegate: n("executeTasks"),
    verificationGate: n("verification"),
    review: n("review"),
    completionGate: n("completion"),
    terminal: n("terminal"),
  };

  return {
    id: newId("wfdef_delivery"),
    name: "delivery",
    version: 1,
    entryNodeId: ids.discovery,
    nodes: [
      { id: ids.discovery, type: "STEP", name: "Discovery", retryLimit: 0 },
      { id: ids.readinessGate, type: "GATE", name: "Readiness Gate", gatePredicate: "readiness_gate", retryLimit: 0 },
      { id: ids.splitter, type: "SPLITTER", name: "Risk Splitter", splitterKey: "risk_tier", retryLimit: 0 },
      { id: ids.researchHigh, type: "STEP", name: "Research (HIGH only)", retryLimit: 1 },
      { id: ids.architectureHigh, type: "STEP", name: "Architecture (HIGH only)", retryLimit: 1 },
      { id: ids.approvalHigh, type: "GATE", name: "Approval Gate (HIGH)", gatePredicate: "approval_gate", retryLimit: 0 },
      { id: ids.planning, type: "STEP", name: "Planning", retryLimit: 1 },
      { id: ids.executionDelegate, type: "DELEGATE", name: "Task Execution", retryLimit: 0 },
      { id: ids.verificationGate, type: "GATE", name: "Verification Gate", gatePredicate: "verification_gate", retryLimit: 0 },
      { id: ids.review, type: "STEP", name: "Two-Stage Review", retryLimit: 2 },
      { id: ids.completionGate, type: "GATE", name: "Completion Gate", gatePredicate: "completion_gate", retryLimit: 0 },
      { id: ids.terminal, type: "TERMINAL", name: "Done", retryLimit: 0 },
    ],
    edges: [
      { fromNodeId: ids.discovery, toNodeId: ids.readinessGate },
      { fromNodeId: ids.readinessGate, toNodeId: ids.splitter },
      // HIGH path adds research/architecture/approval ceremony before planning.
      {
        fromNodeId: ids.splitter,
        toNodeId: ids.researchHigh,
        condition: { kind: "RISK_TIER_EQUALS", value: "HIGH" },
      },
      {
        fromNodeId: ids.splitter,
        toNodeId: ids.planning,
        condition: { kind: "DEFAULT" },
      },
      { fromNodeId: ids.researchHigh, toNodeId: ids.architectureHigh },
      { fromNodeId: ids.architectureHigh, toNodeId: ids.approvalHigh },
      { fromNodeId: ids.approvalHigh, toNodeId: ids.planning },
      { fromNodeId: ids.planning, toNodeId: ids.executionDelegate },
      { fromNodeId: ids.executionDelegate, toNodeId: ids.verificationGate },
      { fromNodeId: ids.verificationGate, toNodeId: ids.review },
      { fromNodeId: ids.review, toNodeId: ids.completionGate },
      { fromNodeId: ids.completionGate, toNodeId: ids.terminal },
    ],
  };
}
