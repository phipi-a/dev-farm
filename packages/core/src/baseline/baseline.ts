import type { FarmConfig, ProjectConfig } from "../config/config.ts";

/** A clock is injected so refresh records remain deterministic in tests. */
export interface BaselineClock {
  now(): Date;
}

/** Git operations are confined to the dedicated baseline workspace. */
export interface BaselineGitPort {
  isRepository(path: string): Promise<boolean>;
  clone(repositoryUrl: string, path: string): Promise<void>;
  /** Fetches the remote default branch without touching worker workspaces. */
  fetchDefaultBranch(path: string, branch: string): Promise<void>;
  /** Checks out the fetched branch in the dedicated baseline workspace. */
  checkout(path: string, branch: string): Promise<void>;
  resolveCommit(path: string, ref: string): Promise<string>;
}

export interface BaselineCacheOptions {
  /** Cache references are optional and are never treated as credentials. */
  readonly from?: readonly string[];
}

/** The deterministic input passed to an image builder. */
export interface ContainerBuildRequest {
  readonly contextPath: string;
  readonly image: string;
  readonly dockerfile: string;
  readonly commit: string;
  /** Sorted, reproducible build arguments; no runtime credentials are included. */
  readonly buildArgs: readonly [string, string][];
  /** Sorted cache references, omitted when cache was not configured. */
  readonly cacheFrom?: readonly string[];
}

export interface ContainerBuildResult {
  readonly status: "success" | "failure";
  readonly version?: string;
  readonly digest?: string;
  readonly error?: string;
}

export interface ContainerBuilderPort {
  build(request: ContainerBuildRequest): Promise<ContainerBuildResult>;
}

export interface BaselineRefreshRequest {
  readonly project: ProjectConfig;
  /** HTTPS/SSH repository URL supplied by the host; credentials are rejected. */
  readonly repositoryUrl?: string;
  readonly workspacePath: string;
  readonly cache?: BaselineCacheOptions;
}

export interface BaselineRefreshResult {
  readonly status: "succeeded" | "failed";
  readonly buildStatus: "success" | "failure";
  readonly project: string;
  readonly branch: string;
  readonly commit: string;
  readonly image: string;
  readonly version?: string;
  readonly digest?: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly error?: string;
}

export interface BaselineRefresherOptions {
  readonly git: BaselineGitPort;
  readonly builder: ContainerBuilderPort;
  readonly clock: BaselineClock;
  readonly config: Pick<FarmConfig, "baselineImage">;
  /** Default repository host used when a request does not provide a URL. */
  readonly repositoryHost?: string;
}

export class BaselineRefreshError extends Error {
  readonly result: BaselineRefreshResult;

  public constructor(result: BaselineRefreshResult, options?: { readonly cause?: unknown }) {
    super(`baseline refresh failed: ${result.error ?? "image build failed"}`, options);
    this.name = "BaselineRefreshError";
    this.result = result;
  }
}

export class BaselineValidationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "BaselineValidationError";
  }
}

/**
 * Fetches and builds a fresh post-merge baseline in an isolated workspace.
 * The refresher has no worker-workspace, branch deletion, or credential port,
 * so a confirmed merge remains confirmed when this best-effort side effect fails.
 */
export class BaselineRefresher {
  readonly #git: BaselineGitPort;
  readonly #builder: ContainerBuilderPort;
  readonly #clock: BaselineClock;
  readonly #image: string;
  readonly #repositoryHost: string;

  public constructor(options: BaselineRefresherOptions) {
    if (options?.git === undefined) throw new BaselineValidationError("a baseline git port is required");
    if (options.builder === undefined) throw new BaselineValidationError("a container builder port is required");
    if (options.clock === undefined) throw new BaselineValidationError("a baseline clock is required");
    if (options.config?.baselineImage === undefined) throw new BaselineValidationError("a baseline image is required");
    this.#git = options.git;
    this.#builder = options.builder;
    this.#clock = options.clock;
    this.#image = validText(options.config.baselineImage, "baseline image");
    this.#repositoryHost = validHost(options.repositoryHost ?? "https://github.com");
  }

