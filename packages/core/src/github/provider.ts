import type { CredentialProvider } from "../config/config";
import { isSafeBranchName } from "./branch-name";
import type {
  Branch,
  CiStatus,
  Commit,
  PullRequest,
  PullRequestRef,
  PullRequestStatus,
  Repository,
} from "./models";
import type { CreatePullRequestInput, GitHubTransport, UpdatePullRequestInput } from "./transports";

export interface GitHubHttpRequest {
  readonly method: "GET" | "POST" | "PATCH";
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
}

export interface GitHubHttpResponse {
  readonly status: number;
  readonly body: unknown;
}

/** Injectable HTTP boundary; this adapter never calls global fetch. */
export interface GitHubHttpPort {
  request(request: GitHubHttpRequest): Promise<GitHubHttpResponse>;
}

export interface GitHubApiOptions {
  readonly apiBaseUrl?: string;
  readonly credentialName?: "GITHUB_TOKEN";
}

export class GitHubProviderError extends Error {
  readonly operation: string;
  readonly status?: number;

  public constructor(operation: string, status?: number) {
    super(
      status === undefined
        ? `GitHub ${operation} request failed`
        : `GitHub ${operation} request failed with status ${status}`,
    );
    this.name = "GitHubProviderError";
    this.operation = operation;
    this.status = status;
  }
}

const DEFAULT_API_BASE_URL = "https://api.github.com";

/** GitHub REST API implementation of the existing provider transport port. */
export class GitHubApiTransport implements GitHubTransport {
  readonly #http: GitHubHttpPort;
  readonly #credentials: CredentialProvider;
  readonly #baseUrl: string;
  readonly #credentialName: "GITHUB_TOKEN";

  public constructor(
    http: GitHubHttpPort,
    credentials: CredentialProvider,
    options: GitHubApiOptions = {},
  ) {
    if (http === null || typeof http.request !== "function") {
      throw new TypeError("a GitHub HTTP port is required");
    }
    if (credentials === null || typeof credentials.get !== "function") {
      throw new TypeError("a credential provider is required");
    }
    this.#http = http;
    this.#credentials = credentials;
    this.#baseUrl = safeBaseUrl(options.apiBaseUrl ?? DEFAULT_API_BASE_URL);
    this.#credentialName = options.credentialName ?? "GITHUB_TOKEN";
  }

