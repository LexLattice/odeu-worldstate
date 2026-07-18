import {
  ledgerVersion,
  parseWorldstateLedgerDocument,
  worldstateStateFromLedgerDocument,
  type LedgerVersion,
  type WorldstateLedgerDocument,
} from "@/adapters/storage";
import {
  ArtifactPromotionCompilationError,
  resolveAuthorizedArtifactPromotion,
  type AuthorizedArtifactPromotion,
} from "@/integration/artifact-promotion";

export interface ArtifactPromotionLedgerAuthority {
  readonly document: WorldstateLedgerDocument;
  readonly version: LedgerVersion;
  readonly authorized: AuthorizedArtifactPromotion;
  readonly authorizedEventId: string;
  readonly authorizedAt: string;
}

/**
 * Reconstructs the exact immutable ledger prefix ending at human promotion
 * authorization. Later outcome events or later semantic revisions are not
 * allowed to rewrite what the operator originally authorized.
 */
export function resolveArtifactPromotionLedgerAuthority(
  input: unknown,
  promotionId: string,
): ArtifactPromotionLedgerAuthority {
  const current = parseWorldstateLedgerDocument(input);
  const state = worldstateStateFromLedgerDocument(current);
  const projection = state.operational.artifactPromotions[promotionId];
  const authorizedEventId = projection?.authorizedEventId;
  if (!projection || !authorizedEventId) {
    // Preserve the integration boundary's stable public failure semantics.
    resolveAuthorizedArtifactPromotion(state, promotionId);
    throw new Error("Artifact promotion authorization is missing.");
  }
  const authorizationIndex = current.events.findIndex(
    (event) =>
      event.eventId === authorizedEventId &&
      event.type === "artifact.promotion_authorized" &&
      event.payload.promotionId === promotionId,
  );
  if (authorizationIndex < 0) {
    throw new ArtifactPromotionCompilationError([
      "Artifact promotion authorization event is missing.",
    ]);
  }
  const authorizationEvent = current.events[authorizationIndex]!;
  if (authorizationEvent.type !== "artifact.promotion_authorized") {
    throw new ArtifactPromotionCompilationError([
      "Artifact promotion authorization event is malformed.",
    ]);
  }
  const document = parseWorldstateLedgerDocument({
    ...current,
    headRevisionId: projection.proposal.integratedRevisionId,
    updatedAt: authorizationEvent.occurredAt,
    events: current.events.slice(0, authorizationIndex + 1),
  });
  const version = ledgerVersion(document);
  if (!version) {
    throw new ArtifactPromotionCompilationError([
      "Artifact promotion authorization has no ledger version.",
    ]);
  }
  return {
    document,
    version,
    authorized: resolveAuthorizedArtifactPromotion(
      worldstateStateFromLedgerDocument(document),
      promotionId,
    ),
    authorizedEventId,
    authorizedAt: authorizationEvent.occurredAt,
  };
}
