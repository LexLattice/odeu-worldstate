import "server-only";

import { z } from "zod";

import type {
  LiveEvidenceRepositoryConfiguration,
  LiveEvidenceVerifierOptions,
} from "@/adapters/live-evidence/server";

const CONFIGURATION_MAX_BYTES = 64 * 1_024;

const PromotionEnvironmentSchema = z
  .object({
    repository: z.string().trim().min(1).max(4_096),
    statusStoreDirectory: z.string().trim().min(1).max(4_096),
    repositoryId: z.string().trim().min(1).max(240),
    targetRef: z.string().trim().min(1).max(1_024),
    signingKeyId: z.string().trim().min(1).max(240),
    signingSecret: z.string().min(32).max(16 * 1_024),
  })
  .strict();
const SigningSecretsSchema = z.record(
  z.string().trim().min(1).max(240),
  z.string().min(32).max(16 * 1_024),
);
const RepositoryRegistrySchema = z.record(
  z.string().trim().min(1).max(240),
  z
    .object({
      repositoryPath: z.string().trim().min(1).max(4_096),
      toolchainPath: z.string().trim().min(1).max(4_096).optional(),
    })
    .strict(),
);

export class ArtifactPromotionConfigurationError extends Error {
  constructor(options: ErrorOptions = {}) {
    super("The artifact promotion service is unavailable.", options);
    this.name = "ArtifactPromotionConfigurationError";
  }
}

function configuredJson(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
): unknown {
  const raw = env[name];
  if (!raw || Buffer.byteLength(raw, "utf8") > CONFIGURATION_MAX_BYTES) {
    throw new ArtifactPromotionConfigurationError();
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch (cause) {
    throw new ArtifactPromotionConfigurationError({ cause });
  }
}

export function artifactPromotionLiveEvidenceConfigurationFromEnvironment(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Pick<LiveEvidenceVerifierOptions, "signingSecrets" | "repositories"> {
  try {
    const signingSecrets = SigningSecretsSchema.parse(
      configuredJson(env, "ODEU_LIVE_EVIDENCE_SIGNING_SECRETS"),
    );
    const repositories = RepositoryRegistrySchema.parse(
      configuredJson(env, "ODEU_LIVE_EVIDENCE_REPOSITORIES"),
    ) as Readonly<Record<string, LiveEvidenceRepositoryConfiguration>>;
    if (
      Object.keys(signingSecrets).length === 0 ||
      Object.keys(repositories).length === 0
    ) {
      throw new ArtifactPromotionConfigurationError();
    }
    return { signingSecrets, repositories };
  } catch (error) {
    if (error instanceof ArtifactPromotionConfigurationError) throw error;
    throw new ArtifactPromotionConfigurationError({ cause: error });
  }
}

export interface ArtifactPromotionServerConfiguration {
  readonly repository: string;
  readonly statusStoreDirectory: string;
  readonly repositoryId: string;
  readonly targetRef: string;
  readonly signingKeyId: string;
  readonly signingSecret: string;
}

export function artifactPromotionConfigurationFromEnvironment(
  env: Readonly<Record<string, string | undefined>> = process.env,
): ArtifactPromotionServerConfiguration {
  try {
    return PromotionEnvironmentSchema.parse({
      repository: env.ODEU_CODEX_PROMOTION_REPOSITORY,
      statusStoreDirectory: env.ODEU_CODEX_PROMOTION_STATUS_STORE,
      repositoryId: env.ODEU_CODEX_REPOSITORY_ID,
      targetRef: env.ODEU_CODEX_PROMOTION_TARGET_REF,
      signingKeyId: env.ODEU_CODEX_ARTIFACT_SIGNING_KEY_ID,
      signingSecret: env.ODEU_CODEX_ARTIFACT_SIGNING_SECRET,
    });
  } catch (cause) {
    throw new ArtifactPromotionConfigurationError({ cause });
  }
}
