import type {
  Adr,
  ArchitectureEdge,
  ArchitectureNode,
  CodeIntelligenceSnapshot,
  ModelProvider,
  ProjectId,
} from "@devflow/contracts";
import { newId } from "@devflow/contracts";
import type { DocumentRepository } from "../../infrastructure/db/document-repository.js";
import type { EventStore } from "../../infrastructure/db/event-store.js";
import type { ConflictDetectionService } from "../../services/conflicts/conflict-detection-service.js";
import type { CodebaseSnapshot } from "@devflow/contracts";

/**
 * ArchitectureService (§4 Step 9): builds a visual architecture graph mapped onto the
 * EXISTING repository structure (never inventing a parallel architecture), plus ADRs
 * for significant choices. New proposals are checked against accepted ADRs for conflicts.
 */
export class ArchitectureService {
  constructor(
    private readonly docs: DocumentRepository,
    private readonly events: EventStore,
    private readonly provider: ModelProvider,
    private readonly conflicts: ConflictDetectionService,
  ) {}

  async generateArchitecture(projectId: ProjectId, mission: string, repo: CodebaseSnapshot | null): Promise<{ nodes: ArchitectureNode[]; edges: ArchitectureEdge[] }> {
    const nodes: ArchitectureNode[] = [];
    const edges: ArchitectureEdge[] = [];
    const mk = (type: ArchitectureNode["type"], name: string, description: string, metadata: Record<string, string | number | boolean> = {}): ArchitectureNode => {
      const node: ArchitectureNode = { id: newId("arch"), projectId, type, name, description, metadata };
      nodes.push(node);
      this.docs.put("architecture_node", node.id, projectId, node);
      return node;
    };
    const link = (sourceId: string, targetId: string, relation: string): void => {
      edges.push({ sourceId, targetId, relation });
    };

    // Map onto the actual repo layout when available (spec §4 Step 9).
    if (repo) {
      for (const dir of repo.topLevelDirs.slice(0, 6)) {
        mk("COMPONENT", dir, `Existing top-level module '${dir}' from repository scan`, { inferred: true });
      }
      for (let i = 0; i < Math.min(nodes.length - 1, 5); i++) {
        link(nodes[i]!.id, nodes[i + 1]!.id, "coexists in repo");
      }
    }
    const ui = mk("COMPONENT", "User-facing surface", mission.slice(0, 120), { proposed: true });
    const api = mk("API", "Application API", "Primary application interface touched by the mission", { proposed: true });
    const store = mk("DATABASE", "Primary storage", repo?.packageManagers.includes("cargo") ? "SQLite/local persistence candidate" : "application storage", { proposed: true });
    link(ui.id, api.id, "calls");
    link(api.id, store.id, "persists");

    this.events.append({
      projectId,
      type: "architecture.generated",
      entityType: "architecture",
      actorType: "ENGINE",
      payload: { nodeCount: nodes.length },
    });
    return { nodes, edges };
  }

  async proposeAdr(projectId: ProjectId, title: string, context: string, options: Adr["options"], decision: string, consequences: string[]): Promise<{ adr: Adr; conflicts: number }> {
    const existing = this.docs.list<Adr>("adr", projectId);
    const adr: Adr = {
      id: newId("adr"),
      projectId,
      stableKey: nextKey(existing.map((a) => a.stableKey)),
      title,
      context,
      options,
      decision,
      consequences,
      status: "PROPOSED",
      createdAt: new Date().toISOString(),
    };
    this.docs.put("adr", adr.id, projectId, adr);
    this.events.append({ projectId, type: "adr.created", entityType: "adr", entityId: adr.id, actorType: "ENGINE", payload: { stableKey: adr.stableKey } });

    // Decision conflict detection (§3.8): proposals never silently overwrite canon.
    const detected = this.conflicts.detectProposalConflicts(projectId, `${title}. ${decision}`);
    return { adr, conflicts: detected.length };
  }

  acceptAdr(projectId: string, adrId: string): Adr {
    const adr = this.docs.require<Adr>("adr", adrId);
    const accepted: Adr = { ...adr, status: "ACCEPTED" };
    this.docs.put("adr", accepted.id, projectId, accepted);
    this.events.append({ projectId, type: "adr.decided", entityType: "adr", entityId: adr.id, actorType: "USER", payload: { decision: accepted.decision } });
    return accepted;
  }
}

function nextKey(existing: string[]): string {
  let max = 0;
  for (const key of existing) {
    const m = /^ADR-(\d+)$/.exec(key);
    if (m) max = Math.max(max, Number.parseInt(m[1]!, 10));
  }
  return `ADR-${String(max + 1).padStart(3, "0")}`;
}

/** ImpactAnalysisService (§4 Step 10, §25): advisory impact radar combining code graph
 * and mission semantics. Distinguishes confirmed vs inferred impact explicitly. */
export class ImpactAnalysisService {
  constructor(private readonly docs: DocumentRepository, private readonly events: EventStore) {}

  analyze(projectId: ProjectId, mission: string, repo: CodebaseSnapshot | null, symbols: CodeIntelligenceSnapshot | null): Array<{
    area: string;
    severity: "Critical" | "High" | "Medium" | "Low";
    confidence: "confirmed" | "inferred" | "unknown";
    rationale: string;
  }> {
    const text = mission.toLowerCase();
    const areas: Array<{ area: string; severity: "Critical" | "High" | "Medium" | "Low"; confidence: "confirmed" | "inferred" | "unknown"; rationale: string }> = [];
    const push = (area: string, hit: boolean, severityIfHit: "Critical" | "High" | "Medium" | "Low", rationale: string) =>
      areas.push({
        area,
        severity: hit ? severityIfHit : "Low",
        confidence: hit ? "confirmed" : repo ? "inferred" : "unknown",
        rationale,
      });

    push("Authentication", /auth|login|로그인|oauth|session|권한/.test(text), "Critical", "mission text mentions authentication surface");
    push("Security", /secret|token|password|credential|보안|auth/.test(text), "Critical", "security-sensitive keywords present");
    push("Backend API", /api|endpoint|server|backend/.test(text) || !!repo, "High", repo ? "repository backend modules detected" : "keyword match");
    push("Frontend", /ui|frontend|화면|page|component/.test(text), "Medium", "UI keywords present");
    push("Database", /schema|migration|table|db|데이터베이스/.test(text), "Medium", "data-layer keywords present");
    push("Tests", true, "High", "every change requires verification evidence");
    push("Infrastructure", /deploy|infra|docker|ci/.test(text), "Low", "infrastructure keywords only sometimes relevant");

    this.events.append({
      projectId,
      type: "architecture.updated",
      entityType: "impact_analysis",
      actorType: "ENGINE",
      payload: { criticalAreas: areas.filter((a) => a.severity === "Critical").length, symbolsIndexed: symbols?.symbolsIndexed ?? 0 },
    });
    return areas;
  }
}
