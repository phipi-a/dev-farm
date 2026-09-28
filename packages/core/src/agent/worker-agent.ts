/** A ticket given to exactly one worker-agent run. */
export interface WorkerIssue {
  readonly identifier: string;
  readonly title: string;
  readonly description?: string;
}

/** Repository identity accepted by the worker prompt boundary. */
export interface WorkerRepository {
  readonly owner: string;
  readonly name: string;
  readonly url?: string;
}

export interface WorkerAgentRequest {
  readonly issue: WorkerIssue;
  readonly repository: WorkerRepository | string;
  readonly branch: string;
  readonly definitionOfDone: readonly string[];
  readonly securityRules: readonly string[];
  readonly workspacePath: string;
  /** A bounded run timeout. A caller must opt into a different timeout explicitly. */
  readonly timeoutMs?: number;
  /** Values supplied by a credential-aware caller and removed from all output. */
  readonly sensitiveValues?: readonly string[];
}

export interface WorkerAgentProcessSpec {
  readonly command: "pi";
  readonly args: readonly string[];
  readonly cwd: string;
  readonly tmuxWindow: "pi";
}

export interface WorkerProcessExit {
  readonly exitCode: number | null;
  readonly signal?: string;
}

/** Process handle returned by the host's Pi/tmux adapter. */
export interface WorkerProcess {
  wait(): Promise<WorkerProcessExit>;
  abort(reason?: string): Promise<void>;
}

/** Starts Pi inside the requested tmux window; it does not grant merge authority. */
export interface WorkerAgentProcessPort {
  start(spec: WorkerAgentProcessSpec): Promise<WorkerProcess>;
}

/** tmux observations are deliberately separate from process control. */
export interface WorkerAgentTmuxPort {
  ensureWindow(window: "pi"): Promise<void>;
  captureLastOutput(window: "pi"): Promise<string>;
}

/** Injectable time boundary; tests need not use wall-clock timers. */
export interface WorkerAgentClockPort {
  now(): number;
  sleep(milliseconds: number): Promise<void>;
}

export type WorkerAgentSignal =
  | {
      readonly type: "command";
      readonly at: number;
      readonly command: string;
      readonly args: readonly string[];
      readonly window: "pi";
    }
  | { readonly type: "heartbeat"; readonly at: number }
  | { readonly type: "last-output"; readonly at: number; readonly output: string }
  | {
      readonly type: "exit";
      readonly at: number;
      readonly exitCode: number | null;
      readonly signal?: string;
    };

export type WorkerAgentFailureKind = "timeout" | "aborted" | "process" | "start";

export interface WorkerAgentFailure {
  readonly kind: WorkerAgentFailureKind;
  readonly message: string;
}

export interface WorkerAgentResult {
  readonly workerId: string;
  readonly issueIdentifier: string;
  readonly status: "completed" | "failed";
  readonly signals: readonly WorkerAgentSignal[];
  readonly failure?: WorkerAgentFailure;
}

/** A started run that can be observed or explicitly aborted by its owner. */
export interface WorkerAgentRun {
  readonly workerId: string;
  readonly issueIdentifier: string;
  readonly prompt: string;
  readonly signals: readonly WorkerAgentSignal[];
  wait(): Promise<WorkerAgentResult>;
  abort(): Promise<WorkerAgentResult>;
}

export class WorkerAgentError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "WorkerAgentError";
  }
}

export class WorkerAgentValidationError extends WorkerAgentError {
  public constructor(message: string) {
    super(message);
    this.name = "WorkerAgentValidationError";
  }
}

export class WorkerAgentBusyError extends WorkerAgentError {
  public constructor(workerId: string, issueIdentifier: string) {
    super(`worker ${workerId} is already assigned to issue ${issueIdentifier}`);
    this.name = "WorkerAgentBusyError";
  }
}

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_TIMEOUT_MESSAGE = "Pi worker exceeded its timeout";

function requiredText(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.includes("\u0000")) {
    throw new WorkerAgentValidationError(`${name} must be a non-empty string without NUL`);
  }
  return value.trim();
}

