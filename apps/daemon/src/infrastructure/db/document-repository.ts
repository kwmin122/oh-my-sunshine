import type { DatabaseSync } from "node:sqlite";
import type { ProjectId } from "@devflow/contracts";

/**
 * Document repository over SQLite. Each aggregate kind gets a typed façade;
 * payloads are JSON with validation at hydration. `kind` values are the single
 * source of truth for what exists — repositories never invent kinds.
 */
export const DOC_KINDS = [
  "project",
  "goal",
  "mission",
  "requirement",
  "acceptance_criterion",
  "discovery_question",
  "research_record",
  "decision",
  "adr",
  "architecture_node",
  "task",
  "agent_role",
  "runtime_config",
  "agent_run",
  "agent_session",
  "action",
  "approval",
  "evidence",
  "review",
  "checkpoint",
  "artifact",
  "workflow_definition",
  "workflow_instance",
  "memory_item",
  "conflict",
  "recommendation",
  "intent_record",
  "symbol_record",
  "edit_lease",
  "drift_finding",
  "provider_capacity",
  "playbook",
  "mobile_device",
  "risk_assessment",
  "team_binding",
  "team_task_override",
  "team_preset_my_team",
  "handoff_packet",
  "workflow_preset",
  "custom_role",
] as const;

export type DocKind = (typeof DOC_KINDS)[number];

export class DocumentRepository {
  constructor(private readonly db: DatabaseSync) {}

  put(kind: DocKind, id: string, projectId: string | null, data: unknown): void {
    this.db
      .prepare(
        `INSERT INTO documents (kind, id, project_id, data, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(kind, id) DO UPDATE SET data = excluded.data, project_id = excluded.project_id, updated_at = excluded.updated_at`,
      )
      .run(kind, id, projectId, JSON.stringify(data), new Date().toISOString());
  }

  get<T>(kind: DocKind, id: string): T | null {
    const row = this.db.prepare("SELECT data FROM documents WHERE kind = ? AND id = ?").get(kind, id) as
      | { data: string }
      | undefined;
    if (!row) return null;
    return JSON.parse(row.data) as T;
  }

  require<T>(kind: DocKind, id: string): T {
    const found = this.get<T>(kind, id);
    if (found === null) {
      throw new Error(`[document-repository/require] missing ${kind} '${id}'`);
    }
    return found;
  }

  list<T>(kind: DocKind, projectId?: string): T[] {
    const rows =
      projectId === undefined
        ? (this.db.prepare("SELECT data FROM documents WHERE kind = ? ORDER BY updated_at ASC").all(kind) as Array<{
            data: string;
          }>)
        : (this.db
            .prepare("SELECT data FROM documents WHERE kind = ? AND project_id = ? ORDER BY updated_at ASC")
            .all(kind, projectId) as Array<{ data: string }>);
    return rows.map((r) => JSON.parse(r.data) as T);
  }

  delete(kind: DocKind, id: string): void {
    this.db.prepare("DELETE FROM documents WHERE kind = ? AND id = ?").run(kind, id);
  }

  deleteByProject(projectId: ProjectId): void {
    this.db.prepare("DELETE FROM documents WHERE project_id = ?").run(projectId);
  }
}
