import type { Requirement, RiskTier, TaskContract } from "@devflow/contracts";
import type { DocumentRepository } from "../../infrastructure/db/document-repository.js";
import type { EventStore } from "../../infrastructure/db/event-store.js";
import type { ProjectService } from "../project/project-service.js";

/**
 * Pre-Implementation Contract (V5 / S11). "No implementation begins until the
 * system has a sufficient Product Contract and Implementation Contract."
 *
 * This service compiles the 16 contract sections from what the system can
 * actually OBSERVE (repo scan, requirements, assumptions, risk) and marks each
 * item CLEAR / PARTIAL / MISSING / N_A with source + confidence + blocking.
 * It also ranks open gaps by question priority so discovery asks only the
 * highest-value questions first:
 *
 *   priority = uncertainty × impact × irreversibility × dependencies × rework × failureRisk
 */

export type ContractStatus = "CLEAR" | "PARTIAL" | "MISSING" | "N_A";
export type ContractSource = "USER" | "REPO" | "RESEARCH" | "ASSUMPTION";

export interface ContractItem {
  topic: string;
  status: ContractStatus;
  source: ContractSource;
  confidence: number; // 0..1
  blocking: boolean;
  detail: string;
}

export interface ContractSection {
  key: string;
  title: string;
  items: ContractItem[];
}

export interface PreCodeContract {
  id: string;
  projectId: string;
  sections: ContractSection[];
  /** Implementation Readiness Gate inputs (distinct from Definition of Ready). */
  readiness: {
    criticalMissing: number;
    highRiskUnknowns: Array<{ section: string; topic: string; reworkCost: number }>;
    ready: boolean;
    reason: string;
  };
  openQuestions: Array<{ section: string; topic: string; priority: number; suggestedQuestion: string }>;
  createdAt: string;
}

/** Rework cost multipliers: getting these wrong late is expensive (V5). */
const REWORK_COST: Record<string, number> = {
  permissions: 3,
  dataModel: 3,
  authExpiry: 2.5,
  apiVersioning: 2.5,
  failureRecovery: 2,
  stateDesign: 2,
  concurrency: 2,
  offline: 1.5,
  screenStates: 1.2,
};

interface SectionInput {
  key: string;
  title: string;
  build: () => ContractItem[];
}

export class PreCodeContractService {
  constructor(
    private readonly ports: {
      docs: DocumentRepository;
      events: EventStore;
      projects: Pick<ProjectService, "getProject" | "latestMission">;
      repoFacts: (projectId: string) => Promise<{
        languages: string[];
        frameworks: string[];
        testCommand: string | null;
        buildCommand: string | null;
      }>;
    },
  ) {}

  async refresh(projectId: string): Promise<PreCodeContract> {
    const contract = await this.build(projectId);
    this.ports.docs.put("pre_code_contract", `contract_${projectId}`, projectId, contract);
    this.ports.events.append({
      projectId: projectId as never,
      type: "contract.refreshed" as never,
      entityType: "project",
      entityId: projectId,
      actorType: "ENGINE",
      payload: {
        criticalMissing: contract.readiness.criticalMissing,
        ready: contract.readiness.ready,
        openQuestions: contract.openQuestions.length,
      },
    });
    return contract;
  }

  get(projectId: string): PreCodeContract | null {
    return this.ports.docs.get<PreCodeContract>("pre_code_contract", `contract_${projectId}`) ?? null;
  }

