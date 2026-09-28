import type { DockerContainerInspection } from "../docker/docker.ts";
import { redactSecrets } from "../events/redaction.ts";
import { canTransition, type WorkerRecord, type WorkerState } from "../state/models.ts";

/** The small Docker surface used by cleanup; no shell commands are constructed here. */
export interface CleanupDockerPort {
  inspectContainer(container: string): Promise<DockerContainerInspection>;
  stopContainer(container: string): Promise<void>;
  removeContainer(container: string, options?: { readonly force?: boolean }): Promise<void>;
  /** A dedicated kill is required after the graceful stop deadline. */
  killContainer?(container: string): Promise<void>;
  removeNetwork?(network: string): Promise<void>;
  removeVolume?(volume: string): Promise<void>;
}

export interface CleanupProcessPort {
  stop(processId: number): Promise<void>;
  kill(processId: number): Promise<void>;
}

export interface CleanupPortPort {
  release(workerId: string): unknown | Promise<unknown>;
}

export interface CleanupStatePort {
  get(workerId: string): WorkerRecord | undefined;
  transition(workerId: string, state: WorkerState, options?: {
    readonly actor?: string;
    readonly reason?: string;
    readonly providerEvidence?: string;
    readonly expectedState?: WorkerState;
    readonly at?: string | Date;
  }): WorkerRecord;
}

/** Injectable time makes timeout behavior deterministic without sleeping in tests. */
export interface CleanupClock {
  now(): Date;
  sleep(milliseconds: number): Promise<void>;
}

export interface CleanupRequest {
  readonly workerId: string;
  readonly containerId?: string;
  readonly networkName?: string;
  readonly volumeNames?: readonly string[];
  /** Explicitly supplied secrets are never included in result errors or warnings. */
  readonly secrets?: readonly string[];
}

export interface DestroyConfirmation {
  readonly confirm?: boolean;
  readonly confirmDestroy?: (preview: DestroyPreview) => boolean | Promise<boolean>;
}

export interface CleanupWarning {
  readonly kind: "branch" | "commit" | "pull-request";
  readonly message: string;
}

export interface DestroyPreview {
  readonly workerId: string;
  readonly warnings: readonly CleanupWarning[];
  readonly hasTrackedGitData: boolean;
}

export interface CleanupIssue {
  readonly resource: string;
  readonly message: string;
}

export interface CleanupResult {
  readonly operation: "stop" | "destroy";
  readonly workerId: string;
  readonly state: WorkerState;
  readonly done: boolean;
  readonly warnings: readonly CleanupWarning[];
  readonly cleaned: readonly string[];
  readonly issues: readonly CleanupIssue[];
  readonly alreadyComplete: boolean;
}

export interface CleanupOptions {
  readonly docker: CleanupDockerPort;
  readonly state: CleanupStatePort;
  readonly process?: CleanupProcessPort;
  readonly ports?: CleanupPortPort;
  readonly clock?: CleanupClock;
  readonly gracefulTimeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly confirmDestroy?: (preview: DestroyPreview) => boolean | Promise<boolean>;
}

export class CleanupError extends Error {
  public constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "CleanupError";
  }
}

export class CleanupValidationError extends CleanupError {
  public constructor(message: string) {
    super(message);
    this.name = "CleanupValidationError";
  }
}

export class DestroyConfirmationRequiredError extends CleanupError {
  public constructor() {
    super("destroy requires explicit confirmation");
    this.name = "DestroyConfirmationRequiredError";
  }
}

const DEFAULT_GRACEFUL_TIMEOUT_MS = 10_000;
const DEFAULT_POLL_INTERVAL_MS = 100;

const defaultClock: CleanupClock = {
  now: () => new Date(),
  sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
};

function validateRequest(request: CleanupRequest): void {
  if (request === null || typeof request !== "object" || typeof request.workerId !== "string" || request.workerId.trim() === "") {
    throw new CleanupValidationError("workerId is required");
  }
  for (const value of request.volumeNames ?? []) {
    if (typeof value !== "string" || value.trim() === "") throw new CleanupValidationError("volume names must be non-empty strings");
  }
}

