import type { Checkpoint, GitAdapter, ProjectId } from "@devflow/contracts";
import type { DocumentRepository } from "../../infrastructure/db/document-repository.js";
import type { EventStore } from "../../infrastructure/db/event-store.js";

/** Checkpoints (spec §23): durable resume points bound to a revision. */
export class CheckpointService {
  constructor(
    private readonly docs: DocumentRepository,
    private readonly events: EventStore,
    private readonly git: GitAdapter,
  ) {}

  async create(params: {
    projectId: ProjectId;
    repositoryPath: string | null;
    taskId: string | null;
    completedSummary: string;
    verificationSummary: string;
    blockers: string[];
    nextAction: string;
  }): Promise<Checkpoint> {
    const revision = params.repositoryPath ? ((await this.git.currentRevision(params.repositoryPath)) ?? "no-git") : "no-git";
    const dirtyFiles = params.repositoryPath ? await this.git.changedFiles(params.repositoryPath) : [];
    const checkpoint: Checkpoint = {
      id: `ckpt_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      projectId: params.projectId,
      taskId: params.taskId,
      revision,
      dirtyFiles,
      completedSummary: params.completedSummary,
      verificationSummary: params.verificationSummary,
      blockers: params.blockers,
      nextAction: params.nextAction,
      createdAt: new Date().toISOString(),
    };
    this.docs.put("checkpoint", checkpoint.id, params.projectId, checkpoint);
    return checkpoint;
  }

  latest(projectId: string): Checkpoint | null {
    const all = this.docs.list<Checkpoint>("checkpoint", projectId);
    return all[all.length - 1] ?? null;
  }
}
