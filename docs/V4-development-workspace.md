# Development Workspace + Continuous Human/AI Loop (V4 챕터)

> 원칙: oh-my-sunshine은 AI agent dashboard가 아니다. 최종 목적은 사람이 AI 개발팀과 함께
> 실제 파일과 실행 결과를 보며 계속 대화하고 방향을 수정하면서 좋은 제품을 완성하는 것.
> 상태 표기: ✅ 구현+검증 · 🟡 부분 · 📋 명세만 — 거짓 없이.

## 1. Development Workspace (핵심 개발 surface)

```
┌───────────┬──────────────────────┬─────────────────┐
│ FILES     │ VIEWER / DIFF        │ ENGINEERING LEAD │
│ explorer  │ code + unified diff  │ conversation     │
├───────────┴──────────────────────┴─────────────────┤
│ TERMINAL ($ real shell in project workspace)        │
└─────────────────────────────────────────────────────┘
```

- 탐색: `DevelopmentWorkspace` 탭 (desktop). ✅
- Renderer는 filesystem에 직접 접근하지 않는다 — Desktop → daemon API → path-guard → fs/git adapter. ✅ (traversal 차단 테스트)

## 2. File Explorer / Viewer / Diff

| 항목 | 상태 | 근거 |
|---|---|---|
| directory tree (lazy expand) | ✅ | GET /api/projects/:id/files?path= |
| file search (이름) | ✅ | /files/search?q= |
| **content grep** | ✅ | /files/search?mode=content&q= — 바이트 예산 캡, binary 스킵. UI에서 `?query` 접두사 |
| read-only viewer + line numbers + size cap(512KB) | ✅ | /file?path= (truncated 플래그) |
| working-tree diff (unified) | ✅ | /git/diff?base= |
| git status 배지 (변경 파일 amber) | ✅ | /git/status |
| file history (git log --follow) | ✅ | /git/log?path= |
| **changed-by 어느 agent 연결** | ✅ | /file/provenance?path= → gateway action 감사에서 runId/taskId/시각 역추적, 뷰어에 표시 |
| direct editing (Safe Edit Guard 연계) | 📋 | 아키텍처 준비(path-guard/lease), UI 편집기 미구현 |

## 3. Integrated Terminal

| 항목 | 상태 | 근거 |
|---|---|---|
| 실제 프로세스 세션 (`$SHELL`, process group) | ✅ | TerminalService.create — echo 라운드트립 검증(scripts/verify-workspace-e2e.sh) |
| TerminalSession entity + 상태머신 | ✅ | contracts TERMINAL_STATES/TERMINAL_TRANSITIONS + 불법 전이 거부 테스트 |
| 출력 스트리밍 (WS broadcast + ring buffer 폴링) | ✅ | terminal.output 메시지, outputSince(afterSeq) |
| kill → CANCELLED + 고아 없음 | ✅ | process-group SIGTERM→SIGKILL, pid 생존 검증 테스트 |
| 세션 타입 USER/AGENT/TEST/BUILD 구분 | ✅ entity + UI 타입 선택(USER/TEST/BUILD) |
| 완전 TTY 인터랙션 | ✅(조건부) | node-pty 존재 시 USER 세션은 실제 PTY(resize 지원). 포크 불가 환경에서는 probe 후 piped fallback — 런타임 탐지, 추측 없음 |

### Terminal 보안 포지션 (정직한 구분)
- **USER 터미널**: 사용자 자신의 쉘. Action Gateway를 우회하는 것이 아니라 **원래 사용자 권한의 작업**이므로 gateway-free by design. 생성/종료는 actorType USER로 감사 기록. ✅
- **AGENT 실행**: 여전히 Action Gateway 경유. ✅
- shutdown 시 모든 세션 kill. ✅

## 4. Continuous Engineering Lead Conversation

| 항목 | 상태 | 근거 |
|---|---|---|
| 프로젝트 lifetime 대화 영속화 | ✅ | conversation_message doc kind, GET/POST /conversation |
| 의도 분류 (14 intents, EN/KR) | ✅ | classifyMessage 결정론적 휴리스틱 — LLM tier는 보조 |
| TASK_REFINEMENT → 활성 task operator notes 주입 | ✅ | 다음 실행 brief에 "LATEST OPERATOR NOTES" 섹션으로 컴파일됨(ContextCompiler 확장) |
| REQUIREMENT_CHANGE → impact loop | ✅ | 미완료 task BLOCKED(replan required) + PASS_FRESH evidence → PASS_STALE + requirement.change_detected 이벤트 |
| RUNTIME_CHANGE/PAUSE/CANCEL 등 structured command | ✅ | RUNTIME_CHANGE는 자연어에서 런타임 추출→활성 task override 자동 적용(runtime.selected 이벤트). PAUSE/CANCEL은 분류 후 기존 명령 경로로 |
| Lead 응답(LLM tier + deterministic fallback) | ✅ | provider 있으면 generate, mock이면 상태 요약 응답 |

## 5. Realtime interface

- WS `/ws`: project events(task.*, agent.run_output, workflow.*) + terminal.output/status + **file.changed(fs watcher, 300ms debounce)** broadcast. ✅

## 6. Screen purpose & state matrix (요약)

| 화면 | 한 문장 목적 | 핵심 states 구현 |
|---|---|---|
| Mission Control | 10초 내 상태 파악 | ready/blocked/error ✅, offline 배너 🟡 |
| **Development Workspace** | AI와 실제 제품을 개발·관찰·수정 | empty(repo无)/ready/running(truncated)/error ✅ |
| Workflow Composer | 흐름 편집·적용 | empty/ready/error(validation) ✅ |
| Tasks | 일의 단위·순서 관리 | running/stop/cancel 결과 ✅ |
| Implementation Contract | 코딩 전 계약 격차 가시화 | missing/ready ✅ |
| Team Composer | 누가 무엇으로 일하는지 | mismatch warning ✅ |
| Evidence/Timeline | 완료 증명 추적 | stale 강조 🟡 |

전체 화면별 11-state 매트릭스 완성은 🟡 (critical states 우선 구현).

## 7. API contract (구현 기준, 요약)

| method path | 비고 |
|---|---|
| GET /api/projects/:id/files?path= | tree, traversal 4xx |
| GET /api/projects/:id/file?path= | 512KB cap, truncated flag |
| GET /api/projects/:id/files/search?q= | 이름 검색, limit 50 |
| GET /api/projects/:id/git/diff?base= / status / log?path= | git surfaces |
| POST /api/projects/:id/terminal {type} | session 생성(cwd=repo) |
| POST /api/terminal/:id/input {data} | stdin write |
| GET /api/terminal/:id/output?afterSeq= | ring buffer 조회 |
| POST /api/terminal/:id/kill | process group kill |
| GET/POST /api/projects/:id/conversation | history / send(classify+effects) |
| GET/POST /api/projects/:id/contract(/refresh) | pre-code contract |

버전닝(/api/v1)과 idempotency key는 📋 (V3 §9/§10 유지).

## 8. Live verification evidence

`scripts/verify-workspace-e2e.sh` — 실제 daemon + 실제 git repo + 실제 쉘:
tree/read/diff/status/log/search/traversal-차단/terminal 라운드트립/REQUIREMENT_CHANGE→task BLOCKED/contract readiness/daemon clean exit = **15/15 PASS** (2026-08-26).
