import type {
  CiStatus,
  PullRequest,
  PullRequestRef,
  PullRequestStatus,
  Repository,
} from "../github/models";
import type {
  CreatePullRequestInput,
  GitHubTransport,
  UpdatePullRequestInput,
} from "../github/transports";
import type {
  LinearComment,
  LinearCommentInput,
  LinearIssue,
  LinearIssueUpdateInput,
} from "../linear/types";
import type { LinearTransport } from "../linear/transport";
import type {
  GitWorkspacePort,
  GitWorkspaceStatus,
} from "../workspace/provisioner";
import type { TmuxCommandResult, TmuxCommandRunner } from "../tmux/tmux";

export const contractRepository: Repository = {
  owner: "acme",
  name: "widget",
  defaultBranch: "main",
};

export function contractPullRequest(
  overrides: Partial<PullRequest> = {},
): PullRequest {
  return {
    repository: contractRepository,
    number: 1,
    title: "DEV-25 contract",
    sourceBranch: "linear/dev-25-contract",
    targetBranch: "main",
    state: "open",
    ...overrides,
  };
}

/** In-memory Linear adapter with controllable transport failures. */
export class FakeLinearTransport implements LinearTransport {
  readonly issues = new Map<string, LinearIssue>();
  readonly updates: LinearIssueUpdateInput[] = [];
  readonly comments: LinearCommentInput[] = [];
  failNextUpdate: Error | undefined;
  failNextComment: Error | undefined;

  public constructor(issue: LinearIssue = {
    id: "issue-1",
    identifier: "DEV-25",
    title: "Contract tests",
    status: { id: "status-todo", name: "Todo" },
  }) {
    this.issues.set(issue.identifier, issue);
  }

  public async getIssue(identifier: string): Promise<LinearIssue | null> {
    return this.issues.get(identifier) ?? null;
  }

  public async updateIssue(input: LinearIssueUpdateInput): Promise<LinearIssue> {
    if (this.failNextUpdate !== undefined) {
      const failure = this.failNextUpdate;
      this.failNextUpdate = undefined;
      throw failure;
    }
    const issue = this.issues.get(input.identifier);
    if (issue === undefined) throw new Error("issue disappeared");
    this.updates.push(input);
    const updated: LinearIssue = {
      ...issue,
      status: { ...issue.status, name: input.status },
    };
    this.issues.set(input.identifier, updated);
    return updated;
  }

  public async createComment(input: LinearCommentInput): Promise<LinearComment> {
    if (this.failNextComment !== undefined) {
      const failure = this.failNextComment;
      this.failNextComment = undefined;
      throw failure;
    }
    if (!this.issues.has(input.identifier)) throw new Error("issue disappeared");
    this.comments.push(input);
    return {
      id: `comment-${this.comments.length}`,
      issueIdentifier: input.identifier,
      body: input.body,
    };
  }
}

/** In-memory GitHub adapter that models the timeout-after-acceptance case. */
export class FakeGitHubTransport implements GitHubTransport {
  readonly pullRequests: PullRequest[] = [];
  readonly created: CreatePullRequestInput[] = [];
  readonly updated: UpdatePullRequestInput[] = [];
  readonly status: PullRequestStatus = {
    state: "open",
    ci: { state: "success", checks: [] },
  };
  failNextCreateAfterPersist = false;
  failNextCreate = false;

  public async findPullRequest(ref: PullRequestRef): Promise<PullRequest | undefined> {
    return this.pullRequests.find((candidate) =>
      candidate.repository.owner === ref.repository.owner &&
      candidate.repository.name === ref.repository.name &&
      candidate.sourceBranch === ref.sourceBranch &&
      candidate.targetBranch === ref.targetBranch &&
      candidate.state === "open",
    );
  }

  public async createPullRequest(input: CreatePullRequestInput): Promise<PullRequest> {
    this.created.push(input);
    if (this.failNextCreate) {
      this.failNextCreate = false;
      throw new Error("GitHub request timed out before acceptance");
    }
    const pullRequest = contractPullRequest({
      ...input,
      number: this.pullRequests.length + 1,
    });
    this.pullRequests.push(pullRequest);
    if (this.failNextCreateAfterPersist) {
      this.failNextCreateAfterPersist = false;
      throw new Error("GitHub request timed out after acceptance");
    }
    return pullRequest;
  }