function validateList(values: unknown, name: string): readonly string[] {
  if (!Array.isArray(values) || values.length === 0) {
    throw new WorkerAgentValidationError(`${name} must contain at least one rule`);
  }
  return values.map((value, index) => requiredText(value, `${name}[${index}]`));
}

function repositoryText(repository: WorkerRepository | string): string {
  if (typeof repository === "string") return requiredText(repository, "repository");
  if (repository === null || typeof repository !== "object") {
    throw new WorkerAgentValidationError("repository is required");
  }
  const owner = requiredText(repository.owner, "repository.owner");
  const name = requiredText(repository.name, "repository.name");
  const url = repository.url === undefined ? undefined : requiredText(repository.url, "repository.url");
  return url === undefined ? `${owner}/${name}` : `${owner}/${name} (${url})`;
}

function validateRequest(request: WorkerAgentRequest): WorkerAgentRequest {
  if (request === null || typeof request !== "object") {
    throw new WorkerAgentValidationError("worker-agent request is required");
  }
  if (request.issue === null || typeof request.issue !== "object") {
    throw new WorkerAgentValidationError("issue is required");
  }
  const issue: WorkerIssue = {
    identifier: requiredText(request.issue.identifier, "issue.identifier"),
    title: requiredText(request.issue.title, "issue.title"),
    ...(request.issue.description === undefined
      ? {}
      : { description: requiredText(request.issue.description, "issue.description") }),
  };
  const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new WorkerAgentValidationError("timeoutMs must be a positive safe integer");
  }
  const sensitiveValues = (request.sensitiveValues ?? []).map((value, index) =>
    requiredText(value, `sensitiveValues[${index}]`),
  );
  return {
    issue,
    repository: repositoryText(request.repository),
    branch: requiredText(request.branch, "branch"),
    definitionOfDone: validateList(request.definitionOfDone, "definitionOfDone"),
    securityRules: validateList(request.securityRules, "securityRules"),
    workspacePath: requiredText(request.workspacePath, "workspacePath"),
    timeoutMs,
    sensitiveValues,
  };
}

