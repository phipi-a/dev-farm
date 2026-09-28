import type { CiStatus, CheckStatus } from "../github/models";
import {
  MergeGateError,
  MergeProviderError,
  MergeValidationError,
  type MergeAuditPort,
  type MergeAuditRecord,
  type MergeBaselinePort,
  type MergeCleanupPort,
  type MergeInspection,
  type MergeLinearPort,
  type MergeRequest,
  type MergeResult,
  type MergeSideEffectResult,
  type MergeLifecycleInput,
  type MergeProviderPort,
  type MergePullRequestRef,
  type MaybePromise,
} from "./models";

export interface MergeWorkflowDependencies {
  readonly provider: MergeProviderPort;
  readonly linear?: MergeLinearPort;
  readonly baseline?: MergeBaselinePort;
  readonly cleanup?: MergeCleanupPort;
  readonly audit?: MergeAuditPort;
}

const SECRET_PATTERNS = [
  /\b(?:ghp|gho|ghs|ghu|github_pat)[-_][A-Za-z0-9_-]+/gu,
  /\bglpat-[A-Za-z0-9_-]+/gu,
  /\bsk-[A-Za-z0-9_-]+/gu,
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/giu,
  /([?&](?:token|access_token|api[_-]?key|password|secret)=)[^&\s]+/giu,
  /\b(token|access[_-]?token|api[_-]?key|password|secret)\s*[:=]\s*[^\s,;]+/giu,
];

/** Redacts configured credentials and common provider credential forms. */
export function redactMergeText(value: string, sensitiveValues: readonly string[] = []): string {
  let result = value;
  for (const secret of sensitiveValues) {
    if (secret.length > 0) result = result.split(secret).join("[REDACTED]");
  }
  for (const pattern of SECRET_PATTERNS) result = result.replace(pattern, (_match, prefix?: string) => `${prefix ?? ""}[REDACTED]`);
  return result.slice(0, 500);
}

function diagnostic(error: unknown, sensitiveValues: readonly string[] = []): string {
  return redactMergeText(error instanceof Error ? error.message : String(error), sensitiveValues);
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.includes("\u0000")) {
    throw new MergeValidationError(`${field} must be a non-empty string without NUL`);
  }
  return value.trim();
}

function validateRequest(request: MergeRequest): void {
  if (request === null || typeof request !== "object") throw new MergeValidationError("merge request is required");
  requiredText(request.workerId, "workerId");
  requiredText(request.repository?.owner, "repository.owner");
  requiredText(request.repository?.name, "repository.name");
  requiredText(request.repository?.defaultBranch, "repository.defaultBranch");
  if (!Number.isSafeInteger(request.pullRequestNumber) || request.pullRequestNumber < 1) {
    throw new MergeValidationError("pullRequestNumber must be a positive safe integer");
  }
  if (request.caller !== "operator" && request.caller !== "controller" && request.caller !== "worker") {
    throw new MergeValidationError("caller must be operator, controller, or worker");
  }
  if (request.issueIdentifier !== undefined) requiredText(request.issueIdentifier, "issueIdentifier");
}

function hasConfirmation(request: MergeRequest): boolean {
  if (request.confirmed === true) return true;
  if (request.confirmationToken !== undefined && request.confirmationToken.trim().length > 0) return true;
  return request.confirmation === true
    || (typeof request.confirmation === "string" && request.confirmation.trim().length > 0);
}

function requiredChecks(ci: CiStatus, explicitChecks: readonly CheckStatus[] | undefined): readonly CheckStatus[] {
  if (ci.requiredChecks !== undefined) return ci.requiredChecks;
  const checks = explicitChecks ?? ci.checks;
  return checks.filter((check) => check.required === true);
}

