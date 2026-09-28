import {
  CiStatus,
  PullRequest,
  PullRequestRef,
  PullRequestStatus,
  Repository,
} from "./models";
import {
  CreatePullRequestInput,
  GitHubTransport,
  UpdatePullRequestInput,
} from "./transports";

export const fixtureRepository: Repository = {
  owner: "acme",
  name: "widget",
  defaultBranch: "main",
};

export function fixturePullRequest(overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    repository: fixtureRepository,
    number: 42,
    title: "DEV-6: Add callback",
    sourceBranch: "linear/dev-6-add-callback",
    targetBranch: "main",
    state: "open",
    url: "https://github.com/acme/widget/pull/42",
    ...overrides,
  };
}

export class FixtureGitHubTransport implements GitHubTransport {
  readonly pullRequests: PullRequest[] = [];
  createCalls = 0;
  updateCalls = 0;
  failCreate = false;

  async findPullRequest(ref: PullRequestRef): Promise<PullRequest | undefined> {
    return this.pullRequests.find(
      (pullRequest) =>
        pullRequest.repository.owner === ref.repository.owner &&
        pullRequest.repository.name === ref.repository.name &&
        pullRequest.sourceBranch === ref.sourceBranch &&
        pullRequest.targetBranch === ref.targetBranch &&
        pullRequest.state === "open",
    );
  }

  async createPullRequest(input: CreatePullRequestInput): Promise<PullRequest> {
    this.createCalls += 1;
    if (this.failCreate) {
      this.failCreate = false;
      const pullRequest = fixturePullRequest(input);
      this.pullRequests.push(pullRequest);
      throw new Error("request timed out after creation");
    }
    const pullRequest = fixturePullRequest(input);
    this.pullRequests.push(pullRequest);
    return pullRequest;
  }

  async updatePullRequest(input: UpdatePullRequestInput): Promise<PullRequest> {
    this.updateCalls += 1;
    const pullRequest = this.pullRequests.find(
      (candidate) =>
        candidate.repository.owner === input.repository.owner &&
        candidate.repository.name === input.repository.name &&
        candidate.number === input.number,
    );
    if (!pullRequest) {
      throw new Error(`pull request ${input.number} was not found`);
    }
    Object.assign(pullRequest, input);
    return pullRequest;
  }

  async getPullRequestStatus(_ref: PullRequestRef): Promise<PullRequestStatus> {
    const pullRequest = await this.findPullRequest(_ref);
    return {
      state: pullRequest?.state ?? "open",
      ci: await this.getCiStatus(_ref),
      headSha: pullRequest?.headSha,
      reviewState: pullRequest?.reviewState,
    };
  }

  async getCiStatus(_ref: PullRequestRef): Promise<CiStatus> {
    return { state: "pending", checks: [] };
  }
}
