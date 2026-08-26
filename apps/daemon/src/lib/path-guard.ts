import { isAbsolute, join, normalize, resolve, sep } from "node:path";

/** Filesystem path confinement (spec §29): every path a tool touches must resolve
 * inside an authorized workspace root. Prevents traversal outside sandboxes. */
export function assertPathInsideWorkspace(root: string, candidate: string): string {
  if (!isAbsolute(candidate)) {
    candidate = join(root, candidate);
  }
  const resolvedRoot = resolve(root);
  const resolved = normalize(resolve(candidate));
  // The workspace root itself is a valid target (e.g. shell cwd).
  if (resolved === resolvedRoot) return resolved;
  const confined = resolved.startsWith(resolvedRoot + sep);
  if (!confined) {
    throw new Error(
      `[path-guard] path '${candidate}' escapes workspace root '${root}' — blocked`,
    );
  }
  return resolved;
}

export function isPathInsideWorkspace(root: string, candidate: string): boolean {
  try {
    assertPathInsideWorkspace(root, candidate);
    return true;
  } catch {
    return false;
  }
}

/** Shell command risk classification (spec §14 Step 14). Deterministic allow/deny lists. */
const DESTRUCTIVE_PATTERNS: RegExp[] = [
  /\brm\s+-rf?\s+[~/]/,
  /\bsudo\b/,
  /\bgit\s+push\s+.*--force/,
  /\bgit\s+reset\s+--hard\b/,
  /:\(\)\s*\{.*\};:/, // fork bomb
  />\s*\/dev\/sd/,
  /\b(mkfs|dd)\b/,
  /\b(shutdown|reboot)\b/,
];

const ELEVATED_PATTERNS: RegExp[] = [
  /\bnpm\s+(install|i|ci)\b/,
  /\bpnpm\s+(add|install|i)\b/,
  /\byarn\s+add\b/,
  /\bcargo\s+(install|build)\b/,
  /\bdocker\b/,
  /\bmigrate\b/,
  /\bprisma\s+migrate\b/,
];

export type ShellRiskClassification = {
  allowed: boolean;
  reason: string;
};

/** Read-only commands are safe to auto-allow; anything else is at least ELEVATED. */
const SAFE_READ_PATTERN = /^\s*(ls|pwd|cat|head|tail|grep|rg|find|which|whoami|node\s+--version|npm\s+test|--version)\b/;

export function classifyShellCommand(command: string): { destructive: boolean; elevated: boolean; readOnly: boolean } {
  const destructive = DESTRUCTIVE_PATTERNS.some((p) => p.test(command));
  if (destructive) return { destructive, elevated: false, readOnly: false };
  const readOnly = SAFE_READ_PATTERN.test(command);
  const elevated = !readOnly && (ELEVATED_PATTERNS.some((p) => p.test(command)) || !SAFE_READ_PATTERN.test(command));
  return { destructive, elevated, readOnly };
}
