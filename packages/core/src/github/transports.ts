import {
  Branch,
  CiStatus,
  Commit,
  PullRequest,
  PullRequestRef,
  PullRequestStatus,
  Repository,
} from "./models";

export interface CreateBranchInput {
  repository: Repository;
  name: string;
  /** Branch, tag, or commit SHA to use as the new branch's starting point. */
  startPoint: string;
}

/** The local/remote Git operations needed by the core boundary. */
export interface GitTransport {
  getBranch(repository: Repository, name: string): Promise<Branch | undefined>;
  createBranch(input: CreateBranchInput): Promise<Branch>;
  pushBranch(branch: Branch): Promise<void>;
  getCommit(repository: Repository, revision: string): Promise<Commit>;
}

export interface CreatePullRequestInput extends PullRequestRef {
  title: string;
  body?: string;
}

/**
 * GitHub operations are deliberately represented as an injected port. There
 * is no merge operation here: authorization and merge policy belong elsewhere.
 * `findPullRequest` implementations should return the matching open PR, when
 * one exists, for the source/target pair.
 */
export interface GitHubTransport {
  findPullRequest(ref: PullRequestRef): Promise<PullRequest | undefined>;
  createPullRequest(input: CreatePullRequestInput): Promise<PullRequest>;
  getPullRequestStatus(ref: PullRequestRef): Promise<PullRequestStatus>;
  getCiStatus(ref: PullRequestRef): Promise<CiStatus>;
}
