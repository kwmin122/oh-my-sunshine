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
| 1 | 업무 흐름 정의(성공/실패/복구 경로) | 🟡 | Agent 실행 체인 READY→…→DONE 구현. rate-limit/cancel/stale 경로 일부. user-cancel 미구현 |
| 2 | 데이터 정의(필드사양/소유권/삭제정책) | 📋 | cascade/soft-delete 정책 미정의 |
| 3 | 상태 정의(전이표) | ✅ | state-machines.ts + 전이 테스트. Provider 상태머신은 추가 필요 |
| 4 | 상태↔화면 연결 | 🟡 | TaskBoard가 status/blockers/completion을 그대로 렌더 |
| 5 | 정보 구조(IA) | 🟡 | 12탭 존재, Settings 섹션 분리 미완 |
| 6 | 화면별 Primary Goal | 📋 | 문서화 필요 |
| 7 | 상태별 화면(Loading/Empty/Error…) | 🟡 | Empty·Busy 존재, Partial/Offline/Stale 미분화 |
| 8 | 계층 구조(UI/API/App/Domain/Infra) | ✅ | crates·디렉토리 분리, 게이트웨이/정책/이벤트 분리 |
| 9 | API 명세(errors/auth/idempotency) | 🟡 | Zod 입력 검증+409/400 코드. idempotency key 없음 |
| 10 | API Versioning | 📋 | /api 무버전. v1 도입 필요(모바일 대비) |
| 11 | I/F 명세(CLI/Git/Mobile) | 🟡 | RuntimeStartInput·모바일 페어링 계약 존재. 외부 I/F 문서 미완 |
| 12 | 배치/Scheduler | 🟡 | watchdog sweep 존재. usage refresh 등 job 프레임워크 없음 |
| 13 | 중복 실행 방지 | ✅ | task 상태 가드(RUNNING 재시작 차단)+attempt cap. lease TTL은 미흡 |
| 14 | Concurrency Control | 🟡 | Safe Edit lease·path guard 존재. symbol lease/merge 감지 부분 |
| 15 | 사용자/권한(Resource:Action) | 🟡 | 모바일 ROLE_PERMISSIONS. 데스크톱 단일 유저 가정 |
| 16 | Secret 관리 | 🟡 | redactSecrets로 이벤트 마스킹+CLI 자격 위임 원칙. Keychain 저장 미구현 |
| 17 | 인증 만료 처리 | 🟡 | provider backoff/degraded 경로. AUTH_EXPIRED 별도 taxonomy 없음 |
| 18 | Provider Adapter(capabilities/version/health) | ✅ | RuntimeCapabilities·health probe·catalog availability |
| 19 | 데이터 오류 분류 | 📋 | DATA_INTEGRITY_ERROR 체계 미구현 |
| 20 | Rate Limit(429/backoff/quota) | 🟡 | exponential backoff+jitter 유사 구현, quota≠retry 구분 미흡 |
| 21 | 실행 실패 taxonomy | 🟡 | failureReason 문자열 존재. 14유형 enum 전환 필요 |
| 22 | Retry Policy(유형별) | 🟡 | bounded attempts+provider backoff. 유형별 정책표 미적용 |
| 23 | Timeout | ✅ | commandTimeoutMs·stall watchdog·run step bound |
| 24 | Circuit Breaker | 📋 | 미구현 — fallback으로 부분 완화 |
| 25 | Graceful Shutdown | 📋 | SIGTERM 시 checkpoint/lease release 미구현 |
| 26 | Crash Recovery(orphaned run) | 📋 | 미구현 — 시작 시 RUNNING 스캔 필요 |
| 27 | Offline 동작 | 🟡 | MOCK 프로바이더 로컬 동작. UI offline 배너 없음 |
| 28 | Observability(logs/metrics/traces/events) | 🟡 | logs+events ✅, metrics/traces ❌ |
| 29 | Audit Log(actor 구분) | ✅ | EventStore actorType USER/ENGINE/USER(mobile) 구분 기록 |
| 30 | Notification Policy(4단계) | 🟡 | severity INFO~CRITICAL 필드 존재. push 필터링 규칙 미적용 |
| 31 | Idempotency Key | 📋 | deploy/migration 액션 미구현 단계 |
| 32 | Rollback(HIGH risk) | 📋 | checkpoint 개념 존재, forward/rollback 전략 미구현 |
| 33 | Feature Flag | 📋 | 플래그 체계 없음 |
| 34 | DB Migration Strategy | 🟡 | sqlite WAL. schema_version 테이블 없음 |
| 35 | Compatibility Matrix | ✅ | Team Composer catalog=런타임×모델×capability 행렬 |
| 36 | Capability Negotiation | 🟡 | catalog 정적 선언. 실행 시 handshake probing 예정(§32 후속) |
| 37 | Resource Limits(max agents) | 📋 | 동시 실행 상한 없음 |
| 38 | Backpressure(Queue→Scheduler) | 🟡 | dependency DAG로 큐잉. 동시성 상한 스케줄러 없음 |
| 39 | Cancellation | 📋 | pause/resume 모바일 커맨드 존재, cancel 파이프라인 없음 |
| 40 | Pause/Resume(checkpoint 보존) | 🟡 | WAITING_* 상태+resumeRun 존재. 명시적 PAUSED 상태 없음 |
| 41 | Partial Success(PARTIAL 집계) | 🟡 | 태스크 단위 DONE/BLOCKED 독립. 프로젝트 PARTIAL 없음 |
| 42 | Dependency Failure(BLOCKED_BY) | ✅ | dependencyTaskIds + blockers 전파 |
| 43 | Human SLA(대기시간 표시) | 📋 | waitingReason 존재, SLA 계측 UI 없음 |
| 44 | Data Retention | 📋 | 무한 저장. 정책 미정의 |
| 45 | Backup/Export | ✅ | canon export(.devflow/) 존재. DB snapshot 통합 export는 미흡 |
| 46 | Privacy(전송 범위 표시) | 🟡 | context packet 최소화 원칙+섹션 나열 이벤트. 사용자 노출 UI 없음 |
| 47 | Prompt Injection(repo=untrusted) | 🟡 | 컴파일된 컨텍스트 분리 원칙. injection 필터 미구현 |
| 48 | User Override Policy(기록/고위험 제한) | 🟡 | Approval REJECTED 경로. skip=override 기록은 부분 |
| 49 | Change Management(요구변경 전파) | 🟡 | evidence stale 전파 존재. requirement 변경→task stale 재계획 미완 |
| 50 | Configuration Hierarchy | ✅ | System→Org→Project→Role→Task→Run 해석기(Team Composer) |

## 요약
- ✅ 12 · 🟡 24 · 📋 14
- 다음 스프린트 우선순위: (a) CLI 런타임 어댑터 실행(claude -p / codex exec --json) (b) 데몬 사이드카 번들링 (c) cancel/graceful shutdown (d) 실패 taxonomy enum화 (e) /api/v1 버전닝
