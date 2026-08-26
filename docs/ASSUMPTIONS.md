# Implementation Assumptions & Decisions

Environment-driven choices made under spec §39 (autonomous build rules). Each keeps the
product demonstrable while leaving a production-grade seam.

| # | Decision | Why | Production path |
|---|---|---|---|
| 1 | `node:sqlite` (built-in) instead of better-sqlite3/drizzle | zero native deps, WAL support, Node ≥22 guaranteed | repository façade is the PostgreSQL seam |
| 2 | Tauri v2 shell compiles (`cargo check` ✅); primary run mode is Vite+daemon | full `tauri build` bundling adds minutes without changing behavior | `pnpm tauri dev/build` inside apps/desktop |
| 3 | Mock model provider is default | spec §28 requires no-paid-API demo | OpenAI-compatible + Anthropic adapters activate via env keys |
| 4 | CLI runtimes (Codex/Claude Code) modeled as adapter seam; step-based `AgentRuntimeAdapter` contract | native hooks vary per vendor; contract keeps core neutral | implement `start/nextAction/stop` per vendor protocol |
| 5 | Mobile companion shipped as daemon control-plane + web surface at `/m` | spec §14.11: mobile must not delay desktop V1 | React Native/Expo client over identical `/api/m/*` endpoints |
| 6 | Readiness threshold default 0.70 (env-overridable) | spec §4 Step 5 says "configurable, e.g. 90%"; 0.70 keeps deterministic demo convergent while critical/high-risk gates stay absolute | raise `DEVFLOW_READINESS_THRESHOLD=0.9` in strict ops |
| 7 | Conflict detection uses deterministic keyword rules | honest V1 scope; semantic detection is an adapter behind same interface | swap in LLM-based checker |
| 8 | Symbol intelligence = TypeScript compiler API, text-heuristic fallback | capability-enhancing, never a blocker (spec §14.12) | add LSP servers per language |
| 9 | Approval executor registry is daemon-local | fail-closed: unresolved approvals expire at boot rather than execute after restart | persist lease + idempotency key for multi-process mode |
| 10 | Demo-seeded approval expires at boot by design | demonstrates fail-closed expiry honestly; Scenario C is triggered live instead | — |