function errorMessage(error: unknown, secrets: readonly string[]): string {
  const message = error instanceof Error ? error.message : String(error);
  return String(redactSecrets(message, { secrets }));
}

function isMissing(error: unknown): boolean {
  if (error !== null && typeof error === "object" && "name" in error && (error as { name?: unknown }).name === "DockerNotFoundError") return true;
  return /(?:not found|does not exist|no such)/iu.test(errorMessage(error, []));
}

function issue(resource: string, error: unknown, secrets: readonly string[]): CleanupIssue {
  return { resource: errorMessage(resource, secrets), message: errorMessage(error, secrets) };
}

function cleanedResource(resource: string, secrets: readonly string[]): string {
  return errorMessage(resource, secrets);
}

function workerOrThrow(state: CleanupStatePort, workerId: string): WorkerRecord {
  const worker = state.get(workerId);
  if (worker === undefined) throw new CleanupError(`worker ${workerId} was not found`);
  return worker;
}

function warningsFor(worker: WorkerRecord, request: CleanupRequest): readonly CleanupWarning[] {
  const secrets = request.secrets ?? [];
  const warnings: CleanupWarning[] = [];
  if (worker.branch !== undefined) warnings.push({ kind: "branch", message: errorMessage(`destroy will not delete branch ${worker.branch}`, secrets) });
  if (worker.commitSha !== undefined) warnings.push({ kind: "commit", message: errorMessage(`destroy will not delete commit ${worker.commitSha}`, secrets) });
  if (worker.pullRequestNumber !== undefined) {
    warnings.push({ kind: "pull-request", message: errorMessage(`destroy will not delete pull request #${worker.pullRequestNumber}`, secrets) });
  }
  // Request values are intentionally not used as deletion targets. This makes
  // it impossible for cleanup to acquire branch/PR deletion capability later.
  void request;
  return warnings;
}

/**
 * Stops and destroys worker-owned runtime resources. Git branches, commits,
 * and pull requests are warning-only metadata: this class has no deletion port
 * for them by design.
 */
export class CleanupService {
  readonly #docker: CleanupDockerPort;
  readonly #state: CleanupStatePort;
  readonly #process: CleanupProcessPort | undefined;
  readonly #ports: CleanupPortPort | undefined;
  readonly #clock: CleanupClock;
  readonly #gracefulTimeoutMs: number;
  readonly #pollIntervalMs: number;
  readonly #confirmDestroy: ((preview: DestroyPreview) => boolean | Promise<boolean>) | undefined;