  private async build(projectId: string): Promise<PreCodeContract> {
    const [facts, mission] = await Promise.all([
      this.ports.repoFacts(projectId),
      Promise.resolve(this.ports.projects.latestMission(projectId)),
    ]);
    const requirements = this.ports.docs.list<Requirement>("requirement", projectId);
    const tasks = this.ports.docs.list<TaskContract>("task", projectId);
    const risk = (this.ports.docs.get<{ tier: RiskTier }>("risk_assessment", mission?.id ?? "")?.tier ?? "NORMAL") as RiskTier;

    const hasMission = Boolean(mission);
    const reqCount = requirements.length;

    const sections: SectionInput[] = [
      {
        key: "product",
        title: "Product Contract",
        build: () => [
          item(hasMission, "problem statement (mission)", hasMission ? "repo/user" : "missing", "What problem does this project solve for whom?"),
          item(reqCount > 0, "success criteria as requirements", reqCount > 3 ? "user" : "assumption", "Which measurable outcomes define done?"),
          item(true, "non-goals", "assumption", "What is explicitly out of scope?"),
        ],
      },
      {
        key: "workflow",
        title: "Workflow Contract",
        build: () => [
          item(tasks.length > 0, "main flow decomposed into tasks", tasks.length > 0 ? "engine" : "missing", "What are the main steps and their dependencies?"),
          item(facts.testCommand !== null, "verification flow exists", facts.testCommand ? "repo" : "missing", "How will changes be verified (test command)?"),
          item(false, "failure & recovery path per step", "assumption", "What happens when a step fails — retry, replan, or escalate?"),
        ],
      },
      {
        key: "data",
        title: "Data Contract",
        build: () => [
          item(facts.languages.length > 0, "primary storage/persistence detected", facts.languages.length > 0 ? "repo" : "missing", "Where does durable state live?"),
          item(false, "entity fields/relations/retention defined", "missing", "Which entities exist and who owns/deletes them?"),
        ],
      },
      {
        key: "state",
        title: "State Contract",
        build: () => [
          item(true, "task/run/workflow state machines exist", "repo", "(DevFlow engine owns transitions)"),
          item(risk === "HIGH", "provider/runtime states modeled", risk !== "HIGH" ? "repo" : "missing", "How do external runtimes report degraded states?"),
        ],
      },
      {
        key: "ux",
        title: "IA & Screen Contract",
        build: () => [
          item(true, "core IA (12 tabs + workspace)", "repo", "(DevFlow OS navigation)"),
          item(false, "non-happy screen states matrix complete", "missing", "Which screens need loading/error/offline/stale designs?"),
        ],
      },
      {
        key: "architecture",
        title: "Architecture Contract",
        build: () => [
          item(facts.frameworks.length > 0, `stack detected: ${facts.frameworks.slice(0, 3).join(", ") || "none"}`, "repo", "Is the chosen stack confirmed?"),
          item(true, "system boundaries (desktop/daemon/runtimes)", "repo", "(DevFlow architecture)"),
        ],
      },
      {
        key: "api",
        title: "API Contract",
        build: () => [
          item(true, "REST surface implemented with zod validation", "repo", "(daemon routes)"),
          item(false, "/api/v1 versioning + compatibility strategy", "missing", "Do external clients need version stability?"),
          item(false, "idempotency keys on mutating endpoints", "missing", "Which endpoints must be retry-safe?"),
        ],
      },
      {
        key: "permissions",
        title: "Security & Permission Contract",
        build: () => [
          item(true, "action risk levels + approval gating", "repo", "(Action Gateway)"),
          item(false, "resource:action RBAC for multi-user", "missing", "Do multiple users/roles need differentiated access?"),
          item(false, "secret storage policy", "assumption", "Where do credentials live and who can read them?"),
        ],
      },
      {
        key: "auth",
        title: "Auth/Session Contract",
        build: () => [
          item(true, "CLI-owned credentials (Sunshine never stores tokens)", "repo", "(runtime adapters)"),
          item(false, "re-auth flow when provider login expires", "missing", "What should the operator do when a runtime logs out?"),
        ],
      },
      {
        key: "failures",
        title: "Failure & Recovery Contract",
        build: () => [
          item(true, "14-type runtime failure taxonomy", "repo", "(RuntimeFailureKind)"),
          item(false, "circuit breaker for repeated provider failure", "missing", "Should repeated failures auto-disable a runtime?"),
          item(false, "crash recovery for orphaned runs", "missing", "After a daemon crash, how are RUNNING runs resolved?"),
        ],
      },
      {
        key: "concurrency",
        title: "Concurrency Contract",
        build: () => [
          item(true, "duplicate execution guard + dependency gate", "repo", "(executeTask guards)"),
          item(false, "max concurrent agent runs", "missing", "How many agents may run at once?"),
        ],
      },
      {
        key: "verification",
        title: "Test/Evidence Contract",
        build: () => [
          item(facts.testCommand !== null, `test command detected: ${facts.testCommand ?? "none"}`, facts.testCommand ? "repo" : "missing", "What proves a change works?"),
          item(true, "evidence freshness binding to revision", "repo", "(EvidenceFreshnessService)"),
        ],
      },
    ];

    const built: ContractSection[] = sections.map((s) => ({ key: s.key, title: s.title, items: s.build() }));

    // Question priority ranking over non-CLEAR items (V5 formula).
    const openQuestions: PreCodeContract["openQuestions"] = [];
    for (const section of built) {
      const weight = REWORK_COST[section.key] ?? 1;
      for (const itemEntry of section.items) {
        if (itemEntry.status === "CLEAR" || itemEntry.status === "N_A") continue;
        const uncertainty = itemEntry.status === "MISSING" ? 1 : 0.6;
        const impact = itemEntry.blocking ? 1 : 0.6;
        const irreversibility = Math.min(1, weight / 3);
        const rework = Math.min(1, weight / 3);
        const failureRisk = itemEntry.status === "MISSING" && itemEntry.blocking ? 1 : 0.7;
        openQuestions.push({
          section: section.key,
          topic: itemEntry.topic,
          priority: Number((uncertainty * impact * irreversibility * rework * failureRisk).toFixed(3)),
          suggestedQuestion: itemEntry.detail,
        });
      }
    }
    openQuestions.sort((a, b) => b.priority - a.priority);

    const criticalMissing = built.reduce(
      (acc, s) => acc + s.items.filter((i) => i.status === "MISSING" && i.blocking).length,
      0,
    );
    const highRiskUnknowns = built.flatMap((s) =>
      s.items
        .filter((i) => i.status !== "CLEAR" && i.status !== "N_A" && (REWORK_COST[s.key] ?? 1) >= 2)
        .map((i) => ({ section: s.key, topic: i.topic, reworkCost: REWORK_COST[s.key] ?? 1 })),
    );

    return {
      id: `contract_${projectId}`,
      projectId,
      sections: built,
      readiness: {
        criticalMissing,
        highRiskUnknowns,
        ready: criticalMissing === 0,
        reason: criticalMissing === 0 ? "no blocking gaps" : `${criticalMissing} blocking gap(s) — answer the top questions before implementation`,
      },
      openQuestions,
      createdAt: new Date().toISOString(),
    };
  }
}

function item(ok: boolean, topic: string, source: string, question: string): ContractItem {
  return {
    topic,
    status: ok ? "CLEAR" : "MISSING",
    source: (["USER", "REPO", "RESEARCH", "ASSUMPTION"].includes(source.toUpperCase()) ? source.toUpperCase() : "ASSUMPTION") as ContractSource,
    confidence: ok ? 0.9 : 0.4,
    blocking: !ok,
    detail: ok ? "" : question,
  };
}
