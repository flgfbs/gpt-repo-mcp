import {
  GitHubBoundaryError,
  repositorySlug,
  type RepositorySnapshot,
  type ServerOwnedTask
} from "../github/types.js";

const WRITABLE_PERMISSIONS = new Set(["WRITE", "MAINTAIN", "ADMIN"]);

export function assertWritablePublicationTarget(
  task: ServerOwnedTask,
  repository: RepositorySnapshot
): void {
  const configuredRepository = repositorySlug(task.repository);
  const expectedRemoteIdentity = `github.com/${configuredRepository}`.toLowerCase();

  if (task.expectedRemoteIdentity.toLowerCase() !== expectedRemoteIdentity) {
    throw new GitHubBoundaryError(
      "PUBLICATION_TARGET_BINDING_MISMATCH",
      "Configured GitHub repository does not match the exact remote identity bound to the task."
    );
  }
  if (repository.nameWithOwner.toLowerCase() !== configuredRepository.toLowerCase()) {
    throw new GitHubBoundaryError(
      "PUBLICATION_TARGET_BINDING_MISMATCH",
      "Observed GitHub repository does not match the exact publication target bound to the task."
    );
  }
  if (repository.archived) {
    throw new GitHubBoundaryError(
      "PUBLICATION_TARGET_ARCHIVED",
      "Archived repositories cannot be used as publication targets."
    );
  }
  if (!WRITABLE_PERMISSIONS.has(repository.viewerPermission.trim().toUpperCase())) {
    throw new GitHubBoundaryError(
      "PUBLICATION_TARGET_NOT_WRITABLE",
      "The authenticated GitHub viewer lacks write authority for the configured publication target."
    );
  }
}