/** Redacts common credentials before text is put in a prompt or diagnostic. */
export function redactWorkerText(value: string, sensitiveValues: readonly string[] = []): string {
  let result = value;
  for (const secret of sensitiveValues) result = result.replaceAll(secret, "[REDACTED]");
  return result
    .replace(/\b(?:ghp|gho|ghs|ghu|github_pat)[-_][A-Za-z0-9_-]+/gu, "[REDACTED]")
    .replace(/\bglpat-[A-Za-z0-9_-]+/gu, "[REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]+/gu, "[REDACTED]")
    .replace(/\bxox[baprs]-[A-Za-z0-9-]+/gu, "[REDACTED]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/giu, "Bearer [REDACTED]")
    .replace(/([?&](?:token|access_token|api[_-]?key|password|secret)=)[^&\s]+/giu, "$1[REDACTED]")
    .replace(/\b(token|access[_-]?token|api[_-]?key|password|secret)\s*[:=]\s*[^\s,;]+/giu, "$1: [REDACTED]");
}

function bulletList(values: readonly string[], sensitiveValues: readonly string[]): string {
  return values.map((value) => `- ${redactWorkerText(value, sensitiveValues)}`).join("\n");
}

/** Build the complete, ticket-scoped instruction sent to Pi. */
export function buildWorkerPrompt(request: WorkerAgentRequest): string {
  const input = validateRequest(request);
  const sensitiveValues = input.sensitiveValues ?? [];
  const description = input.issue.description === undefined
    ? "(no description supplied)"
    : redactWorkerText(input.issue.description, sensitiveValues);
  return [
    "You are the implementation worker for exactly one ticket.",
    "Do not work on any other issue, branch, or workspace.",
    "",
    "## Ticket",
    `Identifier: ${redactWorkerText(input.issue.identifier, sensitiveValues)}`,
    `Title: ${redactWorkerText(input.issue.title, sensitiveValues)}`,
    `Description: ${description}`,
    "",
    "## Repository and branch",
    `Repository: ${redactWorkerText(input.repository as string, sensitiveValues)}`,
    `Branch: ${redactWorkerText(input.branch, sensitiveValues)}`,
    `Workspace: ${redactWorkerText(input.workspacePath, sensitiveValues)}`,
    "",
    "## Definition of done",
    bulletList(input.definitionOfDone, sensitiveValues),
    "",
    "## Security rules",
    bulletList(input.securityRules, sensitiveValues),
    "",
    "## Authority",
    "Make changes only for this ticket. Do not merge, enable auto-merge, or modify protected/base branches.",
    "Report command, heartbeat, exit, and last-output evidence to the worker boundary.",
  ].join("\n");
}

function shellArgument(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class Run implements WorkerAgentRun {
  readonly workerId: string;
  readonly issueIdentifier: string;
  readonly prompt: string;
  readonly #signals: WorkerAgentSignal[];
  readonly #finish: Promise<WorkerAgentResult>;
  readonly #abortProcess: () => Promise<WorkerAgentResult>;

  public constructor(
    workerId: string,
    issueIdentifier: string,
    prompt: string,
    signals: WorkerAgentSignal[],
    finish: Promise<WorkerAgentResult>,
    abortProcess: () => Promise<WorkerAgentResult>,
  ) {
    this.workerId = workerId;
    this.issueIdentifier = issueIdentifier;
    this.prompt = prompt;
    this.#signals = signals;
    this.#finish = finish;
    this.#abortProcess = abortProcess;
  }

  get signals(): readonly WorkerAgentSignal[] {
    return this.#signals;
  }

  wait(): Promise<WorkerAgentResult> { return this.#finish; }
  abort(): Promise<WorkerAgentResult> { return this.#abortProcess(); }
}

/**
 * Minimal worker boundary for Pi. The host owns the tmux/process implementation;
 * this class owns ticket scope, prompt construction, signals, timeout and failure
 * classification. There is intentionally no merge operation on this API.
 */
export class WorkerAgent {
  readonly #workerId: string;
  readonly #process: WorkerAgentProcessPort;
  readonly #tmux: WorkerAgentTmuxPort;
  readonly #clock: WorkerAgentClockPort;
  #activeIssue: string | undefined;

  public constructor(options: {
    readonly workerId: string;
    readonly process: WorkerAgentProcessPort;
    readonly tmux: WorkerAgentTmuxPort;
    readonly clock: WorkerAgentClockPort;
  }) {
    if (options === null || typeof options !== "object") {
      throw new WorkerAgentValidationError("worker-agent options are required");
    }
    this.#workerId = requiredText(options.workerId, "workerId");
    if (options.process === undefined || options.tmux === undefined || options.clock === undefined) {
      throw new WorkerAgentValidationError("process, tmux, and clock ports are required");
    }
    this.#process = options.process;
    this.#tmux = options.tmux;
    this.#clock = options.clock;
  }

  public async start(request: WorkerAgentRequest): Promise<WorkerAgentRun> {
    const input = validateRequest(request);
    if (this.#activeIssue !== undefined) throw new WorkerAgentBusyError(this.#workerId, this.#activeIssue);
    this.#activeIssue = input.issue.identifier;
    const prompt = buildWorkerPrompt(input);
    const command = "pi";
    const args = ["--prompt", prompt];
    const signals: WorkerAgentSignal[] = [{
      type: "command",
      at: this.#clock.now(),
      command,
      args: ["--prompt", redactWorkerText(prompt, input.sensitiveValues)],
      window: "pi",
    }];
    try {
      await this.#tmux.ensureWindow("pi");
      const process = await this.#process.start({
        command,
        args,
        cwd: input.workspacePath,
        tmuxWindow: "pi",
      });
      const finished = this.#observe(process, input, signals);
      return new Run(
        this.#workerId,
        input.issue.identifier,
        prompt,
        signals,
        finished,
        async () => {
          try {
            await process.abort("worker aborted");
          } catch (error) {
            signals.push({ type: "exit", at: this.#clock.now(), exitCode: null, signal: "aborted" });
            return this.#failedResult(input, signals, "aborted", `worker abort failed: ${failureMessage(error)}`);
          }
          const output = await this.#captureOutput(input.sensitiveValues ?? []);
          if (output !== undefined) signals.push({ type: "last-output", at: this.#clock.now(), output });
          signals.push({ type: "exit", at: this.#clock.now(), exitCode: null, signal: "aborted" });
          return this.#failedResult(input, signals, "aborted", "worker was aborted");
        },
      );
    } catch (error) {
      this.#activeIssue = undefined;
      throw new WorkerAgentError(`could not start Pi worker: ${failureMessage(error)}`);
    }
  }

  public async run(request: WorkerAgentRequest): Promise<WorkerAgentResult> {
    const started = await this.start(request);
    return started.wait();
  }

  async #observe(
    process: WorkerProcess,
    input: WorkerAgentRequest,
    signals: WorkerAgentSignal[],
  ): Promise<WorkerAgentResult> {
    signals.push({ type: "heartbeat", at: this.#clock.now() });
    const wait = process.wait().then((exit) => ({ kind: "exit" as const, exit }));
    const timeout = this.#clock.sleep(input.timeoutMs ?? DEFAULT_TIMEOUT_MS).then(() => ({ kind: "timeout" as const }));
    let outcome: { readonly kind: "exit"; readonly exit: WorkerProcessExit } | { readonly kind: "timeout" };
    try {
      outcome = await Promise.race([wait, timeout]);
    } catch (error) {
      signals.push({ type: "exit", at: this.#clock.now(), exitCode: null, signal: "process" });
      return this.#failedResult(input, signals, "process", `Pi process failed: ${failureMessage(error)}`);
    }
    if (outcome.kind === "timeout") {
      try { await process.abort("worker timeout"); } catch { /* timeout remains the authoritative failure */ }
      const output = await this.#captureOutput(input.sensitiveValues ?? []);
      if (output !== undefined) signals.push({ type: "last-output", at: this.#clock.now(), output });
      signals.push({ type: "exit", at: this.#clock.now(), exitCode: null, signal: "timeout" });
      return this.#failedResult(input, signals, "timeout", DEFAULT_TIMEOUT_MESSAGE);
    }
    const output = await this.#captureOutput(input.sensitiveValues ?? []);
    if (output !== undefined) signals.push({ type: "last-output", at: this.#clock.now(), output });
    signals.push({
      type: "exit",
      at: this.#clock.now(),
      exitCode: outcome.exit.exitCode,
      ...(outcome.exit.signal === undefined ? {} : { signal: outcome.exit.signal }),
    });
    const result = outcome.exit.exitCode === 0
      ? { workerId: this.#workerId, issueIdentifier: input.issue.identifier, status: "completed" as const, signals: [...signals] }
      : this.#failedResult(input, signals, "process", `Pi exited unsuccessfully${outcome.exit.signal === undefined ? "" : ` (${outcome.exit.signal})`}`);
    this.#activeIssue = undefined;
    return result;
  }

  async #captureOutput(sensitiveValues: readonly string[]): Promise<string | undefined> {
    try {
      const output = await this.#tmux.captureLastOutput("pi");
      return redactWorkerText(output, sensitiveValues);
    } catch {
      return undefined;
    }
  }

  #failedResult(
    input: WorkerAgentRequest,
    signals: WorkerAgentSignal[],
    kind: WorkerAgentFailureKind,
    message: string,
  ): WorkerAgentResult {
    this.#activeIssue = undefined;
    signals.push({ type: "heartbeat", at: this.#clock.now() });
    return {
      workerId: this.#workerId,
      issueIdentifier: input.issue.identifier,
      status: "failed",
      signals: [...signals],
      failure: { kind, message: redactWorkerText(message, input.sensitiveValues ?? []) },
    };
  }
}

/** A shell-safe representation useful to adapters that send commands to tmux. */
export function buildPiCommand(prompt: string): string {
  return `pi --prompt ${shellArgument(prompt)}`;
}
