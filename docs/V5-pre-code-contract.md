# Pre-Implementation Contract (V5 챕터)

> 헌법: "No implementation begins until the system has a sufficient Product
> Contract and Implementation Contract."
> 파생 원칙: A missing failure state is a missing requirement · A screen is not
> specified until its non-happy states are specified · An API is not specified
> until errors/auth/idempotency/timeout/version behavior are specified · A
> workflow is not specified until failure and recovery paths are specified.

## 1. Discovery 2단계 구조

- **Phase A — Product Discovery** (기존 Discovery Interview): problem/user/goal/scope/success.
- **Phase B — Implementation Contract Discovery**: 18 설계 축을 AI가 repo/문서에서 먼저 채우고, 고영향 격차만 질문.

| Phase | 상태 |
|---|---|
| A | ✅ 기존 DiscoveryService(질문 1개씩, coverage) |
| B | ✅ PreCodeContractService — 12 섹션 자동 컴파일 + 질문 랭킹 (18축 중 6축은 V3 문서로 커버: batch/I-F/observability 등) |

## 2. 18 설계 축 → 계약 섹션 매핑 (구현 기준)

| 축 | 상태 | 위치 |
|---|---|---|
| product/workflow/data/state/ux/architecture/api/permissions/auth/failures/concurrency/verification | ✅ 자동 컴파일 | pre-code-contract-service (CLEAR/MISSING + source + confidence + blocking) |
| I/F contract matrix | 🟡 | V3 §11 + 어댑터 --help 실측 기록 |
| batch/scheduler spec | 🟡 | watchdog/capacity refresh 존재, job 프레임워크 명세 미완 |
| observability metrics | 🟡 | logs+events 풍부, metrics ❌ |
| reliability matrix(16 failures) | ✅ taxonomy / 🟡 recovery policy per type |

## 3. Question Priority 공식

```
priority = uncertainty × impact × irreversibility × reworkCost × failureRisk
```

- uncertainty: MISSING=1.0, PARTIAL=0.6
- impact: blocking=1.0 else 0.6
- irreversibility/reworkCost: 섹션별 가중치(permissions·dataModel ×3, authExpiry·apiVersioning ×2.5, failureRecovery·stateDesign·concurrency ×2 …)
- 결과는 openQuestions 내림차순 정렬 — 상위 질문부터 답하면 최소 질문으로 최대 리스크 제거. ✅ 단위 테스트 있음.

## 4. Implementation Readiness Gate (DoR과 별도)

```
ready ⇔ criticalMissing == 0
criticalMissing = blocking=true && status=MISSING 항목 수
```
- 현재: contract.readiness로 산출 + UI 게이트 카드. ✅
- **planDeliveryTasks 강제 연결**: ✅ — `DEVFLOW_REQUIRE_IMPL_CONTRACT=1`로 활성화(기본 off). 미준비 시 최상위 질문과 함께 409 에러.

## 5. PRE_IMPLEMENTATION_CONTRACT artifact

- GET /api/projects/:id/contract — sections/items/status/source/confidence/blocking + readiness + openQuestions. ✅
- **Markdown export**: GET /api/projects/:id/contract/export → PRE_IMPLEMENTATION_CONTRACT.md attachment. ✅

## 6. 검증

- 단위: workspace-conversation-contract.spec.ts "V5/S11" — repo facts 반영, RBAC MISSING+blocking, 질문 우선순위 정렬, criticalMissing>0 ⇒ ready=false.
- 라이브: verify-workspace-e2e.sh — contract compiled/readiness/questions 확인.
