import { realpath as fsRealpath } from "node:fs/promises";
import { dirname, isAbsolute, join, basename } from "node:path";
import type { GitWorkspacePort, GitWorkspaceStatus } from "../workspace/provisioner.ts";

export interface GitCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface GitCommandOptions {
  readonly cwd: string;
}

/** Injectable boundary for git. No git process is started by tests. */
export interface GitCommandRunner {
  run(command: string, args: readonly string[], options: GitCommandOptions): Promise<GitCommandResult>;
}

export interface GitPathResolver {
  realpath(path: string): Promise<string>;
}

export class GitError extends Error {
  public constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "GitError";
  }
}

export class GitValidationError extends GitError {
  public constructor(message: string) {
    super(message);
    this.name = "GitValidationError";
  }
}

export class GitCommandError extends GitError {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly exitCode: number;
  readonly stderr: string;

  public constructor(command: string, args: readonly string[], cwd: string, result: Pick<GitCommandResult, "exitCode" | "stderr">) {
    const safeArgs = redactArgs(args);
    const stderr = redactText(result.stderr);
    super(`${command} ${safeArgs.join(" ")} failed with exit code ${result.exitCode}`
      + (stderr.length > 0 ? `: ${stderr}` : ""));
    this.name = "GitCommandError";
    this.command = command;
    this.args = safeArgs;
    this.cwd = cwd;
    this.exitCode = result.exitCode;
    this.stderr = stderr;
  }
}

const defaultResolver: GitPathResolver = { realpath: fsRealpath };

/** A production GitWorkspacePort implemented only through an injected runner. */
export class GitWorkspaceAdapter implements GitWorkspacePort {
  readonly #runner: GitCommandRunner;
  readonly #paths: GitPathResolver;

  public constructor(runner: GitCommandRunner, options: { readonly paths?: GitPathResolver } = {}) {
    if (runner === null || typeof runner !== "object" || typeof runner.run !== "function") {
      throw new GitValidationError("a git command runner is required");
    }
    this.#runner = runner;
    this.#paths = options.paths ?? defaultResolver;
  }

  public async isRepository(path: string): Promise<boolean> {
    let cwd: string;
    try {
      cwd = await this.#existingPath(path);
    } catch {
      // A missing checkout is the normal pre-clone state of the workspace port.
      return false;
    }
    const result = await this.#run(["rev-parse", "--is-inside-work-tree"], cwd);
    if (result.exitCode === 0) return result.stdout.trim() === "true";
    if (result.exitCode === 128 || /not a git repository/iu.test(result.stderr)) return false;
    throw new GitCommandError("git", ["rev-parse", "--is-inside-work-tree"], cwd, result);
  }

  public async clone(repositoryUrl: string, path: string): Promise<void> {
    requireText(repositoryUrl, "repository URL");
    const destination = await this.#cloneDestination(path);
    const result = await this.#run(["clone", "--", repositoryUrl, destination], dirname(destination));
    if (result.exitCode !== 0) throw new GitCommandError("git", ["clone", "--", repositoryUrl, destination], dirname(destination), result);
  }

  public async fetchDefaultBranch(path: string, branch: string): Promise<void> {
    const cwd = await this.#existingPath(path);
    requireRef(branch, "default branch");
    const args = ["fetch", "--prune", "origin", branch];
    await this.#expect(args, cwd);
  }

  public async status(path: string): Promise<GitWorkspaceStatus> {
    const cwd = await this.#existingPath(path);
    const args = ["status", "--porcelain=v1", "--untracked-files=all"];
    const result = await this.#run(args, cwd);
    if (result.exitCode !== 0) throw new GitCommandError("git", args, cwd, result);
    return { clean: result.stdout.trim().length === 0 };
  }

  public async currentBranch(path: string): Promise<string | undefined> {
    const cwd = await this.#existingPath(path);
    const args = ["symbolic-ref", "--quiet", "--short", "HEAD"];
    const result = await this.#run(args, cwd);
    if (result.exitCode === 0) {
      const branch = result.stdout.trim();
      if (!isSafeRef(branch)) throw new GitError("git returned an invalid current branch");
      return branch;
    }
    if (result.exitCode === 1) return undefined;
    throw new GitCommandError("git", args, cwd, result);
  }

