import type { Repository } from "../github/models";
import { branchNameForIssue } from "./branch-name";

/**
 * The portion of git status needed to make a safe branch decision. A port must
 * include untracked files in this result; checking only tracked modifications
 * could make a checkout overwrite user work.
 */
export interface GitWorkspaceStatus {
  readonly clean: boolean;
}

/**
 * Git is deliberately a port. The workspace boundary never shells out itself,
 * which keeps command policy testable and lets a host provide its own runner.
 */
export interface GitWorkspacePort {
  /** Return false for a path that has not been cloned yet. */
  isRepository(path: string): Promise<boolean>;
  clone(repositoryUrl: string, path: string): Promise<void>;
  /** Fetch only the requested default branch; this must not update the worktree. */
  fetchDefaultBranch(path: string, branch: string): Promise<void>;
  status(path: string): Promise<GitWorkspaceStatus>;
  currentBranch(path: string): Promise<string | undefined>;
  branchExists(path: string, branch: string): Promise<boolean>;
  /** Create a local branch without changing the current worktree. */
  createBranch(path: string, branch: string, startPoint: string): Promise<void>;
  checkout(path: string, branch: string): Promise<void>;
  resolveCommit(path: string, ref: string): Promise<string>;
}

export interface WorkspaceProvisionRequest {
  readonly path: string;
  readonly repository: Repository;
  readonly issueIdentifier: string;
  /** Usually the issue title. It is sanitized and never interpreted as ref syntax. */
  readonly issueSlug?: string;
  readonly branchPrefix?: string;
}

/** The facts needed to resume an attempt after a process restart. */
export interface WorkspaceMetadata {
  readonly path: string;
  readonly repository: Repository;
  readonly branch: string;
  readonly baseCommit: string;
}

export class WorkspaceProvisioningError extends Error {
  readonly operation: string;
  readonly path: string;
  readonly retryable = true;

  public constructor(operation: string, path: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "WorkspaceProvisioningError";
    this.operation = operation;
    this.path = path;
  }
}

export class WorkspaceRecoveryError extends WorkspaceProvisioningError {
  public constructor(path: string, message: string) {
    super("recover", path, message);
    this.name = "WorkspaceRecoveryError";
  }
}

function validateRequest(request: WorkspaceProvisionRequest): void {
  if (request === null || typeof request !== "object") {
    throw new Error("workspace provisioning request is required");
  }
  if (typeof request.path !== "string" || request.path.trim() === "") {
    throw new Error("workspace path must be a non-empty string");
  }
  if (request.repository === null || typeof request.repository !== "object") {
    throw new Error("repository is required");
  }
  if (
    typeof request.repository.defaultBranch !== "string" ||
    request.repository.defaultBranch.trim() === ""
  ) {
    throw new Error("repository.defaultBranch is required");
  }
}

/**
 * Provisions and resumes one isolated git workspace.
 *
 * The operation is intentionally idempotent: repeating it fetches the default
 * branch and reconciles the requested local branch, but never resets, cleans,
 * stashes, or otherwise discards work in the workspace. A dirty workspace on a
 * different branch is reported as a recovery error rather than being switched.
 */
export class WorkspaceProvisioner {
  readonly #git: GitWorkspacePort;

  public constructor(options: { readonly git: GitWorkspacePort }) {
    if (options === null || typeof options !== "object" || options.git === undefined) {
      throw new Error("a git workspace port is required");
    }
    this.#git = options.git;
  }

  /** Provision a new workspace or reconcile an existing one. */
  public async provision(request: WorkspaceProvisionRequest): Promise<WorkspaceMetadata> {
    validateRequest(request);
    const { path, repository } = request;
    const branch = branchNameForIssue(request.issueIdentifier, request.issueSlug ?? "", {
      prefix: request.branchPrefix,
    });

    const exists = await this.#operation("inspect", path, () => this.#git.isRepository(path));
    if (!exists) {
      const cloneUrl = repository.cloneUrl;
      if (typeof cloneUrl !== "string" || cloneUrl.trim() === "") {
        throw new Error("repository.cloneUrl is required when cloning a workspace");
      }
      await this.#operation("clone", path, () => this.#git.clone(cloneUrl, path));
    }

    // Fetching is safe with local modifications and makes the recorded base
    // commit deterministic even when this is a retry after a process restart.
    await this.#operation("fetch-default-branch", path, () =>
      this.#git.fetchDefaultBranch(path, repository.defaultBranch),
    );
    const baseCommit = await this.#operation("resolve-base-commit", path, () =>
      this.#git.resolveCommit(path, `origin/${repository.defaultBranch}`),
    );

    const currentBranch = await this.#operation("inspect-branch", path, () =>
      this.#git.currentBranch(path),
    );
    const dirty = !(await this.#operation("inspect-status", path, () => this.#git.status(path))).clean;
    const branchAlreadyExists = await this.#operation("inspect-branch", path, () =>
      this.#git.branchExists(path, branch),
    );

    if (currentBranch !== branch && dirty) {
      throw new WorkspaceRecoveryError(
        path,
        `workspace has uncommitted changes on ${currentBranch ?? "a detached HEAD"}; ` +
          `recover it before switching to ${branch}`,
      );
    }

    if (branchAlreadyExists) {
      if (currentBranch !== branch) {
        await this.#operation("checkout-branch", path, () => this.#git.checkout(path, branch));
      }
    } else {
      // When resuming a dirty detached/current worktree, use its HEAD as the
      // branch point. Branching at origin/default would leave those changes on
      // an unrelated branch, while this preserves exactly what the user had.
      const startPoint = dirty ? "HEAD" : `origin/${repository.defaultBranch}`;
      await this.#operation("create-branch", path, () =>
        this.#git.createBranch(path, branch, startPoint),
      );
      await this.#operation("checkout-branch", path, () => this.#git.checkout(path, branch));
    }

    return { path, repository, branch, baseCommit };
  }

  /** Explicit resume spelling for recovery callers; it has the same idempotent semantics. */
  public resume(request: WorkspaceProvisionRequest): Promise<WorkspaceMetadata> {
    return this.provision(request);
  }

  async #operation<T>(operation: string, path: string, action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } catch (error) {
      if (error instanceof WorkspaceProvisioningError) throw error;
      const detail = error instanceof Error ? error.message : String(error);
      throw new WorkspaceProvisioningError(operation, path, `${operation} failed: ${detail}`, {
        cause: error,
      });
    }
  }
}

/** Function form for callers that do not need to retain the provisioner. */
export async function provisionWorkspace(
  git: GitWorkspacePort,
  request: WorkspaceProvisionRequest,
): Promise<WorkspaceMetadata> {
  return new WorkspaceProvisioner({ git }).provision(request);
}
