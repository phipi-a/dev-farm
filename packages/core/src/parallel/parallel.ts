import type { LinearIssue } from "../linear/types.ts";

/** Issues are loaded through this seam so coordination does not own Linear I/O. */
export interface ParallelIssueSource {
  listIssues(input: {
    readonly teamId: string;
    readonly issueIdentifiers?: readonly string[];
  }): Promise<readonly LinearIssue[]>;
}

/** Limits passed unchanged to the isolated worker start boundary. */
export interface ParallelResourceLimits {
  readonly memoryBytes?: number;
  readonly cpuCount?: number;
  readonly pidsLimit?: number;
  readonly networkMode?: string;
  readonly user?: string | number;
}

/** One start request; the boundary is responsible for applying these limits. */
export interface ParallelWorkerStartRequest {
  readonly issue: LinearIssue;
  /** Stable and issue-unique within one coordinator integration. */
  readonly operationId: string;
  readonly resourceLimits: Readonly<ParallelResourceLimits>;
}

/** Injectable boundary for one isolated WorkerOrchestrator operation. */
export interface ParallelWorkerStartBoundary<TResult = unknown> {
  start(request: ParallelWorkerStartRequest): Promise<TResult>;
}

export interface ParallelCoordinatorDependencies<TResult = unknown> {
  readonly issues: ParallelIssueSource;
  readonly worker: ParallelWorkerStartBoundary<TResult>;
  readonly onEvent?: (event: ParallelCoordinatorEvent<TResult>) => void | Promise<void>;
}

export interface ParallelCoordinatorOptions {
  /** Maximum number of start-boundary operations in flight at once. */
  readonly maxConcurrency: number;
  readonly resourceLimits?: ParallelResourceLimits;
}

export interface ParallelCoordinatorRequest {
  readonly teamId: string;
  readonly issueIdentifiers?: readonly string[];
}

export type ParallelSkipReason = "not-todo" | "not-in-team" | "not-requested";

export interface ParallelSkippedIssue {
  readonly issue: LinearIssue;
  readonly reason: ParallelSkipReason;
}

export type ParallelWorkerResult<TResult> =
  | {
      readonly issue: LinearIssue;
      readonly operationId: string;
      readonly status: "succeeded";
      readonly value: TResult;
    }
  | {
      readonly issue: LinearIssue;
      readonly operationId: string;
      readonly status: "failed";
      readonly error: unknown;
    };

export interface ParallelSummary {
  readonly discovered: number;
  readonly selected: number;
  readonly skipped: number;
  readonly started: number;
  readonly succeeded: number;
  readonly failed: number;
}

export interface ParallelCoordinatorResult<TResult> {
  readonly teamId: string;
  readonly selected: readonly LinearIssue[];
  readonly skipped: readonly ParallelSkippedIssue[];
  readonly results: readonly ParallelWorkerResult<TResult>[];
  readonly summary: ParallelSummary;
}

export type ParallelCoordinatorEvent<TResult> =
  | { readonly type: "started"; readonly issue: LinearIssue; readonly operationId: string }
  | {
      readonly type: "succeeded";
      readonly result: Extract<ParallelWorkerResult<TResult>, { status: "succeeded" }>;
    }
  | {
      readonly type: "failed";
      readonly result: Extract<ParallelWorkerResult<TResult>, { status: "failed" }>;
    }
  | { readonly type: "skipped"; readonly issue: LinearIssue; readonly reason: ParallelSkipReason }
  | { readonly type: "summary"; readonly summary: ParallelSummary };

function requiredText(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.includes("\u0000")) {
    throw new TypeError(`${name} must be a non-empty string without NUL`);
  }
  return value.trim();
}

function validatePositiveInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return value as number;
}

function validateResourceLimits(limits: ParallelResourceLimits): Readonly<ParallelResourceLimits> {
  for (const [name, value] of [
    ["memoryBytes", limits.memoryBytes],
    ["cpuCount", limits.cpuCount],
    ["pidsLimit", limits.pidsLimit],
  ] as const) {
    if (value !== undefined) validatePositiveInteger(value, `resourceLimits.${name}`);
  }
  if (limits.networkMode !== undefined)
    requiredText(limits.networkMode, "resourceLimits.networkMode");
  if (
    limits.user !== undefined &&
    (typeof limits.user === "string"
      ? limits.user.trim().length === 0
      : !Number.isSafeInteger(limits.user) || limits.user < 0)
  ) {
    throw new TypeError(
      "resourceLimits.user must be a non-empty string or a non-negative safe integer",
    );
  }
  return Object.freeze({ ...limits });
}

function operationIdFor(issue: LinearIssue): string {
  const slug = issue.identifier
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  return `parallel-${slug || "issue"}-${issue.id}`;
}