  public async branchExists(path: string, branch: string): Promise<boolean> {
    const cwd = await this.#existingPath(path);
    requireRef(branch, "branch");
    const args = ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`];
    const result = await this.#run(args, cwd);
    if (result.exitCode === 0) return true;
    if (result.exitCode === 1) return false;
    throw new GitCommandError("git", args, cwd, result);
  }

  public async createBranch(path: string, branch: string, startPoint: string): Promise<void> {
    const cwd = await this.#existingPath(path);
    requireRef(branch, "branch");
    requireRef(startPoint, "branch start point");
    const args = ["branch", "--", branch, startPoint];
    await this.#expect(args, cwd);
  }

  public async checkout(path: string, branch: string): Promise<void> {
    const cwd = await this.#existingPath(path);
    requireRef(branch, "branch");
    const args = ["checkout", "--", branch];
    await this.#expect(args, cwd);
  }

  public async resolveCommit(path: string, ref: string): Promise<string> {
    const cwd = await this.#existingPath(path);
    requireRef(ref, "commit reference");
    const args = ["rev-parse", "--verify", `${ref}^{commit}`];
    const result = await this.#run(args, cwd);
    if (result.exitCode !== 0) throw new GitCommandError("git", args, cwd, result);
    const commit = result.stdout.trim();
    if (!/^[0-9a-f]{40}$/iu.test(commit)) {
      throw new GitError("git returned an invalid commit id");
    }
    return commit;
  }

  async #existingPath(path: string): Promise<string> {
    requirePath(path);
    try {
      return await this.#paths.realpath(path);
    } catch (error) {
      throw new GitError("could not resolve git workspace path", { cause: error });
    }
  }

  async #cloneDestination(path: string): Promise<string> {
    requirePath(path);
    try {
      return await this.#paths.realpath(path);
    } catch {
      const parent = dirname(path);
      const name = basename(path);
      if (name === "." || name === "..") throw new GitValidationError("clone path must name a directory");
      try {
        const resolvedParent = await this.#paths.realpath(parent);
        return join(resolvedParent, name);
      } catch (error) {
        throw new GitError("could not resolve clone destination", { cause: error });
      }
    }
  }

  async #run(args: readonly string[], cwd: string): Promise<GitCommandResult> {
    let result: GitCommandResult;
    try {
      result = await this.#runner.run("git", args, { cwd });
    } catch (error) {
      throw new GitError(`git command failed to run in ${cwd}`, { cause: error });
    }
    if (result === null || typeof result !== "object" || !Number.isInteger(result.exitCode)
      || typeof result.stdout !== "string" || typeof result.stderr !== "string") {
      throw new GitError("git command runner returned an invalid result");
    }
    return result;
  }

  async #expect(args: readonly string[], cwd: string): Promise<void> {
    const result = await this.#run(args, cwd);
    if (result.exitCode !== 0) throw new GitCommandError("git", args, cwd, result);
  }
}

export const GitAdapter = GitWorkspaceAdapter;
export const GitClient = GitWorkspaceAdapter;
export function createGitWorkspaceAdapter(runner: GitCommandRunner, options?: { readonly paths?: GitPathResolver }): GitWorkspaceAdapter {
  return new GitWorkspaceAdapter(runner, options);
}

function requirePath(value: string): void {
  requireText(value, "workspace path");
  if (!isAbsolute(value)) throw new GitValidationError("workspace path must be absolute");
}
function requireText(value: string, description: string): void {
  if (typeof value !== "string" || value.trim() === "" || value.includes("\u0000")) {
    throw new GitValidationError(`${description} must be a non-empty string without NUL`);
  }
}
function requireRef(value: string, description: string): void {
  requireText(value, description);
  if (!isSafeRef(value)) throw new GitValidationError(`${description} must be a safe Git ref`);
}
function isSafeRef(value: string): boolean {
  return value.length > 0 && !value.startsWith("-") && !/[\u0000\s~^:?*[\\]/u.test(value)
    && !value.includes("..") && !value.endsWith(".") && !value.endsWith("/");
}
function redactArgs(args: readonly string[]): string[] {
  return args.map((arg, index) => index > 0 && (args[index - 1] === "--" || args[index - 1] === "clone")
    ? redactText(arg) : redactText(arg));
}
function redactText(value: string): string {
  return value
    .replace(/(https?:\/\/)([^/@\s]+):([^/@\s]+)@/giu, "$1[REDACTED]@")
    .replace(/\b(?:gh[pousr]|github_pat|glpat|sk)[-_][A-Za-z0-9_-]+\b/gu, "[REDACTED]")
    .replace(/(token|secret|password|passwd|authorization|api[-_]?key)=([^\s&]+)/giu, "$1=[REDACTED]");
}