  public constructor(options: CleanupOptions) {
    if (options === null || typeof options !== "object") throw new CleanupValidationError("cleanup options are required");
    if (options.docker === undefined || options.state === undefined) throw new CleanupValidationError("docker and state ports are required");
    this.#docker = options.docker;
    this.#state = options.state;
    this.#process = options.process;
    this.#ports = options.ports;
    this.#clock = options.clock ?? defaultClock;
    this.#gracefulTimeoutMs = options.gracefulTimeoutMs ?? DEFAULT_GRACEFUL_TIMEOUT_MS;
    this.#pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    if (!Number.isFinite(this.#gracefulTimeoutMs) || this.#gracefulTimeoutMs < 0) throw new CleanupValidationError("gracefulTimeoutMs must be non-negative");
    if (!Number.isFinite(this.#pollIntervalMs) || this.#pollIntervalMs <= 0) throw new CleanupValidationError("pollIntervalMs must be positive");
    this.#confirmDestroy = options.confirmDestroy;
  }

  /** Returns warnings before any destroy side effect or confirmation prompt. */
  public previewDestroy(request: CleanupRequest): DestroyPreview {
    validateRequest(request);
    const worker = workerOrThrow(this.#state, request.workerId);
    const warnings = warningsFor(worker, request);
    return { workerId: worker.workerId, warnings, hasTrackedGitData: warnings.length > 0 };
  }

  public async stop(request: CleanupRequest): Promise<CleanupResult> {
    validateRequest(request);
    const worker = workerOrThrow(this.#state, request.workerId);
    if (worker.state === "destroyed" || worker.state === "stopped") {
      return { operation: "stop", workerId: worker.workerId, state: worker.state, done: true, warnings: [], cleaned: [], issues: [], alreadyComplete: true };
    }
    const outcome = await this.#stopResources(worker, request);
    let state: WorkerState = worker.state;
    if (outcome.issues.length === 0) {
      try {
        if (canTransition(worker.state, "stopped")) {
          state = this.#state.transition(worker.workerId, "stopped", {
            actor: "cleanup",
            reason: "worker runtime resources stopped",
            expectedState: worker.state,
            at: this.#clock.now(),
          }).state;
        } else {
          outcome.issues.push({ resource: "state", message: `cannot transition ${worker.state} to stopped` });
        }
      } catch (error) {
        outcome.issues.push(issue("state", error, request.secrets ?? []));
      }
    }
    return { operation: "stop", workerId: worker.workerId, state, done: outcome.issues.length === 0, warnings: [], ...outcome, alreadyComplete: false };
  }

  public async destroy(request: CleanupRequest, confirmation: DestroyConfirmation = {}): Promise<CleanupResult> {
    validateRequest(request);
    const preview = this.previewDestroy(request);
    const confirm = confirmation.confirm === true
      || confirmation.confirmDestroy !== undefined
      || this.#confirmDestroy !== undefined;
    if (!confirm) throw new DestroyConfirmationRequiredError();
    const accepted = confirmation.confirmDestroy !== undefined
      ? await confirmation.confirmDestroy(preview)
      : this.#confirmDestroy !== undefined ? await this.#confirmDestroy(preview) : confirmation.confirm === true;
    if (!accepted) throw new DestroyConfirmationRequiredError();

    const worker = workerOrThrow(this.#state, request.workerId);
    if (worker.state === "destroyed") {
      return { operation: "destroy", workerId: worker.workerId, state: "destroyed", done: true, warnings: preview.warnings, cleaned: [], issues: [], alreadyComplete: true };
    }
    const outcome = await this.#stopResources(worker, request);
    await this.#destroyResources(request, outcome, request.secrets ?? []);
    let state: WorkerState = worker.state;
    if (outcome.issues.length === 0) {
      try {
        if (canTransition(worker.state, "stopped")) {
          state = this.#state.transition(worker.workerId, "stopped", {
            actor: "cleanup",
            reason: "worker runtime resources stopped before destroy",
            expectedState: worker.state,
            at: this.#clock.now(),
          }).state;
        }
        if (state !== "destroyed") {
          state = this.#state.transition(worker.workerId, "destroyed", {
            actor: "cleanup",
            reason: "worker resources destroyed",
            expectedState: state,
            at: this.#clock.now(),
          }).state;
        }
      } catch (error) {
        outcome.issues.push(issue("state", error, request.secrets ?? []));
      }
    }
    return { operation: "destroy", workerId: worker.workerId, state, done: outcome.issues.length === 0, warnings: preview.warnings, ...outcome, alreadyComplete: false };
  }

  async #stopResources(worker: WorkerRecord, request: CleanupRequest): Promise<{ cleaned: string[]; issues: CleanupIssue[] }> {
    const cleaned: string[] = [];
    const issues: CleanupIssue[] = [];
    const secrets = request.secrets ?? [];
    if (worker.processId !== undefined && this.#process !== undefined) {
      try { await this.#process.stop(worker.processId); cleaned.push(cleanedResource(`process:${worker.processId}`, secrets)); }
      catch (error) {
        try { await this.#process.kill(worker.processId); cleaned.push(cleanedResource(`process:${worker.processId}:killed`, secrets)); }
        catch (killError) { issues.push(issue(`process:${worker.processId}`, killError, secrets)); }
      }
    }
    if (request.containerId !== undefined) {
      const container = await this.#stopContainer(request.containerId, secrets, cleaned, issues);
      if (!container) { /* missing containers are already stopped */ }
    }
    if (this.#ports !== undefined) {
      try { await this.#ports.release(worker.workerId); cleaned.push(cleanedResource(`port:${worker.workerId}`, secrets)); }
      catch (error) { if (!isMissing(error)) issues.push(issue(`port:${worker.workerId}`, error, secrets)); }
    }
    return { cleaned, issues };
  }

  async #stopContainer(container: string, secrets: readonly string[], cleaned: string[], issues: CleanupIssue[]): Promise<boolean> {
    let inspection: DockerContainerInspection;
    try { inspection = await this.#docker.inspectContainer(container); }
    catch (error) {
      if (isMissing(error)) return false;
      issues.push(issue(`container:${container}:inspect`, error, secrets));
      return false;
    }
    if (!inspection.state.running) { cleaned.push(cleanedResource(`container:${container}:already-stopped`, secrets)); return true; }
    try { await this.#docker.stopContainer(container); }
    catch (error) { if (!isMissing(error)) issues.push(issue(`container:${container}:stop`, error, secrets)); }

    const attempts = Math.max(1, Math.ceil(this.#gracefulTimeoutMs / this.#pollIntervalMs));
    for (let attempt = 0; attempt <= attempts; attempt += 1) {
      try {
        inspection = await this.#docker.inspectContainer(container);
        if (!inspection.state.running) { cleaned.push(cleanedResource(`container:${container}:stopped`, secrets)); return true; }
      } catch (error) {
        if (isMissing(error)) return false;
        issues.push(issue(`container:${container}:inspect`, error, secrets));
        return false;
      }
      if (attempt === attempts) break;
      await this.#clock.sleep(Math.min(this.#pollIntervalMs, this.#gracefulTimeoutMs));
    }
    if (this.#docker.killContainer === undefined) {
      issues.push({ resource: `container:${container}:kill`, message: "Docker kill operation is unavailable" });
      return false;
    }
    try {
      await this.#docker.killContainer(container);
      cleaned.push(cleanedResource(`container:${container}:killed`, secrets));
      return true;
    } catch (error) {
      if (isMissing(error)) return false;
      issues.push(issue(`container:${container}:kill`, error, secrets));
      return false;
    }
  }

  async #destroyResources(request: CleanupRequest, outcome: { cleaned: string[]; issues: CleanupIssue[] }, secrets: readonly string[]): Promise<void> {
    if (request.containerId !== undefined) {
      try { await this.#docker.removeContainer(request.containerId, { force: true }); outcome.cleaned.push(cleanedResource(`container:${request.containerId}:removed`, secrets)); }
      catch (error) { if (!isMissing(error)) outcome.issues.push(issue(`container:${request.containerId}:remove`, error, secrets)); }
    }
    if (request.networkName !== undefined) {
      if (this.#docker.removeNetwork === undefined) {
        outcome.issues.push({ resource: `network:${request.networkName}`, message: "Docker network removal is unavailable" });
      } else {
        try { await this.#docker.removeNetwork(request.networkName); outcome.cleaned.push(cleanedResource(`network:${request.networkName}`, secrets)); }
        catch (error) { if (!isMissing(error)) outcome.issues.push(issue(`network:${request.networkName}`, error, secrets)); }
      }
    }
    for (const volume of request.volumeNames ?? []) {
      if (this.#docker.removeVolume === undefined) {
        outcome.issues.push({ resource: `volume:${volume}`, message: "Docker volume removal is unavailable" });
      } else {
        try { await this.#docker.removeVolume(volume); outcome.cleaned.push(cleanedResource(`volume:${volume}`, secrets)); }
        catch (error) { if (!isMissing(error)) outcome.issues.push(issue(`volume:${volume}`, error, secrets)); }
      }
    }
  }
}

/** Function form for hosts that do not need to retain a service instance. */
export function createCleanupService(options: CleanupOptions): CleanupService {
  return new CleanupService(options);
}

/** Alias kept short for lifecycle composition code. */
export const WorkerCleanup = CleanupService;
export const CleanupManager = CleanupService;
export const WorkerCleanupService = CleanupService;

export function stopWorker(service: CleanupService, request: CleanupRequest): Promise<CleanupResult> {
  return service.stop(request);
}

export function destroyWorker(
  service: CleanupService,
  request: CleanupRequest,
  confirmation: DestroyConfirmation = {},
): Promise<CleanupResult> {
  return service.destroy(request, confirmation);
}
