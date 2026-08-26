/** Typed error hierarchy (spec §12.4). Every error carries subsystem/action context.
 * Swallowing is forbidden: catch sites either rethrow enriched or explicitly decide
 * graceful degradation by converting into a recorded failure result.
 */
export type DevFlowErrorKind =
  | "USER_INPUT"
  | "TRANSIENT_PROVIDER"
  | "TOOL_EXECUTION"
  | "PERMISSION"
  | "POLICY"
  | "VALIDATION"
  | "INFRASTRUCTURE"
  | "INTERNAL_INVARIANT";

export class DevFlowError extends Error {
  readonly kind: DevFlowErrorKind;
  readonly subsystem: string;
  readonly action: string;
  readonly entityRef: string | null;
  override readonly cause?: unknown;

  constructor(params: {
    kind: DevFlowErrorKind;
    subsystem: string;
    action: string;
    message: string;
    entityRef?: string | null;
    cause?: unknown;
  }) {
    super(`[${params.subsystem}/${params.action}] ${params.message}`);
    this.name = "DevFlowError";
    this.kind = params.kind;
    this.subsystem = params.subsystem;
    this.action = params.action;
    this.entityRef = params.entityRef ?? null;
    this.cause = params.cause;
  }

  /** Transient failures are retryable; everything else needs a different strategy. */
  get retryable(): boolean {
    return this.kind === "TRANSIENT_PROVIDER";
  }
}
