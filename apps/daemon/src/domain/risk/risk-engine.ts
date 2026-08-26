import type { RiskTier } from "@devflow/contracts";
import type { CodebaseSnapshot } from "@devflow/contracts";

export interface RiskSignals {
  touchesAuth: boolean;
  touchesPayments: boolean;
  destructiveDataOperation: boolean;
  externalSideEffects: boolean;
  databaseChange: boolean;
  affectedModuleCount: number;
  reversible: boolean;
  productionExposure: boolean;
  securitySensitive: boolean;
}

/**
 * Risk Engine (spec §17). Deterministic scoring — no AI in the decision path.
 * The output tier drives process depth: discovery depth, reviewers, approvals, evidence.
 */
export function assessRisk(signals: RiskSignals): { tier: RiskTier; reasons: string[] } {
  let score = 0;
  const reasons: string[] = [];
  if (signals.touchesAuth) {
    // Spec §2.8 lists authentication under HIGH-tier work.
    score += 4;
    reasons.push("touches authentication surface");
  }
  if (signals.touchesPayments) {
    score += 4;
    reasons.push("touches payments surface");
  }
  if (signals.destructiveDataOperation) {
    score += 3;
    reasons.push("destructive data operation");
  }
  if (signals.securitySensitive) {
    // Stacks with auth/payments: those surfaces are inherently security-sensitive.
    score += 2;
    reasons.push("security-sensitive area");
  }
  if (signals.databaseChange) {
    score += 1;
    reasons.push("database schema change");
  }
  if (signals.externalSideEffects) {
    score += 2;
    reasons.push("irreversible external side effects");
  }
  if (!signals.reversible) {
    score += 2;
    reasons.push("operation is not reversible");
  }
  if (signals.productionExposure) {
    score += 1;
    reasons.push("production exposure");
  }
  if (signals.affectedModuleCount >= 5) {
    score += 2;
    reasons.push(`wide blast radius (${signals.affectedModuleCount} modules)`);
  } else if (signals.affectedModuleCount >= 3) {
    score += 1;
    reasons.push(`moderate blast radius (${signals.affectedModuleCount} modules)`);
  }

  const tier: RiskTier = score >= 6 ? "HIGH" : score >= 3 ? "NORMAL" : "LOW";
  if (reasons.length === 0) reasons.push("localized change with low blast radius");
  return { tier, reasons };
}

/** Keyword-driven classification of a mission into risk signals — deterministic heuristic,
 * refined later by repository intelligence. */
export function signalsFromMission(mission: string, repo?: CodebaseSnapshot | null): RiskSignals {
  const text = mission.toLowerCase();
  const touchesAuth = /auth|login|로그인|oauth|session|permission|권한/.test(text);
  const touchesPayments = /payment|결제|billing|charge|subscription/.test(text);
  const destructive = /delete all|drop table|migration|migrate|destroy|wipe|삭제.*전체/.test(text);
  const external = /deploy|webhook|email|sms|slack|api key|외부/.test(text);
  const database = /schema|migration|migrate|table|column|index|db/.test(text);
  const security = /secret|token|password|credential|encrypt|보안/.test(text);
  return {
    touchesAuth,
    touchesPayments,
    destructiveDataOperation: destructive,
    externalSideEffects: external,
    databaseChange: database,
    affectedModuleCount: estimateModuleCount(text, repo),
    reversible: !destructive && !external,
    productionExposure: /production|deploy|release/.test(text),
    securitySensitive: security || touchesAuth || touchesPayments,
  };
}

function estimateModuleCount(text: string, repo?: CodebaseSnapshot | null): number {
  let count = 1;
  for (const marker of ["frontend", "ui", "backend", "api", "database", "infra", "mobile", "worker"]) {
    if (text.includes(marker)) count++;
  }
  if (repo && repo.languages.length >= 3) count++;
  return count;
}
