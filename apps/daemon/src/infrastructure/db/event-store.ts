import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import type {
  DevFlowEvent,
  DevFlowEventType,
  DevFlowEventPayload,
  ProjectId,
} from "@devflow/contracts";

export interface AppendEventInput {
  projectId: ProjectId;
  type: DevFlowEventType;
  actorType: "USER" | "AGENT" | "ENGINE" | "SYSTEM";
  actorId?: string | null;
  entityType?: string | null;
  entityId?: string | null;
  payload?: DevFlowEventPayload;
}

export interface EventStore {
  append(input: AppendEventInput): DevFlowEvent;
  listByProject(projectId: ProjectId, opts?: { afterSequence?: number; limit?: number }): DevFlowEvent[];
  latestSequence(projectId: ProjectId): number;
}

type BroadcastFn = (event: DevFlowEvent) => void;

export class SqliteEventStore implements EventStore {
  private broadcast: BroadcastFn | null = null;

  constructor(private readonly db: DatabaseSync) {}

  /** Live subscribers (WebSocket) get pushed events; persistence stays authoritative. */
  setBroadcast(fn: BroadcastFn): void {
    this.broadcast = fn;
  }

  append(input: AppendEventInput): DevFlowEvent {
    const timestamp = new Date().toISOString();
    const stmt = this.db.prepare(
      `INSERT INTO events (id, project_id, sequence, type, entity_type, entity_id, actor_type, actor_id, payload, timestamp)
       VALUES (?, ?, (SELECT COALESCE(MAX(sequence), 0) + 1 FROM events WHERE project_id = ?), ?, ?, ?, ?, ?, ?, ?)`,
    );
    const id = randomUUID();
    stmt.run(
      id,
      input.projectId,
      input.projectId,
      input.type,
      input.entityType ?? null,
      input.entityId ?? null,
      input.actorType,
      input.actorId ?? null,
      JSON.stringify(input.payload ?? {}),
      timestamp,
    );
    const event: DevFlowEvent = {
      id,
      projectId: input.projectId,
      sequence: Number(
        this.db
          .prepare("SELECT sequence FROM events WHERE id = ?")
          .get(id)?.sequence ?? 0,
      ),
      type: input.type,
      entityType: input.entityType ?? null,
      entityId: input.entityId ?? null,
      actorType: input.actorType,
      actorId: input.actorId ?? null,
      payload: input.payload ?? {},
      timestamp,
    };
    if (event.sequence === 0) {
      throw new Error(`[event-store/append] failed to read back sequence for event ${id}`);
    }
    this.broadcast?.(event);
    return event;
  }

  listByProject(projectId: ProjectId, opts?: { afterSequence?: number; limit?: number }): DevFlowEvent[] {
    const after = opts?.afterSequence ?? 0;
    const limit = Math.min(opts?.limit ?? 1000, 5000);
    const rows = this.db
      .prepare(
        "SELECT * FROM events WHERE project_id = ? AND sequence > ? ORDER BY sequence ASC LIMIT ?",
      )
      .all(projectId, after, limit) as Array<Record<string, unknown>>;
    return rows.map(hydrateEvent);
  }

  latestSequence(projectId: ProjectId): number {
    const row = this.db
      .prepare("SELECT MAX(sequence) AS seq FROM events WHERE project_id = ?")
      .get(projectId) as { seq: number | null };
    return row.seq ?? 0;
  }
}

function hydrateEvent(row: Record<string, unknown>): DevFlowEvent {
  let payload: DevFlowEventPayload = {};
  try {
    payload = JSON.parse(String(row.payload)) as DevFlowEventPayload;
  } catch {
    payload = { _corrupt: String(row.payload) };
  }
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    sequence: Number(row.sequence),
    type: String(row.type),
    entityType: row.entity_type === null ? null : String(row.entity_type),
    entityId: row.entity_id === null ? null : String(row.entity_id),
    actorType: String(row.actor_type) as DevFlowEvent["actorType"],
    actorId: row.actor_id === null ? null : String(row.actor_id),
    payload,
    timestamp: String(row.timestamp),
  };
}
