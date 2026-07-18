import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  artifactIdentitySha256Hex,
  artifactPromotionId,
  type ArtifactPromotionIdentityMaterial,
} from "./identity";

const MATERIAL: ArtifactPromotionIdentityMaterial = {
  candidateId: `artifact-candidate:sha256:${"b".repeat(64)}`,
  repositoryId: "repository-odeu-worldstate",
  targetRef: "refs/heads/main",
  expectedBaseCommit: "a".repeat(40),
  candidateCommit: "c".repeat(40),
};

describe("browser-safe artifact promotion identity", () => {
  it("matches the canonical server identity known vector", () => {
    expect(artifactPromotionId(MATERIAL)).toBe(
      "artifact-promotion:sha256:751ad09f8958abc479dd41f556d05a08820f8627bfd037f54b8ab57beec7c9d1",
    );
  });

  it("matches Node SHA-256 for ASCII and multibyte UTF-8", () => {
    for (const input of ["", "abc", "authority → candidate ✓"]) {
      expect(artifactIdentitySha256Hex(input)).toBe(
        createHash("sha256").update(input, "utf8").digest("hex"),
      );
    }
  });
});
