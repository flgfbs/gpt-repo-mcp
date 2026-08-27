import {
  sha256Json,
  type ContentAddressedArtifactSink,
  type GitHubArtifactNamespace,
  type JsonValue
} from "./types.js";

export type StoredGitHubEvidence = {
  artifactId: string;
  digest: string;
};

export async function storeGitHubEvidence(
  sink: ContentAddressedArtifactSink,
  namespace: GitHubArtifactNamespace,
  value: JsonValue
): Promise<StoredGitHubEvidence> {
  const digest = sha256Json(value);
  const stored = await sink.putJson({ namespace, digest, value, mode: 0o600 });
  return { artifactId: stored.artifactId, digest };
}
