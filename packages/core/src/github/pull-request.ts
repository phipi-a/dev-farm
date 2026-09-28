import { PullRequest, PullRequestRef, Repository } from "./models";
import {
  CreatePullRequestInput,
  GitHubTransport,
  PullRequestChanges,
  UpdatePullRequestInput,
} from "./transports";

export interface PullRequestIntent extends CreatePullRequestInput {}

function validateIntent(intent: PullRequestIntent): void {
  const repository: Repository = intent.repository;
  if (!repository.owner.trim() || !repository.name.trim()) {
    throw new Error("pull request repository must have an owner and name");
  }
  if (!intent.sourceBranch.trim() || !intent.targetBranch.trim()) {
    throw new Error("pull request branches must not be empty");
  }
  if (intent.sourceBranch === intent.targetBranch) {
    throw new Error("pull request source and target branches must differ");
  }
  if (!intent.title.trim()) {
    throw new Error("pull request title must not be empty");
  }
}

/**
 * Finds an existing open PR before creating one. If a create request fails
 * after the remote accepted it, the follow-up lookup makes retrying this
 * intent safe without requiring a provider-specific error type.
 */
export async function findOrCreatePullRequest(
  github: GitHubTransport,
  intent: PullRequestIntent,
): Promise<PullRequest> {
  validateIntent(intent);

  const ref: PullRequestRef = {
    repository: intent.repository,
    sourceBranch: intent.sourceBranch,
    targetBranch: intent.targetBranch,
  };
  const existing = await github.findPullRequest(ref);
  if (existing) {
    return existing;
  }

  try {
    return await github.createPullRequest(intent);
  } catch (createError) {
    // A network timeout can happen after GitHub creates the PR. Prefer the
    // existing resource if the operation is retried, but retain real failures.
    try {
      const createdByRetry = await github.findPullRequest(ref);
      if (createdByRetry) {
        return createdByRetry;
      }
    } catch {
      // The original create error is more useful when the recovery lookup is
      // unavailable as well.
    }
    throw createError;
  }
}

/**
 * Updates an existing PR through the injected transport. The overload taking a
 * current PR makes retries cheap: an empty change set is a no-op and does not
 * issue a remote mutation.
 */
export async function updatePullRequest(
  github: GitHubTransport,
  input: UpdatePullRequestInput,
): Promise<PullRequest>;
export async function updatePullRequest(
  github: GitHubTransport,
  current: PullRequest,
  changes: PullRequestChanges,
): Promise<PullRequest>;
export async function updatePullRequest(
  github: GitHubTransport,
  inputOrCurrent: UpdatePullRequestInput | PullRequest,
  changes?: PullRequestChanges,
): Promise<PullRequest> {
  const input: UpdatePullRequestInput = changes
    ? {
        repository: inputOrCurrent.repository,
        number: inputOrCurrent.number,
        ...changes,
      }
    : inputOrCurrent;

  if (!input.repository.owner.trim() || !input.repository.name.trim()) {
    throw new Error("pull request repository must have an owner and name");
  }
  if (!Number.isInteger(input.number) || input.number < 1) {
    throw new Error("pull request number must be a positive integer");
  }
  if (input.title !== undefined && !input.title.trim()) {
    throw new Error("pull request title must not be empty");
  }
  if (input.sourceBranch !== undefined && !input.sourceBranch.trim()) {
    throw new Error("pull request source branch must not be empty");
  }
  if (input.targetBranch !== undefined && !input.targetBranch.trim()) {
    throw new Error("pull request target branch must not be empty");
  }
  const sourceBranch = changes ? inputOrCurrent.sourceBranch : input.sourceBranch;
  const targetBranch = changes ? inputOrCurrent.targetBranch : input.targetBranch;
  if (
    sourceBranch !== undefined &&
    targetBranch !== undefined &&
    sourceBranch === targetBranch
  ) {
    throw new Error("pull request source and target branches must differ");
  }

  const { repository, number, ...requestedChanges } = input;
  if (changes && Object.keys(requestedChanges).length === 0) {
    return inputOrCurrent as PullRequest;
  }
  return github.updatePullRequest({ repository, number, ...requestedChanges });
}

/** Alias for callers that describe this operation as ensuring a PR exists. */
export const ensurePullRequest = findOrCreatePullRequest;