function assertGates(inspection: MergeInspection): void {
  if (inspection.state !== "open") {
    throw new MergeGateError("pull-request", `pull request is ${inspection.state}; expected open`);
  }
  if (inspection.ci.state !== "success") {
    throw new MergeGateError("ci", `CI is ${inspection.ci.state}; expected success`);
  }
  const failedCheck = requiredChecks(inspection.ci, inspection.checks).find((check) => check.state !== "success");
  if (failedCheck !== undefined) {
    throw new MergeGateError("ci", `required check ${failedCheck.name} is ${failedCheck.state}`);
  }
  if (inspection.reviewState !== "approved") {
    throw new MergeGateError("review", `review state is ${inspection.reviewState ?? "unknown"}; expected approved`);
  }
  if (inspection.mergeable !== true) {
    throw new MergeGateError("conflict", "pull request is not confirmed mergeable");
  }
}

/**
 * Explicit merge coordinator. It owns no provider credentials and performs no
 * branch/PR deletion. Every operation is driven by an injected port.
 */
export class MergeWorkflow {
  readonly #dependencies: MergeWorkflowDependencies;

  public constructor(dependencies: MergeWorkflowDependencies) {
    if (dependencies?.provider === undefined) throw new MergeValidationError("merge provider is required");
    this.#dependencies = dependencies;
  }

