/** A stable repository identity independent of a transport's URL format. */
export interface Repository {
  owner: string;
  name: string;
  defaultBranch: string;
  cloneUrl?: string;
  webUrl?: string;
}

export interface Branch {
  repository: Repository;
  name: string;
  headSha?: string;
}

export interface Commit {
  repository: Repository;
  sha: string;
  message?: string;
  url?: string;
}

export type PullRequestState = "open" | "closed" | "merged";

export type PullRequestReviewState =
  | "pending"
  | "approved"
  | "changes_requested"
  | "dismissed"
  | "unknown";

export interface PullRequest {
  repository: Repository;
  number: number;
  title: string;
  body?: string;
  sourceBranch: string;
  targetBranch: string;
  state: PullRequestState;
  url?: string;
  /** The commit currently presented for review. */
  headSha?: string;
  reviewState?: PullRequestReviewState;
}

export type CheckState =
  | "queued"
  | "in_progress"
  | "success"
  | "failure"
  | "cancelled"
  | "skipped"
  | "neutral"
  | "unknown";

export interface CheckStatus {
  name: string;
  state: CheckState;
  /** Set when the provider identifies this check as required. */
  required?: boolean;
  description?: string;
  url?: string;
  startedAt?: string;
  completedAt?: string;
}

export type CombinedStatusState = "pending" | "success" | "failure" | "error" | "unknown";

export interface CiStatus {
  state: CombinedStatusState;
  checks: readonly CheckStatus[];
  /** Results for the checks required by branch protection. */
  requiredChecks?: readonly CheckStatus[];
  updatedAt?: string;
}

export interface PullRequestStatus {
  state: PullRequestState;
  ci: CiStatus;
  /** Review state for the current head; this is not merge authorization. */
  reviewState?: PullRequestReviewState;
  /** The head SHA to which the review and check results apply. */
  headSha?: string;
  mergeable?: boolean;
}

export interface PullRequestRef {
  repository: Repository;
  sourceBranch: string;
  targetBranch: string;
}
