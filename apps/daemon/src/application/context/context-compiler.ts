import type { AgentRole, Checkpoint, Requirement, TaskContract } from "@devflow/contracts";
import type { CanonArtifact } from "@devflow/contracts";
import type { DocumentRepository } from "../../infrastructure/db/document-repository.js";

export interface CompiledContext {
  markdown: string;
  included: string[];
  excluded: string[];
  approxTokens: number;
}

/**
 * Context Compiler (spec §10). Role/task-specific packets with an explicit budget.
 * Never truncates: objective, acceptance criteria, safety constraints, approved decisions,
 * required interfaces. Excludes raw transcripts and unrelated areas by default.
 */
export class ContextCompiler {
  constructor(
    private readonly docs: DocumentRepository,
    private readonly budgetTokens: number,
  ) {}

  compile(params: { role: AgentRole; task: TaskContract; workspaceRoot: string }): CompiledContext {
    const included: string[] = [];
    const excluded: string[] = [];

    // Never-truncate section first (spec §10.1).
    const requirements = params.task.requirementIds
      .map((id) => this.docs.get<Requirement>("requirement", id))
      .filter((r): r is Requirement => r !== null);

    const sections: Array<{ title: string; body: string; priority: "NEVER_TRUNCATE" | "HIGH" | "LOW" }> = [
      {
        title: "ROLE",
        body: `${params.role.name}\n${params.role.responsibility}`,
        priority: "NEVER_TRUNCATE",
      },
      {
        title: "TASK OBJECTIVE",
        body: `[${params.task.stableKey}] ${params.task.objective}`,
        priority: "NEVER_TRUNCATE",
      },
      {
        title: "ACCEPTANCE CRITERIA",
        body:
          params.task.acceptanceCriteriaIds.length > 0
            ? params.task.acceptanceCriteriaIds.map((acId) => `- AC ${acId}`).join("\n")
            : "- Task completes when its verification commands pass",
        priority: "NEVER_TRUNCATE",
      },
      {
        title: "ENGINEERING CONSTITUTION (excerpt)",
        body: [
          "- Smallest coherent change; no unrelated refactors.",
          "- Inspect existing patterns before writing.",
          "- Errors must never be swallowed silently.",
          "- Tests accompany behavior changes.",
          "- Report evidence, not claims.",
        ].join("\n"),
        priority: "NEVER_TRUNCATE",
      },
      {
        title: "RELEVANT REQUIREMENTS",
        body: requirements.map((r) => `- [${r.stableKey}] (${r.category}) ${r.statement}`).join("\n") || "(none)",
        priority: "NEVER_TRUNCATE",
      },
      {
        title: "AFFECTED MODULES / FILES",
        body: params.task.affectedModules.join("\n") || "(impact analysis pending)",
        priority: "HIGH",
      },
      {
        title: "REQUIRED VERIFICATION",
        body: [...params.task.requiredEvidenceTypes.map((t) => `evidence: ${t}`), ...params.task.verificationCommands.map((c) => `command: ${c}`)].join("\n"),
        priority: "HIGH",
      },
      {
        title: "PERMISSIONS",
        body: `Preset allows: ${params.task.permissionsNeeded.join(", ")}. All actions pass the gateway; dangerous operations require human approval.`,
        priority: "NEVER_TRUNCATE",
      },
    ];

    // Latest checkpoint if present.
    const checkpoints = this.docs.list<Checkpoint>("checkpoint").filter((c) => c.projectId === params.task.projectId);
    const latest = checkpoints[checkpoints.length - 1];
    if (latest) {
      sections.push({
        title: "CURRENT CHECKPOINT",
        body: `revision ${latest.revision}; done: ${latest.completedSummary}; next: ${latest.nextAction}`,
        priority: "HIGH",
      });
    }

    let markdown = "";
    for (const section of sections) {
      markdown += `\n# ${section.title}\n${section.body}\n`;
      included.push(section.title);
    }
    excluded.push("raw transcripts", "unrelated agent reasoning", "stale exploratory notes");

    return {
      markdown,
      included,
      excluded,
      approxTokens: Math.ceil(markdown.length / 4),
    };
  }

  /** Budget check used by orchestrators to decide compaction. */
  withinBudget(ctx: CompiledContext): boolean {
    return ctx.approxTokens <= this.budgetTokens;
  }
}
