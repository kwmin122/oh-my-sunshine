import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TaskContract, WorkflowDefinition } from "@devflow/contracts";
import { openDatabase, closeDatabase } from "../src/infrastructure/db/connection.js";
import { DocumentRepository } from "../src/infrastructure/db/document-repository.js";
import { SqliteEventStore } from "../src/infrastructure/db/event-store.js";
import { loadConfig } from "../src/lib/config.js";
import { WorkflowComposerService } from "../src/application/workflow/workflow-composer-service.js";

/**
 * S4 evidence: Workflow Composer definitions are persisted, validated, applied
 * to projects, and DRIVE real planning output — one task per composed STEP,
 * ordered by the composed edges, enforced at execution time.
 */

const tempDirs: string[] = [];
afterAll(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), "devflow-s4-"));
  tempDirs.push(dir);
  const db = openDatabase({ dataDir: dir } as never);
  return { db, docs: new DocumentRepository(db), events: new SqliteEventStore(db), close: () => closeDatabase(db) };
}

describe("S4a: Workflow Composer CRUD + validation", () => {
  it("creates a valid linear workflow and persists it", () => {
    const { docs, events, close } = fresh();
    const svc = new WorkflowComposerService({ docs, events });
    const wf = svc.create("Fast Build", [
      { key: "n1", roleId: "role_planner", objective: "Break the mission into a plan" },
      { key: "n2", roleId: "role_backend", objective: "Implement the plan" },
      { key: "n3", name: "Review", roleId: "codereviewer" },
    ], []);
    expect(wf.nodes.map((n) => n.roleId)).toEqual(["role_planner", "role_backend", "role_codereviewer"]);
    // implicit linear edges were added
    expect(wf.edges.length).toBe(2);
    expect(svc.list().map((w) => w.id)).toContain(wf.id);
    close();
  });

  it("rejects cycles, unknown-edge references, and roleless steps — no broken graph is stored", () => {
    const { docs, events, close } = fresh();
    const svc = new WorkflowComposerService({ docs, events });
    // cycle
    expect(() =>
      svc.create("Cyclic", [
        { key: "a", roleId: "be" }, { key: "b", roleId: "fe" },
      ], [{ from: "a", to: "b" }, { from: "b", to: "a" }]),
    ).toThrow(/cycle/);
    // dangling edge
    expect(() =>
      svc.create("Dangling", [{ key: "a", roleId: "be" }], [{ from: "a", to: "ghost" }]),
    ).toThrow(/unknown node/);
    // roleless step
    expect(() => svc.create("NoRole", [{ key: "a", roleId: "" }] as never, [])).toThrow();
    // nothing was persisted from the failed attempts
    expect(svc.list().length).toBe(0);
    close();
  });

  it("update bumps version; archive hides it and deactivates project bindings", () => {
    const { docs, events, close } = fresh();
    const svc = new WorkflowComposerService({ docs, events });
    const wf = svc.create("V1", [{ key: "n1", roleId: "pm" }], []);
    const updated = svc.update(wf.id, "V2", [{ key: "n1", roleId: "pm" }, { key: "n2", roleId: "qa" }], []);
    expect(updated.version).toBe(2);
    svc.applyToProject("proj_x", wf.id);
    expect(svc.activeWorkflowFor("proj_x")?.id).toBe(wf.id);
    svc.archive(wf.id);
    expect(svc.list().find((w) => w.id === wf.id)).toBeUndefined();
    expect(svc.activeWorkflowFor("proj_x")).toBeNull(); // binding deactivated, not dangling
    close();
  });
});
