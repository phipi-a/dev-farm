import type {
  WorkerAgentClockPort,
  WorkerAgentProcessPort,
  WorkerAgentRun,
  WorkerAgentTmuxPort,
} from "../agent/worker-agent";
import { WorkerAgent } from "../agent/worker-agent";
import { type CredentialProvider, type FarmConfig, loadConfig } from "../config/config";
import { DockerClient, WorkerContainerManager, type DockerCommandRunner } from "../docker/docker";
import { EventRecorder, BoundedEventStore } from "../events/store";
import type { EventPersistence } from "../events/models";
import type { GitHubHttpPort } from "../github/provider";
import { GitHubApiTransport } from "../github/provider";
import type { GitCommandRunner } from "../git/git";
import { GitWorkspaceAdapter } from "../git/git";
import type { GitHubTransport } from "../github/transports";
import { LinearApiTransport, type LinearHttpPort } from "../linear/provider";
import { LinearClient } from "../linear/client";
import type { LinearWorkflowIntent } from "../linear/types";
import {
  WorkerOrchestrator,
  type WorkerOrchestratorDependencies,
} from "../orchestrator/orchestrator";
import type { ProcessCommandRunner } from "../process/process";
import { ProcessAdapter } from "../process/process";
import { RecoveryCoordinator } from "../recovery/reconciler";
import {
  DockerHealthPort,
  githubReconciliationPort,
  linearReconciliationPort,
} from "../recovery/ports";
import type { RecoveryResult } from "../recovery/models";
import { WorkerStateStore } from "../state/store";
import type { StateDatabaseOptions } from "../state/database";
import { TmuxSessionManager, type TmuxCommandRunner } from "../tmux/tmux";
import { WorkspaceProvisioner } from "../workspace/provisioner";

/** The host-owned I/O seams required by the composition root. */
export interface RuntimePorts {
  readonly docker: DockerCommandRunner;
  readonly git: GitCommandRunner;
  readonly tmux: TmuxCommandRunner;
  readonly process: ProcessCommandRunner;
  readonly linearHttp: LinearHttpPort;
  readonly githubHttp: GitHubHttpPort;
  readonly credentials: CredentialProvider;
  readonly database?: StateDatabaseOptions["database"];
  readonly clock?: WorkerAgentClockPort;
}

export interface RuntimeOptions {
  /** Configuration is validated here, rather than being read from ambient process state. */
  readonly config: FarmConfig | unknown;
  readonly ports: RuntimePorts;
  readonly statePath?: string;
  readonly tmuxSessionName?: string;
  readonly eventStore?: EventPersistence;
  readonly eventSecrets?: readonly string[];
}

export interface RuntimeServices {
  readonly config: FarmConfig;
  readonly state: WorkerStateStore;
  readonly events: EventRecorder;
  readonly orchestrator: WorkerOrchestrator;
  readonly recovery: RecoveryCoordinator;
  readonly docker: WorkerContainerManager;
  readonly git: GitWorkspaceAdapter;
  readonly process: ProcessAdapter;
  readonly tmux: TmuxSessionManager;
  readonly linear: LinearClient;
  readonly github: GitHubApiTransport;
}

export interface RuntimeService extends RuntimeServices {
  /** Reconcile persisted workers after the process starts. */
  start(): Promise<readonly RecoveryResult[]>;
  /** Abort active Pi runs, stop their containers, and close SQLite exactly once. */
  shutdown(): Promise<void>;
  /** Alias for hosts that use the conventional close spelling. */
  close(): Promise<void>;
}

function statusIntent(status: "Todo" | "In Progress" | "In Review" | "Done"): LinearWorkflowIntent {
  switch (status) {
    case "Todo":
      return "todo";
    case "In Progress":
      return "in-progress";
    case "In Review":
      return "in-review";
    case "Done":
      return "done";
  }
}

class RuntimeAgentPort {
  readonly #process: WorkerAgentProcessPort;
  readonly #tmux: WorkerAgentTmuxPort;
  readonly #clock: WorkerAgentClockPort;
  readonly #active = new Map<string, WorkerAgentRun>();

  public constructor(
    process: WorkerAgentProcessPort,
    tmux: WorkerAgentTmuxPort,
    clock: WorkerAgentClockPort,
  ) {
    this.#process = process;
    this.#tmux = tmux;
    this.#clock = clock;
  }

  public async start(request: Parameters<WorkerAgent["start"]>[0]): Promise<WorkerAgentRun> {
    const agent = new WorkerAgent({
      workerId: request.issue.identifier,
      process: this.#process,
      tmux: this.#tmux,
      clock: this.#clock,
    });
    const run = await agent.start(request);
    this.#active.set(run.workerId, run);
    void run.wait().then(
      () => this.#active.delete(run.workerId),
      () => this.#active.delete(run.workerId),
    );
    return run;
  }

