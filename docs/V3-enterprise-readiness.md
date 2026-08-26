# Enterprise Readiness / Reliability Specification (V3 챕터)

> 원칙: 이 문서는 **거짓 상태를 허용하지 않는다.** 각 항목의 상태는 실제 코드 기준.
> ✅ 구현됨(테스트 있음) · 🟡 부분 구현 · 📋 명세만(미구현) — 우회 표기 금지.

## 14개 설계 축 매핑
1 Product/Goal·2 Workflow·3 Requirement → 기존 마스터 명세 §1–13 (✅ 문서화)
4 IA/5 UX States → 🟡 (12탭 IA 존재, 화면별 11-state 미적용)
6 Data Model → 🟡 (엔티티+DocKind 존재, 필드 레벨 사양·보존기간 미정의)
7 State Machines → ✅ contracts/state-machines.ts (transition table + 테스트)
8 API/IF → 🟡 (Zod 검증 공통, 버전닝·rate limit·idempotency 헤더 없음)
9 AI Agent/Runtime → ✅ Role↔Runtime 분리 + Team Composer(§31) + Discovery(§32)
10 Security/Permissions → 🟡 (PresetPolicyEngine fail-closed, RBAC 리소스:액션 미흡)
11 Reliability/Recovery → 🟡 (bounded retry·escalation·fallback 있음, circuit breaker 없음)
12 Observability/Audit → 🟡 (구조화 로그·이벤트 스토어, metrics/trace 없음)
13 Operations → 🟡 (DMG 번들링, 데몬 사이드카 미포함)
14 Testing/Evidence → ✅ Evidence Gate·freshness·completion predicate

## 50개 항목 감사

