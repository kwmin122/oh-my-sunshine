import type { MemoryItem, Recommendation, TaskContract } from "@devflow/contracts";
import { canPromoteMemory, newId } from "@devflow/contracts";
import type { DocumentRepository } from "../../infrastructure/db/document-repository.js";
import type { EventStore } from "../../infrastructure/db/event-store.js";

/**
 * Memory promotion lifecycle (spec §2.11): OBSERVED → EXTRACTED → CONFIRMED → CANONICAL.
 * Agent observations never become canonical truth in one hop.
 */
export class MemoryPromotionService {
  constructor(
    private readonly docs: DocumentRepository,
    private readonly events: EventStore,
  ) {}

  observe(projectId: string, category: string, statement: string, source: MemoryItem["source"], confidence = 0.5): MemoryItem {
    const item: MemoryItem = {
      id: newId("mem"),
      projectId,
      goalId: null,
      category,
      statement,
      lifecycle: "OBSERVED",
      source,
      confidence,
      canonicalArtifactRef: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.docs.put("memory_item", item.id, projectId, item);
    this.events.append({ projectId, type: "memory.observed", entityType: "memory_item", entityId: item.id, actorType: "AGENT", payload: { category } });
    return item;
  }

  promote(memoryId: string, to: MemoryItem["lifecycle"], canonicalArtifactRef?: string): MemoryItem {
    const item = this.docs.require<MemoryItem>("memory_item", memoryId);
    if (!canPromoteMemory(item.lifecycle, to)) {
      throw new Error(`[memory/promote] illegal promotion ${item.lifecycle} → ${to}`);
    }
    const updated: MemoryItem = {
      ...item,
      lifecycle: to,
      confidence: Math.min(1, item.confidence + 0.2),
      canonicalArtifactRef: to === "CANONICAL" ? canonicalArtifactRef ?? item.canonicalArtifactRef : item.canonicalArtifactRef,
      updatedAt: new Date().toISOString(),
    };
    this.docs.put("memory_item", item.id, item.projectId, updated);
    this.events.append({
      projectId: item.projectId,
      type: to === "CANONICAL" ? "memory.promoted" : "memory.confirmed",
      entityType: "memory_item",
      entityId: item.id,
      actorType: "ENGINE",
      payload: { from: item.lifecycle, to },
    });
    return updated;
  }

  listByProject(projectId: string): MemoryItem[] {
    return this.docs.list<MemoryItem>("memory_item", projectId);
  }
}