  public async abortAll(): Promise<readonly string[]> {
    const workers = [...this.#active.keys()];
    const runs = [...this.#active.values()];
    await Promise.allSettled(runs.map((run) => run.abort()));
    this.#active.clear();
    return workers;
  }
}

function tmuxAgentPort(
  manager: TmuxSessionManager,
  runner: TmuxCommandRunner,
): WorkerAgentTmuxPort {
  return {
    ensureWindow: async (window) => {
      await manager.ensure();
      if (window !== "pi") throw new Error("unsupported worker tmux window");
    },
    captureLastOutput: async (window) => {
      if (window !== "pi") throw new Error("unsupported worker tmux window");
      const result = await runner.run("tmux", [
        "capture-pane",
        "-p",
        "-J",
        "-t",
        `${manager.sessionName}:pi`,
        "-S",
        "-100",
      ]);
      if (result.exitCode !== 0) throw new Error("could not capture worker output");
      return result.stdout;
    },
  };
}

function createOrchestratorDependencies(
  config: FarmConfig,
  state: WorkerStateStore,
  docker: WorkerContainerManager,
  workspace: WorkspaceProvisioner,
  tmux: TmuxSessionManager,
  agent: RuntimeAgentPort,
  linear: LinearClient,
  github: GitHubTransport,
): WorkerOrchestratorDependencies {
  return {
    linear: {
      getIssue: (identifier) => linear.getIssue(identifier),
      setStatus: (identifier, status) =>
        linear.applyUpdate({ identifier, status: statusIntent(status) }),
      addComment: (input) => linear.addComment(input),
    },
    state: {
      get: (workerId) => state.get(workerId),
      listByIssue: (identifier) => state.list({ issueIdentifier: identifier }),
      create: (input) => state.create(input),
      transition: (workerId, next, options) => state.transition(workerId, next, options),
      update: (workerId, patch) => state.update(workerId, patch),
    },
    docker: {
      provision: async (request) => {
        const container = await docker.ensure({
          workerId: request.workerId,
          image: config.baselineImage,
          workspace: { containerPath: "/workspace" },
          metadata: { issue: request.issueIdentifier },
          workingDirectory: "/workspace",
        });
        return { containerId: container.id, imageDigest: container.inspection.image };
      },
    },
    workspace: { provision: (request) => workspace.provision(request) },
    tmux: {
      ensure: async (_workerId) => {
        await tmux.ensure();
        return { sessionName: tmux.sessionName };
      },
    },
    agent,
    pullRequest: {
      findOrCreate: async (input) => {
        const ref = {
          repository: input.repository,
          sourceBranch: input.sourceBranch,
          targetBranch: input.targetBranch,
        };
        const existing = await github.findPullRequest(ref);
        return (
          existing ?? github.createPullRequest({ ...ref, title: input.title, body: input.body })
        );
      },
    },
  };
}

/** Build the complete runtime graph without reading credentials or starting commands. */
export function createRuntime(options: RuntimeOptions): RuntimeService {
  if (options === null || typeof options !== "object")
    throw new TypeError("runtime options are required");
  const config = loadConfig(options.config);
  const ports = options.ports;
  if (ports === null || typeof ports !== "object")
    throw new TypeError("runtime ports are required");

  const state = new WorkerStateStore({
    path: options.statePath ?? config.statePath,
    database: ports.database,
  });
  const dockerClient = new DockerClient(ports.docker);
  const docker = new WorkerContainerManager(dockerClient, { config });
  const git = new GitWorkspaceAdapter(ports.git);
  const process = new ProcessAdapter(ports.process);
  const tmux = new TmuxSessionManager(ports.tmux, { sessionName: options.tmuxSessionName });
  const linearTransport = new LinearApiTransport(ports.linearHttp, ports.credentials);
  const github = new GitHubApiTransport(ports.githubHttp, ports.credentials);
  const linear = new LinearClient(linearTransport);
  const workspace = new WorkspaceProvisioner({ git });
  const clock = ports.clock ?? {
    now: () => Date.now(),
    sleep: (milliseconds: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)),
  };
  const agent = new RuntimeAgentPort(process, tmuxAgentPort(tmux, ports.tmux), clock);
  const orchestrator = new WorkerOrchestrator(
    createOrchestratorDependencies(config, state, docker, workspace, tmux, agent, linear, github),
  );
  const recovery = new RecoveryCoordinator(state, {
    health: new DockerHealthPort(dockerClient),
    github: githubReconciliationPort(github),
    linear: linearReconciliationPort(linearTransport),
  });
  const events = new EventRecorder({
    persistence: options.eventStore ?? new BoundedEventStore(),
    secrets: options.eventSecrets,
  });

  let shutDown: Promise<void> | undefined;
  let started = false;
  const service: RuntimeService = {
    config,
    state,
    events,
    orchestrator,
    recovery,
    docker,
    git,
    process,
    tmux,
    linear,
    github,
    start: async () => {
      if (shutDown !== undefined) throw new Error("runtime has been shut down");
      if (started) return [];
      const results = await recovery.reconcileAll();
      started = true;
      return results;
    },
    shutdown: async () => {
      if (shutDown !== undefined) return shutDown;
      shutDown = (async () => {
        const issueIdentifiers = await agent.abortAll();
        const workerIds = issueIdentifiers.flatMap((issueIdentifier) => {
          const persisted = state.list({ issueIdentifier });
          return persisted.length === 0
            ? [issueIdentifier]
            : persisted.map((worker) => worker.workerId);
        });
        await Promise.allSettled(
          workerIds.map(async (workerId) => {
            try {
              await docker.stop({ workerId });
            } catch {
              /* shutdown remains best-effort for already-gone workers */
            }
          }),
        );
        state.close();
      })();
      return shutDown;
    },
    close: async () => service.shutdown(),
  };
  return service;
}

/** Validate an untyped configuration before constructing the runtime graph. */
export function createRuntimeFromConfig(config: unknown, ports: RuntimePorts): RuntimeService {
  return createRuntime({ config: loadConfig(config), ports });
}
