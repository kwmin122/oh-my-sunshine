# DevFlow OS — Architecture

## 1. Product form

```
DevFlow Desktop (Tauri v2 shell · React 19 · React Flow)
        │  localhost HTTP (Fastify) + WebSocket events
        ▼
DevFlow Core Daemon (Node.js + TypeScript, system of record)
        │
        ├─ Workflow engine (STEP/GATE/SPLITTER/DELEGATE/TERMINAL)
        ├─ Event store (SQLite, append-only) → timeline/replay
        ├─ Application services (discovery/spec/planning/orchestration/verification…)
        ├─ Action Gateway + Policy presets + Approvals
        └─ Plugins: model providers · agent runtimes · tools · capacity adapters
```

The UI never owns execution state; reloads reconnect and rebuild from the daemon.
The daemon binds to `127.0.0.1` by default (`DEVFLOW_HTTP_HOST` to override).

## 2. Deterministic core vs AI

| Engine owns (code) | AI assists with |
|---|---|
| state-machine transitions | ambiguity analysis |
| completion predicates | discovery questions |
| evidence freshness | spec/architecture drafting |
| retry bounds & escalation thresholds | implementation proposals |
| permission policy & approvals | review findings |
| liveness classification | recommendations |

Model outputs are schema-validated (zod). Invalid output triggers bounded repair
(JSON extraction pass), then deterministic fallback — corrupted state is never written.

## 3. Delivery workflow (persisted & resumable)

```
Discovery STEP → Readiness GATE → Risk SPLITTER
   ├─ HIGH → Research STEP → Architecture STEP → Approval GATE
   └─ default ↓
Planning STEP → Task Execution DELEGATE → Verification GATE
→ Two-Stage Review STEP (spec compliance THEN code quality; security added for HIGH)
→ Completion GATE → TERMINAL
```

Gate predicates are registered at composition time and read project state;
the engine persists `WorkflowInstance` (current node, completed nodes, split choice)
so restart resumes from the last valid stage.

## 4. Execution pipeline

`AgentOrchestrator` runs the goal-directed loop:
compile context packet → runtime.nextAction → proposal → Action Gateway → observation.

- WRITE_FILE / RUN_COMMAND proposals carry risk classification
  (`classifyShellCommand`: destructive→DANGEROUS, safe-read→READ_ONLY, else ELEVATED).
- A parked action returns the run as `WAITING_APPROVAL`; resolving the approval in the
  ApprovalService resumes the run via callback. Rejections unblock the run with an explicit observation.
- Provider-plane failures use exponential backoff (distinct `provider.degraded` events);
  implementation failures are bounded by `maxRunAttempts`, then escalate into a Decision.

## 5. Verification & completion

Evidence rows bind `{type, revision, status, freshness}`. `EvidenceFreshnessService`
invalidates non-manual evidence when HEAD moves. `CompletionService.evaluate(task)` computes
Proof of Done: blockers ∅ ∧ required evidence fresh+passing ∧ AC coverage ∧ reviews passed.
The same predicate powers API and UI ("Cannot complete TASK-003: integration test STALE").

## 6. Governance surfaces

- **Decision Inbox** — implementation ambiguities / escalations block tasks; answers become
  canonical requirements and resume work automatically.
- **Approval Inbox** — dangerous/elevated actions park here; ALLOW_ONCE executes exactly once.
- **Conflict Center** — keyword-rule contradiction detection between proposals and accepted ADRs
  (extensible seam for semantic detection); conflicts are first-class and resolvable, never silent.

## 7. Code intelligence (Phase J)

`SymbolIntelligenceService` indexes TS/JS symbols via the TypeScript compiler API
(falls back to text heuristics elsewhere); `SafeEditService` leases file reads by content hash
and rejects stale patches; `DriftDetectionService` compares touched files against approved scope.

## 8. Capacity intelligence (Phase K)

`ProviderCapacityService` refreshes per-provider snapshots through pluggable adapters;
unexposed fields stay `null` with source/confidence recorded (never fabricated).
`CapacityAwareRouter` recommends runtime assignment by remaining capacity/health.
`PlaybookLearningService` gates reusable patterns: OBSERVED→REUSED(×2 verified)→VERIFIED→PROMOTED.

## 9. Mobile companion (Phase L)

Daemon-side control plane: single-use hashed pairing tokens (10-min TTL), device roles
VIEWER/OPERATOR/ADMIN enforced server-side (dangerous approvals require ADMIN),
messages converted into structured decisions/approvals/commands — all through the same
gateway/workflow. Web surface served at `/m`; React Native client is a future adapter
over identical endpoints.

## 10. Persistence

Single SQLite database (`node:sqlite`, WAL). `events` table is append-only with per-project
sequence; aggregates live in a typed document store validated at hydration. The repository
façade is the seam for a future PostgreSQL adapter (cloud/team mode).

## 11. Security posture (spec §29)

Path confinement on every tool target · destructive-command deny list enforced even after approval ·
command timeout + output caps · secrets redacted from action metadata · daemon input schema-validated ·
UI cannot reach fs/shell/git except via governed endpoints · pairing tokens stored only as hashes ·
CSP-restricted Tauri shell · no chain-of-thought exposure anywhere in traces.