  /** Refreshes baseline state; failures are thrown with a structured result. */
  public async refresh(request: BaselineRefreshRequest): Promise<BaselineRefreshResult> {
    validateRequest(request);
    const project = request.project;
    const startedAt = this.#timestamp();
    const branch = validBranch(project.defaultBranch);
    const repositoryUrl = safeRepositoryUrl(
      request.repositoryUrl ?? `${this.#repositoryHost}/${project.githubRepo}.git`,
    );
    const path = validText(request.workspacePath, "baseline workspace path");
    let commit = "unknown";

    try {
      if (!(await this.#git.isRepository(path))) await this.#git.clone(repositoryUrl, path);
      await this.#git.fetchDefaultBranch(path, branch);
      await this.#git.checkout(path, branch);
      commit = validText(await this.#git.resolveCommit(path, `origin/${branch}`), "baseline commit");
      const build = await this.#builder.build({
        contextPath: path,
        image: this.#image,
        dockerfile: "Dockerfile",
        commit,
        buildArgs: [["SOURCE_COMMIT", commit]],
        cacheFrom: normalizeCache(request.cache?.from),
      });
      const completedAt = this.#timestamp();
      const result = this.#result(project, branch, commit, startedAt, completedAt, build);
      if (build.status !== "success") throw new BaselineRefreshError(result);
      return result;
    } catch (error) {
      if (error instanceof BaselineRefreshError) throw error;
      const completedAt = this.#timestamp();
      const message = safeError(error);
      const result: BaselineRefreshResult = {
        status: "failed",
        buildStatus: "failure",
        project: project.name,
        branch,
        commit,
        image: this.#image,
        startedAt,
        completedAt,
        error: message,
      };
      throw new BaselineRefreshError(result, { cause: error });
    }
  }

  /** Function spelling for lifecycle adapters that do not retain the class. */
  public refreshBaseline(request: BaselineRefreshRequest): Promise<BaselineRefreshResult> {
    return this.refresh(request);
  }

  #result(
    project: ProjectConfig,
    branch: string,
    commit: string,
    startedAt: string,
    completedAt: string,
    build: ContainerBuildResult,
  ): BaselineRefreshResult {
    return {
      status: build.status === "success" ? "succeeded" : "failed",
      buildStatus: build.status,
      project: project.name,
      branch,
      commit,
      image: this.#image,
      version: build.version,
      digest: build.digest,
      startedAt,
      completedAt,
      error: build.status === "failure" ? safeError(build.error ?? "image build failed") : undefined,
    };
  }

  #timestamp(): string {
    const value = this.#clock.now();
    if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
      throw new BaselineValidationError("baseline clock returned an invalid date");
    }
    return value.toISOString();
  }
}

export function createBaselineRefresher(options: BaselineRefresherOptions): BaselineRefresher {
  return new BaselineRefresher(options);
}

function validateRequest(request: BaselineRefreshRequest): void {
  if (request === null || typeof request !== "object") throw new BaselineValidationError("baseline refresh request is required");
  if (request.project === null || typeof request.project !== "object") throw new BaselineValidationError("baseline project is required");
  validText(request.project.name, "project name");
  validText(request.project.githubRepo, "project repository");
  validBranch(request.project.defaultBranch);
  validText(request.workspacePath, "baseline workspace path");
  if (request.repositoryUrl !== undefined) safeRepositoryUrl(request.repositoryUrl);
}

function validText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "" || value.includes("\u0000")) {
    throw new BaselineValidationError(`${field} must be a non-empty string without NUL`);
  }
  return value;
}

function validBranch(value: unknown): string {
  const branch = validText(value, "default branch");
  if (branch.startsWith("/") || branch.endsWith("/") || branch.includes("..") || /[~^:?*[\\\s]/u.test(branch)) {
    throw new BaselineValidationError("default branch is not a valid branch name");
  }
  return branch;
}

function validHost(value: string): string {
  const host = validText(value, "repository host").replace(/\/$/u, "");
  if (/[\u0000-\u001f\u007f\s?&#@]/u.test(host) || !/^(?:https:\/\/|ssh:\/\/)[^/]+$/u.test(host)) {
    throw new BaselineValidationError("repository host is not supported");
  }
  return host;
}

function safeRepositoryUrl(value: string): string {
  const url = validText(value, "repository URL");
  if (/[\u0000-\u001f\u007f\s]/u.test(url) || /[?&#]/u.test(url)) {
    throw new BaselineValidationError("repository URL must not contain credentials or query parameters");
  }
  if (url.includes("@") || /:\/\/[^/]*:[^/@]+@/u.test(url)) {
    throw new BaselineValidationError("repository URL must not contain credentials");
  }
  const httpsOrSsh = /^(?:https:\/\/|ssh:\/\/)/u.test(url);
  if (httpsOrSsh) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new BaselineValidationError("repository URL is not supported");
    }
    if (parsed.pathname.split("/").filter(Boolean).length !== 2) {
      throw new BaselineValidationError("repository URL is not supported");
    }
  } else if (!/^git@[^:]+:[^/]+\/[^/]+(?:\.git)?$/u.test(url)) {
    throw new BaselineValidationError("repository URL is not supported");
  }
  return url;
}

function normalizeCache(values: readonly string[] | undefined): readonly string[] | undefined {
  if (values === undefined) return undefined;
  const cache = [...new Set(values.map((value) => {
    const reference = validText(value, "cache reference");
    if (/[\u0000-\u001f\u007f\s]/u.test(reference) || /(?:token|password|secret|api[_-]?key)=/iu.test(reference)
      || /:\/\/[^/]*:[^/@]+@/u.test(reference)) {
      throw new BaselineValidationError("cache reference must not contain credentials");
    }
    return reference;
  }))].sort((a, b) => a.localeCompare(b));
  return cache.length === 0 ? undefined : cache;
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/\b(?:ghp|gho|ghs|ghu|github_pat)[-_][A-Za-z0-9_-]+/gu, "[REDACTED]")
    .replace(/(token|password|secret|api[_-]?key)\s*[:=]\s*[^\s,;]+/giu, "$1=[REDACTED]")
    .slice(0, 500);
}
