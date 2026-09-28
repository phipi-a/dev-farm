import type { FarmOperationRequest, FarmOperations } from "./index";

/** The state subset consumed by the CLI runtime facade. */
export interface RuntimeStatePort {
  list(
    filter?: Readonly<Record<string, unknown>>,
  ): readonly unknown[] | Promise<readonly unknown[]>;
  get(workerId: string): unknown | undefined | Promise<unknown | undefined>;
  transition?(
    workerId: string,
    state: string,
    options?: Readonly<Record<string, unknown>>,
  ): unknown | Promise<unknown>;
}

/** The resource operations that the composition root already exposes. */
export interface RuntimeResourcePort {
  stop(worker: string | { readonly workerId: string }): Promise<void>;
  remove?(
    worker: string | { readonly workerId: string },
    options?: { readonly force?: boolean },
  ): Promise<void>;
}

export interface RuntimeTmuxPort {
  readonly sessionName?: string;
  attachCommand(): string;
}

export interface RuntimeGitPort {
  status(path: string): unknown | Promise<unknown>;
}

/** Structural view of RuntimeService; avoids coupling the CLI to core internals. */
export interface RuntimeFacade {
  readonly state: RuntimeStatePort;
  readonly docker: RuntimeResourcePort;
  readonly tmux: RuntimeTmuxPort;
  readonly git?: RuntimeGitPort;
}

/**
 * Optional operation handlers supplied by a host when a core workflow is
 * composed into RuntimeService. The CLI does not implement provider policy or
 * orchestration; it only passes the parsed request to these handlers.
 */
export type RuntimeOperationHandlers = Partial<FarmOperations>;

export class RuntimeOperationUnavailableError extends Error {
  public constructor(command: string) {
    super(`runtime integration for '${command}' is not available`);
    this.name = "RuntimeOperationUnavailableError";
  }
}

function targetOf(request: FarmOperationRequest): string {
  const target = request.target?.trim();
  if (target === undefined || target.length === 0 || target.includes("\u0000")) {
    throw new Error(`${request.command} requires a worker target`);
  }
  return target;
}

async function workerOf(runtime: RuntimeFacade, request: FarmOperationRequest): Promise<unknown> {
  const target = targetOf(request);
  const worker = await runtime.state.get(target);
  if (worker === undefined) throw new Error(`worker ${target} was not found`);
  return worker;
}

function workerState(worker: unknown): string | undefined {
  if (worker === null || typeof worker !== "object") return undefined;
  const state = (worker as { state?: unknown }).state;
  return typeof state === "string" ? state : undefined;
}

async function transition(
  runtime: RuntimeFacade,
  workerId: string,
  worker: unknown,
  state: string,
): Promise<unknown> {
  const current = workerState(worker);
  if (current === state || runtime.state.transition === undefined) return worker;
  await runtime.state.transition(workerId, state, {
    actor: "cli",
    reason: `worker ${state} requested by operator`,
    expectedState: current,
  });
  return (await runtime.state.get(workerId)) ?? worker;
}

function unavailable(command: string): () => Promise<never> {
  return async () => {
    throw new RuntimeOperationUnavailableError(command);
  };
}

/**
 * Adapt a DEV-31 runtime composition to the CLI's FarmOperations seam.
 *
 * State/resource operations use only services already present on RuntimeService.
 * Higher-level commands are delegated to injected workflow handlers; this is
 * intentional rather than a second orchestration implementation in the CLI.
 */
export function createRuntimeOperations(
  runtime: RuntimeFacade,
  handlers: RuntimeOperationHandlers = {},
): FarmOperations {
  if (runtime === null || typeof runtime !== "object") {
    throw new TypeError("runtime is required");
  }
  if (runtime.state === undefined || runtime.docker === undefined || runtime.tmux === undefined) {
    throw new TypeError("runtime state, docker, and tmux services are required");
  }

  const list = async (request: FarmOperationRequest): Promise<unknown> => {
    const filter: Record<string, unknown> = {};
    if (request.target !== undefined) filter.issueIdentifier = request.target;
    const project = request.options.project;
    if (typeof project === "string") filter.project = project;
    const state = request.options.state;
    if (typeof state === "string") filter.states = [state];
    return runtime.state.list(filter);
  };

  const status = async (request: FarmOperationRequest): Promise<unknown> =>
    workerOf(runtime, request);

  const attach = async (request: FarmOperationRequest): Promise<unknown> => {
    const worker = await workerOf(runtime, request);
    return {
      worker,
      sessionName:
        worker !== null &&
        typeof worker === "object" &&
        typeof (worker as { sessionName?: unknown }).sessionName === "string"
          ? (worker as { sessionName: string }).sessionName
          : runtime.tmux.sessionName,
      command: runtime.tmux.attachCommand(),
    };
  };

  const preview = async (request: FarmOperationRequest): Promise<unknown> => {
    if (runtime.git === undefined) throw new RuntimeOperationUnavailableError("preview");
    const worker = await workerOf(runtime, request);
    if (
      worker === null ||
      typeof worker !== "object" ||
      typeof (worker as { workspacePath?: unknown }).workspacePath !== "string"
    ) {
      throw new Error(`worker ${targetOf(request)} has no workspace`);
    }
    return {
      worker,
      status: await runtime.git.status((worker as { workspacePath: string }).workspacePath),
    };
  };

  const stop = async (request: FarmOperationRequest): Promise<unknown> => {
    const target = targetOf(request);
    const worker = await workerOf(runtime, request);
    const current = workerState(worker);
    if (current === "destroyed" || current === "queued" || current === "failed") return worker;
    // WorkerContainerManager resolves this request through its managed labels;
    // the CLI target is a worker identity, not a Docker container ID.
    await runtime.docker.stop({ workerId: target });
    return transition(runtime, target, worker, "stopped");
  };

  const destroy = async (request: FarmOperationRequest): Promise<unknown> => {
    const target = targetOf(request);
    let worker = await workerOf(runtime, request);
    const current = workerState(worker);
    if (current === "destroyed") return worker;
    if (runtime.docker.remove === undefined) throw new RuntimeOperationUnavailableError("destroy");

    // A queued worker has no container yet. Failed workers may already have
    // been transitioned by orchestration, so only states with a valid stopped
    // transition need that lifecycle step before destruction.
    if (current !== "queued" && current !== "stopped" && current !== "failed") {
      await runtime.docker.stop({ workerId: target });
      worker = await transition(runtime, target, worker, "stopped");
    } else if (current === "failed") {
      await runtime.docker.stop({ workerId: target });
    }
    if (current !== "queued") await runtime.docker.remove({ workerId: target }, { force: true });
    return transition(runtime, target, worker, "destroyed");
  };

  const implemented: FarmOperations = {
    list,
    status,
    attach,
    preview,
    stop,
    destroy,
    shell: handlers.shell ?? unavailable("shell"),
    logs: handlers.logs ?? unavailable("logs"),
    pr: handlers.pr ?? unavailable("pr"),
    continue: handlers.continue ?? unavailable("continue"),
    merge: handlers.merge ?? unavailable("merge"),
  };

  for (const command of ["list", "status", "attach", "preview", "stop", "destroy"] as const) {
    const handler = handlers[command];
    if (handler !== undefined) implemented[command] = handler;
  }
  return implemented;
}

/** Alias for hosts that name the CLI seam rather than the composition root. */
export const createFarmOperations = createRuntimeOperations;

/** Alias used by integrations that call the DEV-31 service a runtime service. */
export type RuntimeServiceLike = RuntimeFacade;
export type RuntimeOperationPorts = RuntimeFacade;