  public async findPullRequest(ref: PullRequestRef): Promise<PullRequest | undefined> {
    validateRepository(ref.repository);
    validateBranch(ref.sourceBranch, "source branch");
    validateBranch(ref.targetBranch, "target branch");
    const response = await this.#request(
      "find pull request",
      "GET",
      path(ref.repository, "/pulls"),
      {
        state: "open",
        head: `${ref.repository.owner}:${ref.sourceBranch}`,
        base: ref.targetBranch,
        per_page: "100",
      },
    );
    if (!Array.isArray(response)) throw new GitHubProviderError("find pull request");
    const match = response.find((item) => {
      const pull = asRecord(item);
      return (
        pull !== undefined &&
        asRecord(pull.head)?.ref === ref.sourceBranch &&
        asRecord(pull.base)?.ref === ref.targetBranch
      );
    });
    return match === undefined ? undefined : toPullRequest(match, ref.repository);
  }

  public async createPullRequest(input: CreatePullRequestInput): Promise<PullRequest> {
    validateRepository(input.repository);
    validateBranch(input.sourceBranch, "source branch");
    validateBranch(input.targetBranch, "target branch");
    if (input.sourceBranch === input.targetBranch) {
      throw new GitHubProviderError("create pull request: source and target branches must differ");
    }
    const response = await this.#request(
      "create pull request",
      "POST",
      path(input.repository, "/pulls"),
      undefined,
      {
        title: input.title,
        head: input.sourceBranch,
        base: input.targetBranch,
        ...(input.body === undefined ? {} : { body: input.body }),
      },
    );
    return toPullRequest(response, input.repository);
  }

  public async updatePullRequest(input: UpdatePullRequestInput): Promise<PullRequest> {
    validateRepository(input.repository);
    if (!Number.isInteger(input.number) || input.number < 1) {
      throw new GitHubProviderError("update pull request: number must be a positive integer");
    }
    if (input.sourceBranch !== undefined) validateBranch(input.sourceBranch, "source branch");
    if (input.targetBranch !== undefined) validateBranch(input.targetBranch, "target branch");
    if (
      input.sourceBranch !== undefined &&
      input.targetBranch !== undefined &&
      input.sourceBranch === input.targetBranch
    ) {
      throw new GitHubProviderError("update pull request: source and target branches must differ");
    }
    const { repository, number, ...changes } = input;
    const response = await this.#request(
      "update pull request",
      "PATCH",
      path(repository, `/pulls/${number}`),
      undefined,
      {
        ...(changes.title === undefined ? {} : { title: changes.title }),
        ...(changes.body === undefined ? {} : { body: changes.body }),
        ...(changes.sourceBranch === undefined ? {} : { head: changes.sourceBranch }),
        ...(changes.targetBranch === undefined ? {} : { base: changes.targetBranch }),
      },
    );
    return toPullRequest(response, repository);
  }

  public async getPullRequestStatus(ref: PullRequestRef): Promise<PullRequestStatus> {
    validateRepository(ref.repository);
    validateBranch(ref.sourceBranch, "source branch");
    validateBranch(ref.targetBranch, "target branch");
    const pullRequest = await this.findPullRequest(ref);
    if (pullRequest === undefined) {
      return {
        state: "closed",
        ci: { state: "unknown", checks: [] },
      };
    }
    const [ci, reviewState] = await Promise.all([
      this.getCiStatus({ ...ref }),
      this.#reviewState(ref.repository, pullRequest.number),
    ]);
    return {
      state: pullRequest.state,
      ci,
      headSha: pullRequest.headSha,
      reviewState,
      mergeable: undefined,
    };
  }

  public async getCiStatus(ref: PullRequestRef): Promise<CiStatus> {
    validateRepository(ref.repository);
    validateBranch(ref.sourceBranch, "source branch");
    validateBranch(ref.targetBranch, "target branch");
    const pullRequest = await this.findPullRequest(ref);
    if (pullRequest === undefined || pullRequest.headSha === undefined) {
      return { state: "unknown", checks: [] };
    }
    const response = await this.#request(
      "get CI status",
      "GET",
      path(ref.repository, `/commits/${encodeURIComponent(pullRequest.headSha)}/check-runs`),
      { per_page: "100" },
    );
    const payload = asRecord(response);
    const runs = Array.isArray(payload?.check_runs) ? payload.check_runs : [];
    const checks = runs.map(toCheckStatus);
    return { state: combinedState(checks), checks };
  }

  /** Optional GitHub metadata ports used by composition roots for workspace setup. */
  public async getBranch(repository: Repository, name: string): Promise<Branch | undefined> {
    validateRepository(repository);
    validateBranch(name, "branch");
    try {
      const response = await this.#request(
        "get branch",
        "GET",
        path(repository, `/branches/${encodeURIComponent(name)}`),
      );
      const commit = asRecord(asRecord(response)?.commit);
      return { repository, name, headSha: stringValue(commit?.sha) };
    } catch (error) {
      if (error instanceof GitHubProviderError && error.status === 404) return undefined;
      throw error;
    }
  }

  public async getCommit(repository: Repository, revision: string): Promise<Commit> {
    validateRepository(repository);
    if (!revision || /[\u0000-\u0020\u007f]/u.test(revision)) {
      throw new GitHubProviderError("get commit: revision is invalid");
    }
    const response = await this.#request(
      "get commit",
      "GET",
      path(repository, `/commits/${encodeURIComponent(revision)}`),
    );
    const record = asRecord(response);
    return {
      repository,
      sha: requiredString(record?.sha, "get commit"),
      message: stringValue(asRecord(record?.commit)?.message),
      url: stringValue(record?.html_url),
    };
  }

  async #reviewState(repository: Repository, number: number): Promise<PullRequest["reviewState"]> {
    const response = await this.#request(
      "get pull request reviews",
      "GET",
      path(repository, `/pulls/${number}/reviews`),
      { per_page: "100" },
    );
    if (!Array.isArray(response)) return "unknown";
    let latest: PullRequest["reviewState"] = "pending";
    for (const item of response) {
      const state = stringValue(asRecord(item)?.state)?.toUpperCase();
      if (state === "CHANGES_REQUESTED") latest = "changes_requested";
      else if (state === "APPROVED" && latest !== "changes_requested") latest = "approved";
    }
    return latest;
  }

  async #request(
    operation: string,
    method: GitHubHttpRequest["method"],
    resource: string,
    query?: Readonly<Record<string, string>>,
    body?: unknown,
  ): Promise<unknown> {
    const token = this.#credentials.get(this.#credentialName);
    if (token === undefined || token.length === 0) {
      throw new GitHubProviderError(`${operation}: credential is not configured`);
    }
    const url = new URL(`${this.#baseUrl}${resource}`);
    if (query !== undefined)
      for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    let response: GitHubHttpResponse;
    try {
      response = await this.#http.request({
        method,
        url: url.toString(),
        headers: {
          accept: "application/vnd.github+json",
          "content-type": "application/json",
          "x-github-api-version": "2022-11-28",
          authorization: `Bearer ${token}`,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      // HTTP implementations may expose response bodies or authorization
      // details. Keep provider errors fixed and safe for logs.
      throw new GitHubProviderError(operation);
    }
    if (response.status < 200 || response.status >= 300)
      throw new GitHubProviderError(operation, response.status);
    return parseResponse(response.body, operation);
  }
}

function safeBaseUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "")
      throw new Error();
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error();
    return url.toString().replace(/\/$/u, "");
  } catch {
    throw new TypeError("GitHub API base URL must be an HTTP URL without credentials");
  }
}

function path(repository: Repository, suffix: string): string {
  return `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}${suffix}`;
}

function validateRepository(repository: Repository): void {
  if (
    !repository ||
    !/^[A-Za-z0-9_.-]+$/u.test(repository.owner) ||
    !/^[A-Za-z0-9_.-]+$/u.test(repository.name)
  ) {
    throw new GitHubProviderError("repository is invalid");
  }
}

function validateBranch(value: string, field: string): void {
  if (!isSafeBranchName(value)) throw new GitHubProviderError(`${field} is invalid`);
}

function parseResponse(body: unknown, operation: string): unknown {
  if (typeof body === "string") {
    try {
      return JSON.parse(body) as unknown;
    } catch {
      throw new GitHubProviderError(operation);
    }
  }
  if (body === null || typeof body !== "object") throw new GitHubProviderError(operation);
  return body;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function requiredString(value: unknown, operation: string): string {
  const result = stringValue(value);
  if (result === undefined || result.length === 0) throw new GitHubProviderError(operation);
  return result;
}

function toPullRequest(value: unknown, repository: Repository): PullRequest {
  const record = asRecord(value);
  const head = asRecord(record?.head);
  const base = asRecord(record?.base);
  const state = stringValue(record?.state);
  const merged = record?.merged_at !== null && record?.merged_at !== undefined;
  return {
    repository,
    number: typeof record?.number === "number" ? record.number : 0,
    title: stringValue(record?.title) ?? "",
    body: stringValue(record?.body),
    sourceBranch: requiredString(head?.ref, "pull request"),
    targetBranch: requiredString(base?.ref, "pull request"),
    state: merged ? "merged" : state === "open" ? "open" : "closed",
    url: stringValue(record?.html_url),
    headSha: stringValue(head?.sha),
  };
}

function toCheckStatus(value: unknown): CiStatus["checks"][number] {
  const record = asRecord(value);
  const conclusion = stringValue(record?.conclusion)?.toLowerCase();
  const status = stringValue(record?.status)?.toLowerCase();
  let state: CiStatus["checks"][number]["state"] = "unknown";
  if (status === "queued") state = "queued";
  else if (status === "in_progress") state = "in_progress";
  else if (conclusion === "success") state = "success";
  else if (conclusion === "failure" || conclusion === "timed_out") state = "failure";
  else if (conclusion === "cancelled") state = "cancelled";
  else if (conclusion === "skipped") state = "skipped";
  else if (conclusion === "neutral") state = "neutral";
  return {
    name: stringValue(record?.name) ?? "unknown",
    state,
    description: stringValue(record?.output_title),
    url: stringValue(record?.html_url),
    startedAt: stringValue(record?.started_at),
    completedAt: stringValue(record?.completed_at),
  };
}

function combinedState(checks: readonly CiStatus["checks"][number][]): CiStatus["state"] {
  if (checks.length === 0) return "unknown";
  if (checks.some((check) => check.state === "failure" || check.state === "cancelled"))
    return "failure";
  if (checks.some((check) => check.state === "queued" || check.state === "in_progress"))
    return "pending";
  if (
    checks.every(
      (check) =>
        check.state === "success" || check.state === "skipped" || check.state === "neutral",
    )
  )
    return "success";
  return "unknown";
}

/** Alias useful to composition roots that call all provider transports "clients". */
export const GitHubProviderTransport = GitHubApiTransport;

export function createGitHubApiTransport(
  http: GitHubHttpPort,
  credentials: CredentialProvider,
  options: GitHubApiOptions = {},
): GitHubApiTransport {
  return new GitHubApiTransport(http, credentials, options);
}