  public async merge(request: MergeRequest): Promise<MergeResult> {
    validateRequest(request);
    const safeValues = request.sensitiveValues ?? [];
    const records: MergeAuditRecord[] = [];
    const warnings: string[] = [];
    const ref: MergePullRequestRef = {
      repository: request.repository,
      number: request.pullRequestNumber,
    };

    if (request.caller === "worker") {
      await this.#record(records, warnings, {
        action: "merge",
        outcome: "blocked",
        workerId: request.workerId,
        pullRequestNumber: request.pullRequestNumber,
        details: { gate: "caller", reason: "worker-initiated merge" },
      });
      throw new MergeGateError("caller", "worker-initiated merge is not permitted");
    }
    if (!hasConfirmation(request)) {
      await this.#record(records, warnings, {
        action: "merge",
        outcome: "blocked",
        workerId: request.workerId,
        pullRequestNumber: request.pullRequestNumber,
        details: { gate: "confirmation", reason: "explicit confirmation is required" },
      });
      throw new MergeGateError("confirmation", "explicit merge confirmation is required");
    }

    let inspection: MergeInspection;
    try {
      inspection = await this.#dependencies.provider.inspect(ref);
    } catch (error) {
      const message = diagnostic(error, safeValues);
      await this.#record(records, warnings, {
        action: "inspect",
        outcome: "failed",
        workerId: request.workerId,
        pullRequestNumber: request.pullRequestNumber,
        details: { reason: message },
      });
      throw new MergeProviderError(`could not inspect pull request: ${message}`, { cause: error });
    }

    let outcome: "merged" | "already-merged";
    if (inspection.state === "merged") {
      outcome = "already-merged";
      await this.#record(records, warnings, {
        action: "merge",
        outcome: "observed",
        workerId: request.workerId,
        pullRequestNumber: request.pullRequestNumber,
        details: { state: "already-merged" },
      });
    } else {
      try {
        assertGates(inspection);
      } catch (error) {
        const gateError = error instanceof MergeGateError ? error : new MergeGateError("pull-request", diagnostic(error, safeValues));
        await this.#record(records, warnings, {
          action: "merge",
          outcome: "blocked",
          workerId: request.workerId,
          pullRequestNumber: request.pullRequestNumber,
          details: { gate: gateError.gate, reason: gateError.message },
        });
        throw gateError;
      }
      let providerResult;
      try {
        providerResult = await this.#dependencies.provider.merge({ ...ref, workerId: request.workerId });
      } catch (error) {
        const message = diagnostic(error, safeValues);
        await this.#record(records, warnings, {
          action: "merge",
          outcome: "failed",
          workerId: request.workerId,
          pullRequestNumber: request.pullRequestNumber,
          details: { reason: message },
        });
        throw new MergeProviderError(`provider merge failed: ${message}`, { cause: error });
      }
      if (providerResult.state !== "merged" && providerResult.state !== "already-merged") {
        const error = new MergeProviderError("provider returned an invalid merge state");
        await this.#record(records, warnings, {
          action: "merge",
          outcome: "failed",
          workerId: request.workerId,
          pullRequestNumber: request.pullRequestNumber,
          details: { reason: error.message },
        });
        throw error;
      }
      outcome = providerResult.state;
      await this.#record(records, warnings, {
        action: "merge",
        outcome: "succeeded",
        workerId: request.workerId,
        pullRequestNumber: request.pullRequestNumber,
        details: { state: outcome },
      });
    }

    const lifecycle: MergeLifecycleInput = { ...ref, workerId: request.workerId, outcome };
    const linear = await this.#setLinearDone(request, outcome, records, warnings);
    const baselineRefresh = await this.#runSideEffect(
      "baseline-refresh",
      this.#dependencies.baseline === undefined ? undefined : () => this.#dependencies.baseline!.refresh(lifecycle),
      request,
      records,
      warnings,
    );
    const workerCleanup = await this.#runSideEffect(
      "worker-cleanup",
      this.#dependencies.cleanup === undefined ? undefined : () => this.#dependencies.cleanup!.cleanup(lifecycle),
      request,
      records,
      warnings,
    );

    return {
      outcome,
      pullRequestState: "merged",
      linear,
      baselineRefresh,
      workerCleanup,
      warnings,
      audit: records,
    };
  }

  /** Alias for callers that name the operation executeMerge. */
  public executeMerge(request: MergeRequest): Promise<MergeResult> {
    return this.merge(request);
  }

  async #setLinearDone(
    request: MergeRequest,
    outcome: "merged" | "already-merged",
    records: MergeAuditRecord[],
    warnings: string[],
  ): Promise<MergeSideEffectResult> {
    if (this.#dependencies.linear === undefined || request.issueIdentifier === undefined) {
      return { state: "skipped" };
    }
    const issueIdentifier = requiredText(request.issueIdentifier, "issueIdentifier");
    try {
      await this.#dependencies.linear.setDone({
        workerId: request.workerId,
        issueIdentifier,
        pullRequestNumber: request.pullRequestNumber,
      });
      await this.#record(records, warnings, {
        action: "linear-done",
        outcome: "succeeded",
        workerId: request.workerId,
        pullRequestNumber: request.pullRequestNumber,
        details: { state: "done", outcome },
      });
      return { state: "done" };
    } catch (error) {
      const message = diagnostic(error, request.sensitiveValues);
      warnings.push(`linear-done: ${message}`);
      await this.#record(records, warnings, {
        action: "linear-done",
        outcome: "failed",
        workerId: request.workerId,
        pullRequestNumber: request.pullRequestNumber,
        details: { reason: message },
      });
      return { state: "failed", diagnostic: message };
    }
  }

  async #runSideEffect(
    action: "baseline-refresh" | "worker-cleanup",
    effect: (() => MaybePromise<void>) | undefined,
    request: MergeRequest,
    records: MergeAuditRecord[],
    warnings: string[],
  ): Promise<MergeSideEffectResult> {
    if (effect === undefined) return { state: "skipped" };
    try {
      await effect();
      await this.#record(records, warnings, {
        action,
        outcome: "succeeded",
        workerId: request.workerId,
        pullRequestNumber: request.pullRequestNumber,
        details: { state: "completed" },
      });
      return { state: "done" };
    } catch (error) {
      const message = diagnostic(error, request.sensitiveValues);
      warnings.push(`${action}: ${message}`);
      await this.#record(records, warnings, {
        action,
        outcome: "failed",
        workerId: request.workerId,
        pullRequestNumber: request.pullRequestNumber,
        details: { reason: message },
      });
      return { state: "failed", diagnostic: message };
    }
  }

  async #record(records: MergeAuditRecord[], warnings: string[], record: MergeAuditRecord): Promise<void> {
    records.push(record);
    try {
      await this.#dependencies.audit?.record(record);
    } catch (error) {
      warnings.push(`audit: ${diagnostic(error)}`);
    }
  }
}

export function createMergeWorkflow(dependencies: MergeWorkflowDependencies): MergeWorkflow {
  return new MergeWorkflow(dependencies);
}
