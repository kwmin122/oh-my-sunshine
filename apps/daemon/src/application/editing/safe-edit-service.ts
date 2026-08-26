import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { EditLease, ProjectId, StaleEditCheck } from "@devflow/contracts";
import { newId } from "@devflow/contracts";
import type { DocumentRepository } from "../../infrastructure/db/document-repository.js";
import type { EventStore } from "../../infrastructure/db/event-store.js";
import { assertPathInsideWorkspace } from "../../lib/path-guard.js";

/**
 * SafeEditService (§2.15, §3.9 Safe Edit Guard): stale-write protection for
 * multi-agent environments. A write is only applied when the file still matches the
 * revision the agent read. Stale patches are REJECTED (never auto-merged) — the agent
 * must re-read and re-plan.
 *
 * File identity = content hash at read time + monotonic per-file revision counter.
 */
export class SafeEditService {
  private readonly fileRevisions = new Map<string, number>();

  constructor(
    private readonly docs: DocumentRepository,
    private readonly events: EventStore,
  ) {}

  /** Agent announces what it read before preparing its patch. */
  async acquireLease(params: {
    projectId: ProjectId;
    runId: string | null;
    taskId: string | null;
    workspaceRoot: string;
    filePath: string;
    symbolId?: string | null;
  }): Promise<EditLease> {
    const safePath = assertPathInsideWorkspace(params.workspaceRoot, params.filePath);
    const hash = await this.hashFile(safePath);
    const lease: EditLease = {
      id: newId("lease"),
      projectId: params.projectId,
      runId: params.runId,
      taskId: params.taskId,
      filePath: params.filePath,
      symbolId: params.symbolId ?? null,
      expectedRevision: this.fileRevisions.get(safePath) ?? 0,
      expectedHash: hash,
      status: "HELD",
      createdAt: new Date().toISOString(),
      releasedAt: null,
    };
    this.docs.put("edit_lease", lease.id, params.projectId, lease);
    return lease;
  }

  /** Validates the base state right before applying; bumps revision on success. */
  async checkAndApply(params: {
    projectId: ProjectId;
    leaseId: string;
    workspaceRoot: string;
    nextContent: string;
    executorWrite: (path: string, content: string) => Promise<void>;
  }): Promise<StaleEditCheck> {
    const lease = this.docs.require<EditLease>("edit_lease", params.leaseId);
    const safePath = assertPathInsideWorkspace(params.workspaceRoot, lease.filePath);
    const currentHash = await this.hashFile(safePath);

    if (lease.status !== "HELD") {
      return { verdict: "STALE_REJECTED", lease, currentHash, explanation: `lease '${lease.id}' is ${lease.status}, not HELD` };
    }
    if (currentHash !== lease.expectedHash) {
      const rejected: EditLease = { ...lease, status: "STALE_REJECTED", releasedAt: new Date().toISOString() };
      this.docs.put("edit_lease", rejected.id, params.projectId, rejected);
      this.events.append({
        projectId: params.projectId,
        type: "edit.stale_rejected",
        entityType: "edit_lease",
        entityId: lease.id,
        actorType: "ENGINE",
        payload: { filePath: lease.filePath, explanation: "file changed since it was read" },
      });
      return {
        verdict: "STALE_REJECTED",
        lease: rejected,
        currentHash,
        explanation: `file '${lease.filePath}' changed since the agent read it — re-read and re-plan required`,
      };
    }

    await params.executorWrite(safePath, params.nextContent);
    this.fileRevisions.set(safePath, (this.fileRevisions.get(safePath) ?? 0) + 1);
    const consumed: EditLease = { ...lease, status: "CONSUMED", releasedAt: new Date().toISOString() };
    this.docs.put("edit_lease", consumed.id, params.projectId, consumed);
    this.events.append({
      projectId: params.projectId,
      type: "edit.applied",
      entityType: "edit_lease",
      entityId: lease.id,
      actorType: "AGENT",
      payload: { filePath: lease.filePath },
    });
    return { verdict: "APPLY", lease: consumed };
  }

  release(leaseId: string): EditLease {
    const lease = this.docs.require<EditLease>("edit_lease", leaseId);
    const released: EditLease = { ...lease, status: lease.status === "HELD" ? "RELEASED" : lease.status, releasedAt: new Date().toISOString() };
    this.docs.put("edit_lease", released.id, released.projectId, released);
    return released;
  }

  async hashFile(path: string): Promise<string | null> {
    try {
      const content = await readFile(path, "utf8");
      return createHash("sha256").update(content).digest("hex").slice(0, 16);
    } catch {
      // Missing file counts as a defined empty base so first writes are legal.
      return createHash("sha256").update("").digest("hex").slice(0, 16);
    }
  }
}
