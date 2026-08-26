import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Adr, CanonArtifact, ProjectId, Requirement, TaskContract } from "@devflow/contracts";
import type { DocumentRepository } from "../../infrastructure/db/document-repository.js";
import type { EventStore } from "../../infrastructure/db/event-store.js";

/**
 * CanonService (§11, §36): single canonical home per truth type + export/import of
 * the .devflow control packet. Document-sprawl prevention lives in artifactFor():
 * every information kind maps to exactly one canonical owner.
 */
export type CanonKind = "AGENTS_MD" | "MASTER_SPEC" | "ARCHITECTURE" | "STATE" | "README" | "TASK_CONTRACT" | "ADR";

export function canonicalOwnerFor(infoKind: "requirement" | "architecture" | "progress" | "coding_policy" | "architecture_choice" | "task_detail"): CanonKind {
  switch (infoKind) {
    case "requirement":
      return "MASTER_SPEC";
    case "architecture":
      return "ARCHITECTURE";
    case "progress":
      return "STATE";
    case "coding_policy":
      return "AGENTS_MD";
    case "architecture_choice":
      return "ADR";
    case "task_detail":
      return "TASK_CONTRACT";
  }
}

export class CanonService {
  constructor(
    private readonly docs: DocumentRepository,
    private readonly events: EventStore,
  ) {}

  get(projectId: string, type: CanonKind, refId = ""): CanonArtifact | null {
    return this.docs.get<CanonArtifact>("artifact", `${type.toLowerCase()}:${projectId}:${refId}`);
  }

  put(artifact: { id: string; projectId: ProjectId; type: CanonKind; canonicalName: string; content: string; path: string | null }): CanonArtifact {
    const existing = this.docs.get<CanonArtifact>("artifact", artifact.id);
    const final: CanonArtifact = {
      ...artifact,
      revision: (existing?.revision ?? 0) + 1,
      updatedAt: new Date().toISOString(),
    };
    this.docs.put("artifact", final.id, final.projectId, final);
    this.events.append({
      projectId: final.projectId,
      type: final.revision === 1 ? "spec.generated" : "spec.updated",
      entityType: "artifact",
      entityId: final.id,
      actorType: "ENGINE",
      payload: { canonicalName: final.canonicalName, revision: final.revision },
    });
    return final;
  }

  /** Exports the full project control packet to <repo>/.devflow/. */
  async exportControlPacket(projectId: ProjectId, targetDir: string): Promise<string[]> {
    const written: string[] = [];
    const writeDoc = async (relPath: string, content: string): Promise<void> => {
      const abs = join(targetDir, relPath);
      await mkdir(abs.slice(0, abs.lastIndexOf("/")), { recursive: true });
      await writeFile(abs, content, "utf8");
      written.push(relPath);
    };

    const artifacts = this.docs.list<CanonArtifact>("artifact", projectId);
    for (const a of artifacts) {
      if (a.type === "MASTER_SPEC") await writeDoc(".devflow/MASTER_SPEC.md", a.content);
      if (a.type === "ARCHITECTURE") await writeDoc(".devflow/ARCHITECTURE.md", a.content);
      if (a.type === "AGENTS_MD") await writeDoc(".devflow/AGENTS.md", a.content);
      if (a.type === "STATE") await writeDoc(".devflow/STATE.md", a.content);
      if (a.type === "README") await writeDoc(".devflow/README.md", a.content);
    }
    for (const task of this.docs.list<TaskContract>("task", projectId)) {
      await writeDoc(`.devflow/tasks/${task.stableKey}.md`, renderTaskContract(task));
    }
    for (const adr of this.docs.list<Adr>("adr", projectId)) {
      await writeDoc(`.devflow/decisions/${adr.stableKey}.md`, renderAdr(adr));
    }
    return written;
  }

  /** Imports structured state from an exported packet directory listing. */
  async importControlPacket(projectId: ProjectId, files: Array<{ relPath: string; content: string }>): Promise<number> {
    let imported = 0;
    for (const file of files) {
      if (file.relPath === ".devflow/MASTER_SPEC.md") {
        this.put({ id: `master_spec:${projectId}`, projectId, type: "MASTER_SPEC", canonicalName: "MASTER_SPEC.md", content: file.content, path: null });
        imported++;
      } else if (file.relPath === ".devflow/ARCHITECTURE.md") {
        this.put({ id: `architecture:${projectId}`, projectId, type: "ARCHITECTURE", canonicalName: "ARCHITECTURE.md", content: file.content, path: null });
        imported++;
      } else if (/^\.devflow\/tasks\/TASK-\d+\.md$/.test(file.relPath)) {
        const stableKey = file.relPath.split("/").pop()!.replace(".md", "");
        const task = this.docs.list<TaskContract>("task", projectId).find((t) => t.stableKey === stableKey);
        if (task) {
          this.put({ id: `task_contract:${projectId}:${task.id}`, projectId, type: "TASK_CONTRACT", canonicalName: `${stableKey}.md`, content: file.content, path: file.relPath });
          imported++;
        }
      }
    }
    return imported;
  }
}

function renderTaskContract(task: TaskContract): string {
  return [
    `# ${task.stableKey} — ${task.objective}`,
    "",
    `- Risk tier: **${task.riskTier}**`,
    `- Status: ${task.status}`,
    `- Requirements: ${task.requirementIds.join(", ") || "(none)"}`,
    `- Dependencies: ${task.dependencyTaskIds.join(", ") || "(none)"}`,
    "",
    "## Plan",
    ...task.plannedSteps.map((s) => `- ${s}`),
    "",
    "## Verification",
    ...task.verificationCommands.map((c) => `- \`${c}\``),
    task.handoffNotes ? `\n## Handoff\n${task.handoffNotes}` : "",
  ].join("\n");
}

function renderAdr(adr: Adr): string {
  return [
    `# ${adr.stableKey} — ${adr.title}`,
    "",
    `Status: **${adr.status}**`,
    "",
    "## Context",
    adr.context,
    "",
    "## Options",
    ...adr.options.map((o) => `- **${o.label}**: ${o.tradeoffs}`),
    "",
    "## Decision",
    adr.decision,
    "",
    "## Consequences",
    ...adr.consequences.map((c) => `- ${c}`),
  ].join("\n");
}