function uniqueIssues(issues: readonly LinearIssue[]): readonly LinearIssue[] {
  const seen = new Set<string>();
  return issues.filter((issue) => {
    if (seen.has(issue.identifier)) return false;
    seen.add(issue.identifier);
    return true;
  });
}

/**
 * Selects Todo tickets and schedules independent worker operations with a
 * deterministic, injectable concurrency boundary.
 */
export class ParallelCoordinator<TResult = unknown> {
  readonly #dependencies: ParallelCoordinatorDependencies<TResult>;
  readonly #maxConcurrency: number;
  readonly #resourceLimits: Readonly<ParallelResourceLimits>;

  public constructor(
    dependencies: ParallelCoordinatorDependencies<TResult>,
    options: ParallelCoordinatorOptions,
  ) {
    if (dependencies === null || typeof dependencies !== "object")
      throw new TypeError("coordinator dependencies are required");
    if (typeof dependencies.issues?.listIssues !== "function")
      throw new TypeError("an issue source is required");
    if (typeof dependencies.worker?.start !== "function")
      throw new TypeError("a worker start boundary is required");
    this.#dependencies = dependencies;
    this.#maxConcurrency = validatePositiveInteger(options?.maxConcurrency, "maxConcurrency");
    this.#resourceLimits = validateResourceLimits(options?.resourceLimits ?? {});
  }

  public async run(
    request: ParallelCoordinatorRequest,
  ): Promise<ParallelCoordinatorResult<TResult>> {
    const teamId = requiredText(request?.teamId, "teamId");
    const issueIdentifiers = request.issueIdentifiers?.map((identifier, index) =>
      requiredText(identifier, `issueIdentifiers[${index}]`),
    );
    const requested = issueIdentifiers === undefined ? undefined : new Set(issueIdentifiers);
    const discovered = uniqueIssues(
      await this.#dependencies.issues.listIssues({ teamId, issueIdentifiers }),
    );
    const skipped: ParallelSkippedIssue[] = [];
    const selected: LinearIssue[] = [];

    for (const issue of discovered) {
      if (issue.teamId !== teamId) {
        skipped.push({ issue, reason: "not-in-team" });
      } else if (requested !== undefined && !requested.has(issue.identifier)) {
        skipped.push({ issue, reason: "not-requested" });
      } else if (issue.status.name !== "Todo") {
        skipped.push({ issue, reason: "not-todo" });
      } else {
        selected.push(issue);
      }
    }

    for (const issue of skipped)
      await this.#emit({ type: "skipped", issue: issue.issue, reason: issue.reason });

    const results: Array<ParallelWorkerResult<TResult> | undefined> = new Array(selected.length);
    let next = 0;
    const workerCount = Math.min(this.#maxConcurrency, selected.length);
    await Promise.all(
      Array.from({ length: workerCount }, async () => {
        while (true) {
          const index = next;
          next += 1;
          const issue = selected[index];
          if (issue === undefined) return;
          const operationId = operationIdFor(issue);
          await this.#emit({ type: "started", issue, operationId });
          try {
            const value = await this.#dependencies.worker.start({
              issue,
              operationId,
              resourceLimits: this.#resourceLimits,
            });
            const result: ParallelWorkerResult<TResult> = {
              issue,
              operationId,
              status: "succeeded",
              value,
            };
            results[index] = result;
            await this.#emit({ type: "succeeded", result });
          } catch (error) {
            const result: ParallelWorkerResult<TResult> = {
              issue,
              operationId,
              status: "failed",
              error,
            };
            results[index] = result;
            await this.#emit({ type: "failed", result });
          }
        }
      }),
    );

    const completed = results.filter(
      (result): result is ParallelWorkerResult<TResult> => result !== undefined,
    );
    const summary: ParallelSummary = {
      discovered: discovered.length,
      selected: selected.length,
      skipped: skipped.length,
      started: completed.length,
      succeeded: completed.filter((result) => result.status === "succeeded").length,
      failed: completed.filter((result) => result.status === "failed").length,
    };
    await this.#emit({ type: "summary", summary });
    return { teamId, selected, skipped, results: completed, summary };
  }

  async #emit(event: ParallelCoordinatorEvent<TResult>): Promise<void> {
    try {
      await this.#dependencies.onEvent?.(event);
    } catch {
      // Observability must not turn an independent worker result into a failure.
    }
  }
}

export function createParallelCoordinator<TResult = unknown>(
  dependencies: ParallelCoordinatorDependencies<TResult>,
  options: ParallelCoordinatorOptions,
): ParallelCoordinator<TResult> {
  return new ParallelCoordinator(dependencies, options);
}
