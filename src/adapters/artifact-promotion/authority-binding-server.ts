import "server-only";

import { createHash } from "node:crypto";

import { stableStringify } from "@/domain";

import type { ArtifactPromotionLedgerAuthority } from "./ledger-authority";
import type { ArtifactPromotionAuthorityBinding } from "./server";

/** Host-computed collision-resistant binding for the exact authorization prefix. */
export function artifactPromotionAuthorityBinding(
  authority: ArtifactPromotionLedgerAuthority,
): ArtifactPromotionAuthorityBinding {
  const prefixMaterial = {
    format: authority.document.format,
    formatVersion: authority.document.formatVersion,
    projectId: authority.document.projectId,
    headRevisionId: authority.document.headRevisionId,
    metadata: authority.document.metadata,
    authorizedEventId: authority.authorizedEventId,
    eventCount: authority.document.events.length,
    events: authority.document.events,
  };
  const ledgerPrefixDigest = `sha256:${createHash("sha256")
    .update(stableStringify(prefixMaterial), "utf8")
    .digest("hex")}`;
  return {
    projectId: authority.document.projectId,
    semanticHeadRevisionId:
      authority.authorized.proposal.integratedRevisionId,
    authorizedEventId: authority.authorizedEventId,
    authorizedAt: authority.authorizedAt,
    ledgerVersion: authority.version,
    ledgerPrefixDigest,
  };
}