  public async updatePullRequest(input: UpdatePullRequestInput): Promise<PullRequest> {
    this.updated.push(input);
    const pullRequest = this.pullRequests.find((candidate) =>
      candidate.repository.owner === input.repository.owner &&
      candidate.repository.name === input.repository.name &&
      candidate.number === input.number,
    );
    if (pullRequest === undefined) throw new Error("pull request was not found");
    Object.assign(pullRequest, input);
    return pullRequest;
  }

  public async getPullRequestStatus(ref: PullRequestRef): Promise<PullRequestStatus> {
    const pullRequest = await this.findPullRequest(ref);
    return pullRequest === undefined ? { ...this.status } : {
      ...this.status,
      state: pullRequest.state,
      headSha: pullRequest.headSha,
      reviewState: pullRequest.reviewState,
    };
  }

  public async getCiStatus(_ref: PullRequestRef): Promise<CiStatus> {
    return this.status.ci;
  }
}

/** Scriptable workspace fake. It intentionally records every port call. */
export class FakeGitWorkspacePort implements GitWorkspacePort {
  readonly calls: string[] = [];
  readonly branches = new Set<string>();
  repository = false;
  clean = true;
  current: string | undefined;
  baseCommit = "base-sha";
  cloneFailure: Error | undefined;

  public async isRepository(_path: string): Promise<boolean> {
    this.calls.push("isRepository");
    return this.repository;
  }

  public async clone(_repositoryUrl: string, _path: string): Promise<void> {
    this.calls.push("clone");
    if (this.cloneFailure !== undefined) throw this.cloneFailure;
    this.repository = true;
  }

  public async fetchDefaultBranch(_path: string, _branch: string): Promise<void> {
    this.calls.push("fetchDefaultBranch");
  }

  public async status(_path: string): Promise<GitWorkspaceStatus> {
    this.calls.push("status");
    return { clean: this.clean };
  }

  public async currentBranch(_path: string): Promise<string | undefined> {
    this.calls.push("currentBranch");
    return this.current;
  }

  public async branchExists(_path: string, branch: string): Promise<boolean> {
    this.calls.push("branchExists");
    return this.branches.has(branch);
  }

  public async createBranch(_path: string, branch: string, _startPoint: string): Promise<void> {
    this.calls.push("createBranch");
    this.branches.add(branch);
  }

  public async checkout(_path: string, branch: string): Promise<void> {
    this.calls.push("checkout");
    this.current = branch;
  }

  public async resolveCommit(_path: string, _ref: string): Promise<string> {
    this.calls.push("resolveCommit");
    return this.baseCommit;
  }
}

/** Minimal tmux runner with a mutable session/window model. */
export class FakeTmuxRunner implements TmuxCommandRunner {
  readonly calls: Array<{ command: string; args: readonly string[] }> = [];
  readonly windows = new Set<string>();
  sessionExists = false;
  nextResult: TmuxCommandResult | undefined;
  rejectNext: Error | undefined;

  public async run(command: string, args: readonly string[]): Promise<TmuxCommandResult> {
    this.calls.push({ command, args: [...args] });
    if (this.rejectNext !== undefined) {
      const failure = this.rejectNext;
      this.rejectNext = undefined;
      throw failure;
    }
    if (this.nextResult !== undefined) {
      const result = this.nextResult;
      this.nextResult = undefined;
      return result;
    }
    const action = args[0];
    if (action === "has-session") {
      return { exitCode: this.sessionExists ? 0 : 1, stdout: "", stderr: "" };
    }
    if (action === "new-session") {
      this.sessionExists = true;
      this.windows.add(String(args[args.indexOf("-n") + 1]));
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    if (action === "list-windows") {
      return { exitCode: 0, stdout: `${[...this.windows].join("\n")}\n`, stderr: "" };
    }
    if (action === "new-window") {
      this.windows.add(String(args[args.indexOf("-n") + 1]));
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  }
}
