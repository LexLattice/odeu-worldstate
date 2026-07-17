export type KernelErrorCode =
  | "schema_invalid"
  | "event_id_conflict"
  | "command_id_conflict"
  | "revision_conflict"
  | "revision_record_invalid"
  | "identity_conflict"
  | "authority_violation"
  | "scope_violation"
  | "reference_missing"
  | "record_retired"
  | "disposition_conflict"
  | "lifecycle_conflict"
  | "evidence_gate_blocked"
  | "artifact_drift";

export class KernelError extends Error {
  readonly code: KernelErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: KernelErrorCode,
    message: string,
    details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "KernelError";
    this.code = code;
    this.details = details;
  }
}

export function invariant(
  condition: unknown,
  code: KernelErrorCode,
  message: string,
  details?: Readonly<Record<string, unknown>>,
): asserts condition {
  if (!condition) {
    throw new KernelError(code, message, details);
  }
}
