import { isAbsolute } from "node:path";
import type { CleanupProcessPort } from "../cleanup/cleanup.ts";
import type { WorkerAgentProcessPort, WorkerAgentProcessSpec, WorkerProcess } from "../agent/worker-agent.ts";

export interface ProcessSpawnOptions {
  readonly cwd: string;
  readonly tmuxWindow?: string;
}

export interface ProcessExit {
  readonly exitCode: number | null;
  readonly signal?: string;
}

export interface ProcessHandle extends WorkerProcess {
  readonly pid?: number;
}

/** Injectable process boundary. Implementations may wrap child_process or a host supervisor. */
export interface ProcessCommandRunner {
  spawn(command: string, args: readonly string[], options: ProcessSpawnOptions): Promise<ProcessHandle> | ProcessHandle;
  signal(processId: number, signal: "SIGTERM" | "SIGKILL"): Promise<void>;
}

export class ProcessError extends Error {
  public constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "ProcessError";
  }
}

export class ProcessValidationError extends ProcessError {
  public constructor(message: string) {
    super(message);
    this.name = "ProcessValidationError";
  }
}

/** Adapter shared by WorkerAgentProcessPort and cleanup's process port. */
export class ProcessAdapter implements WorkerAgentProcessPort, CleanupProcessPort {
  readonly #runner: ProcessCommandRunner;

  public constructor(runner: ProcessCommandRunner) {
    if (runner === null || typeof runner !== "object"
      || typeof runner.spawn !== "function" || typeof runner.signal !== "function") {
      throw new ProcessValidationError("a process command runner is required");
    }
    this.#runner = runner;
  }

  public async start(spec: WorkerAgentProcessSpec): Promise<ProcessHandle> {
    validateSpec(spec);
    let process: ProcessHandle;
    try {
      process = await this.#runner.spawn(spec.command, spec.args, {
        cwd: spec.cwd,
        tmuxWindow: spec.tmuxWindow,
      });
    } catch (error) {
      throw new ProcessError("worker process failed to start", { cause: error });
    }
    if (process === null || typeof process !== "object"
      || typeof process.wait !== "function" || typeof process.abort !== "function") {
      throw new ProcessError("process runner returned an invalid process handle");
    }
    if (process.pid !== undefined && (!Number.isInteger(process.pid) || process.pid <= 0)) {
      throw new ProcessError("process runner returned an invalid process id");
    }
    return process;
  }

  public async stop(processId: number): Promise<void> {
    await this.#signal(processId, "SIGTERM");
  }

  public async kill(processId: number): Promise<void> {
    await this.#signal(processId, "SIGKILL");
  }

  async #signal(processId: number, signal: "SIGTERM" | "SIGKILL"): Promise<void> {
    if (!Number.isInteger(processId) || processId <= 0) throw new ProcessValidationError("process id must be positive");
    try {
      await this.#runner.signal(processId, signal);
    } catch (error) {
      throw new ProcessError(`could not send ${signal} to worker process`, { cause: error });
    }
  }
}

export const ProcessClient = ProcessAdapter;
export const WorkerProcessAdapter = ProcessAdapter;
export function createProcessAdapter(runner: ProcessCommandRunner): ProcessAdapter {
  return new ProcessAdapter(runner);
}

function validateSpec(spec: WorkerAgentProcessSpec): void {
  if (spec === null || typeof spec !== "object") throw new ProcessValidationError("process specification is required");
  if (spec.command !== "pi") throw new ProcessValidationError("only the pi worker command is permitted");
  if (!Array.isArray(spec.args) || spec.args.some((arg) => typeof arg !== "string" || arg.includes("\u0000"))) {
    throw new ProcessValidationError("process arguments must be strings without NUL");
  }
  if (typeof spec.cwd !== "string" || !isAbsolute(spec.cwd) || spec.cwd.includes("\u0000")) {
    throw new ProcessValidationError("process cwd must be an absolute path without NUL");
  }
  if (spec.tmuxWindow !== "pi") throw new ProcessValidationError("worker process must run in the pi tmux window");
}