| # | 항목 | 상태 | 근거 / 남은 작업 |
|---|------|------|------|
| 1 | 업무 흐름 정의(성공/실패/복구 경로) | 🟡 | Agent 실행 체인 READY→…→DONE 구현. run cancel·graceful shutdown drain 완료(테스트 있음). crash recovery 미구현 |
| 2 | 데이터 정의(필드사양/소유권/삭제정책) | 📋 | cascade/soft-delete 정책 미정의 |
| 3 | 상태 정의(전이표) | ✅ | state-machines.ts + 전이 테스트 |
| 4 | 상태↔화면 연결 | 🟡 | TaskBoard가 status/blockers/completion을 그대로 렌더 |
| 5 | 정보 구조(IA) | 🟡 | 탭 존재, Settings 섹션 분리 미완 |
| 6 | 화면별 Primary Goal | 📋 | 문서화 필요 |
| 7 | 상태별 화면(Loading/Empty/Error…) | 🟡 | Empty·Busy 존재, Partial/Offline/Stale 미분화 |
| 8 | 계층 구조(UI/API/App/Domain/Infra) | ✅ | crates·디렉토리 분리, 게이트웨이/정책/이벤트 분리 |
| 9 | API 명세(errors/auth/idempotency) | ✅ | Zod 검증+409/400+Idempotency-Key 리플레이(SQLite 저장, idempotent-replay 헤더) |
| 10 | API Versioning | 🟡 | /api/v1 별칭 시임 확보(현재 v1==현행). 파괴적 변경 시 fork 지점 문서화됨 |
| 11 | I/F 명세(CLI/Git/Mobile) | 🟡 | RuntimeStartInput·모바일 페어링 계약 존재. 외부 I/F 문서 미완 |
| 12 | 배치/Scheduler | 🟡 | watchdog sweep·capacity refresh·fs watcher 존재. job 프레임워크 통합은 미완 |
| 13 | 중복 실행 방지 | ✅ | task 상태 가드+attempt cap+의존성 게이트+idempotency key |
| 14 | Concurrency Control | 🟡 | Safe Edit lease·path guard·maxConcurrentRuns 상한. symbol lease/merge 감지 부분 |
| 15 | 사용자/권한(Resource:Action) | 🟡 | 모바일 ROLE_PERMISSIONS. 데스크톱 단일 유저 가정 |
| 16 | Secret 관리 | 🟡 | redactSecrets+CLI 자격 위임 원칙+env allowlist. Keychain 저장 미구현 |
| 17 | 인증 만료 처리 | ✅ | AUTH_EXPIRED taxonomy+providerFatal 무재시도+circuit breaker OPEN→fallback. 재인증 UI는 📋 |
| 18 | Provider Adapter(capabilities/version/health) | ✅ | RuntimeCapabilities·health probe·auth probe·circuit breaker health overlay |
| 19 | 데이터 오류 분류 | 📋 | DATA_INTEGRITY_ERROR 체계 미구현 |
| 20 | Rate Limit(429/backoff/quota) | ✅ | backoff+jitter+QUOTA_EXHAUSTED 분리+routing quota feed(usedPercentRemaining→quotaBelowPct 규칙 실동작) |
| 21 | 실행 실패 taxonomy | ✅ | contracts.RuntimeFailureKind 14유형 + classifyCliFailure + 스트림 매핑 + 테스트 |
| 22 | Retry Policy(유형별) | ✅ | bounded attempts+backoff+providerFatal(CANCELLED/AUTH/RUNTIME_UNAVAILABLE) 무재시도+breaker 연동 |
| 23 | Timeout | ✅ | commandTimeoutMs·stall watchdog·run step bound·CLI timeout(SIGTERM→SIGKILL) |
| 24 | Circuit Breaker | ✅ | CLOSED→OPEN(threshold)→HALF_OPEN(cooldown)→성공시 CLOSED. composer health predicate로 fallback 자동화. LOCKED 면역 |
| 25 | Graceful Shutdown | ✅ | SIGTERM/SIGINT: 503 가드 → stopAllActive → lease release → terminal kill → watcher 해제 → WAL checkpoint. integrity_check 테스트 |
| 26 | Crash Recovery | ✅ | 시작 시 RUNNING 스캔 → ORPHANED_BY_RESTART + task READY(WAITING_*는 resumable 보존). 실 프로세스 부팅 테스트 |
| 27 | Offline 동작 | 🟡 | MOCK 로컬 동작. UI offline 배너 없음 |
| 28 | Observability(logs/metrics/traces/events) | 🟡 | logs+events(+런타임/터미널/워크스페이스 스트림) ✅, metrics/traces ❌ |
| 29 | Audit Log(actor 구분) | ✅ | EventStore actorType 구분+terminal 세션 감사+USER/ENGINE 구분 |
| 30 | Notification Policy(4단계) | 🟡 | severity 필드 존재. push 필터링 미적용 |
| 31 | Idempotency Key | ✅ | Idempotency-Key 헤더 기반 전 mutating 엔드포인트 리플레이 |
| 32 | Rollback(HIGH risk) | 📋 | checkpoint 개념 존재, forward/rollback 전략 미구현 |
| 33 | Feature Flag | 🟡 | env 플래그 다수(DEVFLOW_REQUIRE_IMPL_CONTRACT 등). 체계화된 flag 시스템 아님 |
| 34 | DB Migration Strategy | 🟡 | sqlite WAL+migrate(). schema_version 테이블 없음 |
| 35 | Compatibility Matrix | ✅ | catalog=런타임×모델×capability 행렬 |
| 36 | Capability Negotiation | ✅ | discovery(version/auth probe)+CLI별 machine-readable 모드 --help 실측+PTY/piped 런타임 탐지 |
| 37 | Resource Limits(max agents) | ✅ | maxConcurrentRuns 상한 게이트(DEVFLOW_MAX_CONCURRENT_RUNS) |
| 38 | Backpressure(Queue→Scheduler) | 🟡 | dependency DAG 큐잉+의존성 게이트+동시성 상한. 우선순위 큐 스케줄러는 미완 |
| 39 | Cancellation | ✅ | cancel 파이프라인 완성(UI Stop 포함), 프로세스 그룹 kill, 고아 검증 |
| 40 | Pause/Resume(checkpoint 보존) | 🟡 | WAITING_*/resumeRun/mobile resumeTask 구현. 명시적 PAUSED 상태 없음 |
| 41 | Partial Success(PARTIAL 집계) | 🟡 | 태스크 단위 독립. 프로젝트 PARTIAL 없음 |
| 42 | Dependency Failure(BLOCKED_BY) | ✅ | dependencyTaskIds+blockers 전파+실행 게이트 강제 |
| 43 | Human SLA(대기시간 표시) | 📋 | waitingReason 존재, SLA 계측 UI 없음 |
| 44 | Data Retention | 📋 | 무한 저장. 정책 미정의 |
| 45 | Backup/Export | ✅ | canon export+contract markdown export(.md attachment) |
| 46 | Privacy(전송 범위 표시) | 🟡 | context packet 최소화 원칙. 사용자 노출 UI 없음 |
| 47 | Prompt Injection(repo=untrusted) | 🟡 | 컴파일된 컨텍스트 분리. injection 필터 미구현 |
| 48 | User Override Policy(기록/고위험 제한) | 🟡 | Approval REJECTED 경로. skip=override 기록 부분 |
| 49 | Change Management(요구변경 전파) | ✅ | REQUIREMENT_CHANGE→영향 task BLOCKED+evidence stale+decision 후속 이벤트(V4 §9 루프) |
| 50 | Configuration Hierarchy | ✅ | 7계층 해석기+routing rules |

## 요약
- ✅ 23 · 🟡 21 · 📋 6
- 📋 6개: §2 데이터 정의(삭제정책) · §6 화면별 Primary Goal 문서 통합 · §19 데이터 오류 분류 · §32 Rollback 전략 · §43 Human SLA UI · §44 Data Retention
- 🟡 중요: metrics/traces(§28) · RBAC 운영 상세(§15) · Keychain(§16) · offline 배너(§27) · push 필터(§30) · schema_version(§34) · 우선순위 큐(§38) · PAUSED(§40) · PARTIAL 집계(§41) · privacy UI(§46) · injection 필터(§47)
