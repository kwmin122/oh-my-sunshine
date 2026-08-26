# DevFlow OS — AI Engineering Control Plane

> A visual operating system for running an AI software-development organization.
> If ordinary AI coding tools are individual developers, DevFlow OS is the software company,
> engineering process, control plane, audit system, and mission-control dashboard around them.

DevFlow OS turns an ambiguous request like *"Add Google login"* into a structured,
enterprise-grade development process: intent classification → repository intelligence →
one-question-at-a-time discovery → canonical spec → review council → architecture →
dependency-aware task DAG → governed agent execution → revision-bound evidence →
two-stage review → computed Proof of Done.

## Core invariants

1. **The AI's opinion that something happened is not the same thing as evidence that it happened.**
   Completion is a deterministic predicate over fresh, revision-bound evidence — never an agent claim.
2. **The AI may recommend a lifecycle transition; the engine decides whether it is legal.**
   All state machines live in `packages/contracts`; the workflow engine owns every transition.
3. **The desktop UI is a projection/control surface; the local daemon is the execution system of record.**

## Quick start

```bash
pnpm install

# terminal 1 — daemon (mock provider by default; no API keys needed)
pnpm dev:daemon                       # http://127.0.0.1:47710

# terminal 2 — desktop UI
pnpm dev:desktop                      # http://localhost:5288

# optional — seed the demo project (scenarios A–H from the spec)
pnpm demo:seed && pnpm dev:daemon     # with DEVFLOW_DATA_DIR=.devflow-data
```

Open http://localhost:5288 → create a project → submit a vague mission
("Add Google login") → answer one question at a time → **Plan Delivery →** →
execute tasks → resolve decisions/approvals → watch evidence and Proof of Done.

### Real model providers (optional)

```bash
DEVFLOW_PROVIDER=OPENAI_COMPATIBLE OPENAI_API_KEY=sk-… OPENAI_BASE_URL=https://api.openai.com/v1 pnpm dev:daemon
DEVFLOW_PROVIDER=ANTHROPIC ANTHROPIC_API_KEY=sk-ant-… pnpm dev:daemon
```

Without keys the deterministic mock provider drives everything — fully demonstrable offline.

### Mobile companion

Start the daemon and open `http://<your-lan-ip>:47710/m` on a phone.
Pair (single-use 10-minute token), pick a role (VIEWER/OPERATOR/ADMIN),
chat with the Engineering Lead, answer decisions, act on approvals, pause/resume tasks.
Every mobile command passes through the same Action Gateway and workflow governance.

## Monorepo layout

```
apps/
  desktop/            React 19 + Vite + Tailwind v4 + React Flow UI (+ Tauri v2 shell in src-tauri/)
  daemon/             Node.js + TypeScript long-lived local orchestration daemon
    src/api/          Fastify REST + WebSocket surface (thin routes only)
    src/domain/       workflow engine · risk engine · policy presets
    src/application/  discovery · specification · planning · reviews · orchestration ·
                      verification · gateway · governance · context compiler · intent gate · safe edit
    src/services/     readiness probes · checkpoints · canon export/import · conflicts ·
                      memory promotion · capacity & routing · playbooks · drift · symbols · mobile
    src/plugins/      model providers (mock/OpenAI-compatible/Anthropic) · runtimes · tools
    src/infrastructure/ SQLite (node:sqlite, WAL) · event store · document repositories · scanner
packages/
  contracts/          domain types · state machines · event catalog · zod schemas · plugin interfaces
demo/                 seeded demo artifacts
```

## Architecture at a glance

- **Deterministic core** — task/workflow/evidence state machines, completion predicates,
  permission policy, liveness, retry bounds are plain code (spec §2.9).
- **Event-sourced** — every state change appends to an append-only SQLite event stream;
  timeline/replay derives exclusively from events (spec §7).
- **Action Gateway** — every tool action (READ_ONLY/WORKSPACE_WRITE/ELEVATED/DANGEROUS)
  flows validate → policy → approval-gate → sandboxed execute → record. No bypass path.
  Dangerous actions always require human approval; fail-closed when unresolved.
- **Evidence freshness** — evidence binds to the git revision it was produced against;
  any code movement marks affected evidence STALE and blocks completion until rerun.
- **Safe Edit Guard** — writes are lease-checked against file content hashes; stale patches
  are rejected for re-planning instead of clobbering newer work.
- **Drift detection** — changed files outside the approved task scope raise first-class findings.
- **Capacity honesty** — provider quotas show only what adapters actually expose; unknowns stay unknown.

## Verification

```bash
pnpm typecheck        # tsc across contracts + daemon + desktop
pnpm test             # vitest suites (unit + integration, 63 scenarios)
pnpm build            # typecheck + vite production build
```

Key scenario coverage includes: stale-evidence blocking (B), approval gating (C),
escalation after repeated failure (D), stale multi-agent edit rejection (E),
quota-aware routing (F), mobile decision→structured state (G), goal-drift detection (H).

See `docs/ARCHITECTURE.md` for subsystem details and `docs/ASSUMPTIONS.md` for
environment-driven implementation decisions.
