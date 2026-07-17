import { deepFreeze } from "./determinism";
import { LedgerEventSchema, type LedgerEvent, type LedgerEventOf } from "./schema";

/** Validate and freeze an immutable event envelope before dispatch. */
export function createLedgerEvent<TType extends LedgerEvent["type"]>(
  event: LedgerEventOf<TType>,
): LedgerEventOf<TType> {
  return deepFreeze(LedgerEventSchema.parse(event) as LedgerEventOf<TType>);
}

export function sourceCapturedEvent(
  event: Omit<LedgerEventOf<"source.captured">, "type">,
): LedgerEventOf<"source.captured"> {
  return createLedgerEvent({ ...event, type: "source.captured" });
}

export function deltaProposedEvent(
  event: Omit<LedgerEventOf<"delta.proposed">, "type">,
): LedgerEventOf<"delta.proposed"> {
  return createLedgerEvent({ ...event, type: "delta.proposed" });
}

export function deltaDispositionEvent<
  TType extends "delta.deferred" | "delta.rejected" | "delta.remanded" | "delta.superseded",
>(event: Omit<LedgerEventOf<TType>, "type"> & { type: TType }): LedgerEventOf<TType> {
  return createLedgerEvent(event as LedgerEventOf<TType>);
}

export function briefCompiledEvent(
  event: Omit<LedgerEventOf<"brief.compiled">, "type">,
): LedgerEventOf<"brief.compiled"> {
  return createLedgerEvent({ ...event, type: "brief.compiled" });
}

export function runAuthorizedEvent(
  event: Omit<LedgerEventOf<"run.authorized">, "type">,
): LedgerEventOf<"run.authorized"> {
  return createLedgerEvent({ ...event, type: "run.authorized" });
}

export function runLifecycleEvent(
  event: Omit<LedgerEventOf<"run.lifecycle_recorded">, "type">,
): LedgerEventOf<"run.lifecycle_recorded"> {
  return createLedgerEvent({ ...event, type: "run.lifecycle_recorded" });
}

export function closureStagedEvent(
  event: Omit<LedgerEventOf<"closure.staged">, "type">,
): LedgerEventOf<"closure.staged"> {
  return createLedgerEvent({ ...event, type: "closure.staged" });
}

export function evidenceValidationEvent(
  event: Omit<LedgerEventOf<"evidence.validation_recorded">, "type">,
): LedgerEventOf<"evidence.validation_recorded"> {
  return createLedgerEvent({ ...event, type: "evidence.validation_recorded" });
}
