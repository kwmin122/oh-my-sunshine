# Runtime Assignment & Dynamic Routing Architecture (V3 독립 챕터)

> 핵심 원칙: 역할도·런타임도·모델도·플로우도 고정하지 않는다. 사용자 조합이 최우선.
> 시스템 추천과 사용자 선택은 항상 구분 표기(SYSTEM RECOMMENDS vs USER SELECTED).
> 단, 안전/기술적으로 불가능한 조합(예: shell 없는 런타임에 shell 요구 역할)은 차단한다.

## 1. 계층 (아래가 위를 override)

```
Global Default → Project Default → Team Preset → Role Assignment
→ Workflow Node Override → Task Override → Run Override
```

## 2. 조직 빌더 = Workflow Composer × Team Composer

- **Workflow Composer**: 어떤 순서로 일할지(Planner→Coder→Reviewer 등) — 노드=역할, 엣지=의존성
- **Team Composer**: 누가 일할지(Role→Runtime→Provider→Model→Effort→Tools→Permissions→Fallback)
- 둘은 독립 저장되고 자유롭게 조합된다: `Workflow Preset` + `Team Preset`
- 예: "My Fast Build"(Planner→Coder→Reviewer) × "My Best Team"(CEO Opus / Coder 0x / Reviewer Sonnet)
- Orchestrator(Lead)도 하나의 Assignment일 뿐 — 교체 가능. 새 Lead는 Event Log + Canon + Checkpoint를 읽고 이어받는다(durable truth > chat memory).

## 3. Role 정의

- 내장 역할(Planner/Architect/Backend/Frontend/Reviewer/QA/Security/CEO)에 추가로 **User-defined Role** 지원
- Role Template: Name · Responsibility · Instructions · Tools · Required capabilities · Default runtime · Permission level · Required outputs · Review criteria
- Role ↔ Runtime 사이 강제 결합 없음. 같은 역할에 여러 실행자(Coder A=0x, Coder B=Codex) 허용

## 4. Routing Mode (역할별)

| Mode | 의미 | Quota 부족 시 |
|------|------|--------------|
| **LOCKED** | 사용자 지정 절대 고정 | 자동 변경 금지. `team.locked_unavailable` 이벤트 + 실행 실패(fail-closed) 후 [Keep/Switch once/Change policy] 물음 |
| **PREFERRED** | 선호 런타임 + 폴백 허용 | 폴백 체인 따라 자동 강등, 이벤트 기록 |
| **AUTO** | 시스템이 선택 | capacity/cost/risk 스코어링으로 동적 배정 |

## 5. Routing Rule Engine (조건식 폴백)

```
Primary: OpenCode / 0x Alpha
If task.risk == HIGH      → Codex High
If 0x unavailable         → Claude Sonnet
If quota < 10%            → Local model
If failed_attempts >= 3   → Codex High
```

Routing Policy 우선순위: ①사용자 명시 선택 ②필수 capability ③risk/difficulty ④잔여 quota ⑤cost ⑥latency ⑦model diversity

## 6. Handoff Packet (실행 중 모델 교체)

Runtime A → Checkpoint/Handoff Packet → Runtime B. 내용: objective · plan · files changed · diff · tests · failures · decisions · last checkpoint · remaining ACs. Context Compiler와 연결되어 처음부터 재시작하지 않는다.

## 7. 실행 중 변경

- Run 도중 quota 고갈/장애 → PREFERRED/AUTO면 즉시 대체, LOCKED면 정지+질의
- 변경은 모두 Event Store에 actor와 함께 기록(Audit)

## 구현 상태 (거짓 없이)

| 개념 | 상태 | 위치 |
|------|------|------|
| 7계층 해석(org/project/role/task/run) | ✅ | team-composer-service.resolveForTask |
| LOCKED/PREFERRED/AUTO 모드 | ✅(본 커밋) | binding.routingMode + resolve 강제 |
| Workflow Composer(그래프 편집) | 📋 다음 스프린트 | 워크플로우 엔진 위 UI |
| User-defined Role | 📋 다음 스프린트 | role template 저장 |
| 조건식 Routing Rules | 📋 | rule engine |
| Handoff Packet | 🟡 | checkpoint 서비스 존재, 패킷 스키마 미정 |
| Orchestrator 교체 가능 | ✅ | Lead도 role binding으로 배정 |
| CLI 실행 어댑터(claude -p / codex exec) | 🟡 진행중 | discovery 완료, executor 다음 |
