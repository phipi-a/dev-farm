import { mkdir } from "node:fs/promises";
import type { RuntimePorts, RuntimeService } from "../runtime/runtime";
import { createRuntime } from "../runtime/runtime";
import { RuntimeCredentials } from "../config/config";
import type { DockerCommandResult } from "../docker/docker";
import type { GitCommandResult } from "../git/git";
import type { ProcessExit, ProcessHandle } from "../process/process";
import type { TmuxCommandResult } from "../tmux/tmux";
import type { GitHubHttpRequest, GitHubHttpResponse } from "../github/provider";
import type { LinearHttpRequest, LinearHttpResponse } from "../linear/provider";
import type { LinearIssue, LinearIssueStatusName } from "../linear/types";

export interface RuntimeHarnessFixture {
  readonly runtime: RuntimeService;
  readonly docker: RuntimeDockerAdapter;
  readonly process: RuntimeProcessAdapter;
  readonly linear: RuntimeLinearAdapter;
  readonly github: RuntimeGitHubAdapter;
}

interface RuntimeContainer {
  readonly id: string;
  readonly name: string;
  readonly labels: Record<string, string>;
  running: boolean;
}

interface RuntimePullRequest {
  readonly number: number;
  readonly title: string;
  readonly sourceBranch: string;
  readonly targetBranch: string;
  state: "open" | "closed";
}

const repository = {
  owner: "dogfood",
  name: "dummy-repository",
  defaultBranch: "main",
  cloneUrl: "https://example.invalid/dogfood/dummy-repository.git",
};

const tickets = [
  { identifier: "DEV-39-A", title: "Runtime ticket A" },
  { identifier: "DEV-39-B", title: "Runtime ticket B" },
  { identifier: "DEV-39-C", title: "Runtime ticket C" },
] as const;

function issue(
  identifier: string,
  title: string,
  status: LinearIssueStatusName = "Todo",
): LinearIssue {
  return {
    id: `issue-${identifier}`,
    identifier,
    title,
    description: `Deterministic runtime fixture for ${identifier}.`,
    status: { id: `status-${status.toLowerCase().replaceAll(" ", "-")}`, name: status },
  };
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

/** In-memory Docker CLI adapter; it never contacts a daemon. */
export class RuntimeDockerAdapter {
  readonly #containers = new Map<string, RuntimeContainer>();
  readonly #volumes = new Set<string>();
  readonly stopped: string[] = [];
  readonly commands: string[] = [];

  public async run(_command: string, args: readonly string[]): Promise<DockerCommandResult> {
    this.commands.push(args.join(" "));
    const action = args[0];
    if (action === "volume" && args[1] === "inspect") {
      return this.#volumes.has(String(args[2]))
        ? { exitCode: 0, stdout: "[]", stderr: "" }
        : { exitCode: 1, stdout: "", stderr: "No such volume" };
    }
    if (action === "volume" && args[1] === "create") {
      this.#volumes.add(String(args[3]));
      return { exitCode: 0, stdout: String(args[3]), stderr: "" };
    }
    if (action === "create") {
      const name = String(args[args.indexOf("--name") + 1]);
      const labels: Record<string, string> = {};
      for (let index = 0; index < args.length; index += 1) {
        if (args[index] === "--label") {
          const [key, ...value] = String(args[index + 1]).split("=");
          labels[key] = value.join("=");
        }
      }
      const id = `fixture-container-${this.#containers.size + 1}`;
      this.#containers.set(id, { id, name, labels, running: false });
      return { exitCode: 0, stdout: `${id}\n`, stderr: "" };
    }
    if (action === "start" || action === "stop") {
      const container = this.#containers.get(String(args[1]));
      if (container === undefined) return { exitCode: 1, stdout: "", stderr: "No such container" };
      container.running = action === "start";
      if (action === "stop")
        this.stopped.push(container.labels["dev-farm/worker-id"] ?? container.id);
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    if (action === "rm") {
      this.#containers.delete(String(args.at(-1)));
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    if (action === "inspect") {
      const container = this.#containers.get(String(args[1]));
      if (container === undefined) return { exitCode: 1, stdout: "", stderr: "No such container" };
      return {
        exitCode: 0,
        stdout: json([
          {
            Id: container.id,
            Name: `/${container.name}`,
            Config: { Image: "fixture@sha256:runtime", Labels: container.labels },
            State: {
              Status: container.running ? "running" : "exited",
              Running: container.running,
              ExitCode: 0,
            },
            Mounts: [],
          },
        ]),
        stderr: "",
      };
    }
    if (action === "ps") {
      const requested = args
        .filter((arg) => arg.startsWith("label=", 0))
        .map((arg) => arg.slice(6));
      const rows = [...this.#containers.values()]
        .filter((container) =>
          requested.every((filter) => {
            const [key, value] = filter.split("=");
            return container.labels[key] === value;
          }),
        )
        .map((container) => json({ ID: container.id }));
      return { exitCode: 0, stdout: rows.length === 0 ? "" : `${rows.join("\n")}\n`, stderr: "" };
    }
    throw new Error(`unexpected fixture Docker command: ${args.join(" ")}`);
  }

  public activeWorkerIds(): readonly string[] {
    return [...this.#containers.values()]
      .filter((container) => container.running)
      .map((container) => container.labels["dev-farm/worker-id"] ?? container.id);
  }
}

/** In-memory Git CLI adapter; workspace directories are the only filesystem writes. */
export class RuntimeGitAdapter {
  readonly #repositories = new Set<string>();
  readonly #branches = new Map<string, Set<string>>();
  readonly #current = new Map<string, string>();
  readonly commands: string[] = [];

  public async run(
    _command: string,
    args: readonly string[],
    options: { readonly cwd: string },
  ): Promise<GitCommandResult> {
    this.commands.push(`${args.join(" ")} @ ${options.cwd}`);
    const action = args[0];
    if (action === "rev-parse" && args[1] === "--is-inside-work-tree") {
      return {
        exitCode: this.#repositories.has(options.cwd) ? 0 : 128,
        stdout: this.#repositories.has(options.cwd) ? "true\n" : "",
        stderr: "not a git repository",
      };
    }
    if (action === "clone") {
      const destination = String(args.at(-1));
      await mkdir(destination, { recursive: true });
      this.#repositories.add(destination);
      this.#branches.set(destination, new Set());
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    if (action === "fetch" || action === "status") return { exitCode: 0, stdout: "", stderr: "" };
    if (action === "rev-parse") return { exitCode: 0, stdout: `${"a".repeat(40)}\n`, stderr: "" };
    if (action === "symbolic-ref") {
      const branch = this.#current.get(options.cwd);
      return branch === undefined
        ? { exitCode: 1, stdout: "", stderr: "" }
        : { exitCode: 0, stdout: `${branch}\n`, stderr: "" };
    }
    if (action === "show-ref") {
      const branch = String(args.at(-1)).replace("refs/heads/", "");
      return {
        exitCode: this.#branches.get(options.cwd)?.has(branch) === true ? 0 : 1,
        stdout: "",
        stderr: "",
      };
    }
    if (action === "branch") {
      this.#branches.get(options.cwd)?.add(String(args[2]));
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    if (action === "checkout") {
      this.#current.set(options.cwd, String(args[2]));
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    throw new Error(`unexpected fixture Git command: ${args.join(" ")}`);
  }
}

/** In-memory tmux adapter; no tmux process is started. */
export class RuntimeTmuxAdapter {
  readonly #windows = new Set<string>();
  public async run(_command: string, args: readonly string[]): Promise<TmuxCommandResult> {
    if (args[0] === "has-session")
      return { exitCode: this.#windows.size > 0 ? 0 : 1, stdout: "", stderr: "" };
    if (args[0] === "new-session") this.#windows.add(String(args.at(-1)));
    if (args[0] === "new-window") this.#windows.add(String(args[args.indexOf("-n") + 1]));
    if (args[0] === "list-windows")
      return { exitCode: 0, stdout: `${[...this.#windows].join("\n")}\n`, stderr: "" };
    if (args[0] === "capture-pane")
      return { exitCode: 0, stdout: "fixture worker output", stderr: "" };
    return { exitCode: 0, stdout: "", stderr: "" };
  }
}

/** In-memory Pi process adapter. Set `hang` to exercise shutdown abort handling. */
export class RuntimeProcessAdapter {
  readonly starts: string[] = [];
  readonly aborts: string[] = [];
  readonly #aborters: Array<() => Promise<void>> = [];
  public hang = false;

  public async abortAll(): Promise<void> {
    await Promise.all(this.#aborters.map((abort) => abort()));
  }

  public async spawn(
    _command: string,
    _args: readonly string[],
    options: { readonly cwd: string },
  ): Promise<ProcessHandle> {
    this.starts.push(options.cwd);
    let aborted = false;
    let finish: ((exit: ProcessExit) => void) | undefined;
    const wait: Promise<ProcessExit> = this.hang
      ? new Promise<ProcessExit>((resolve) => {
          finish = resolve;
        })
      : Promise.resolve({ exitCode: 0 });
    const abort = async () => {
      aborted = true;
      finish?.({ exitCode: null });
      this.aborts.push(options.cwd);
    };
    this.#aborters.push(abort);
    return {
      wait: () => (aborted ? Promise.resolve({ exitCode: null }) : wait),
      abort,
    };
  }

  public async signal(_processId: number, _signal: "SIGTERM" | "SIGKILL"): Promise<void> {}
}

/** Fake provider HTTP ports return deterministic fixtures and inspect no network. */
export class RuntimeLinearAdapter {
  readonly #issues = new Map<string, LinearIssue>(
    tickets.map((ticket) => [ticket.identifier, issue(ticket.identifier, ticket.title)]),
  );
  readonly requests: LinearHttpRequest[] = [];

  public async request(request: LinearHttpRequest): Promise<LinearHttpResponse> {
    this.requests.push(request);
    const payload = JSON.parse(request.body) as {
      query: string;
      variables: Record<string, string>;
    };
    const current = this.#issues.get(payload.variables.identifier);
    if (payload.query.includes("GetIssue"))
      return {
        status: 200,
        body: { data: { issue: current === undefined ? null : this.#wireIssue(current) } },
      };
    if (payload.query.includes("UpdateIssue")) {
      const target = [...this.#issues.values()].find(
        (candidate) => candidate.id === payload.variables.issueId,
      );
      if (target === undefined)
        return { status: 200, body: { data: { issueUpdate: { issue: null } } } };
      const status = this.#statusForId(payload.variables.stateId);
      const updated = {
        ...target,
        status: { ...target.status, id: payload.variables.stateId, name: status },
      };
      this.#issues.set(target.identifier, updated);
      return {
        status: 200,
        body: { data: { issueUpdate: { success: true, issue: this.#wireIssue(updated) } } },
      };
    }
    if (payload.query.includes("CreateComment"))
      return {
        status: 200,
        body: {
          data: {
            commentCreate: {
              success: true,
              comment: {
                id: "fixture-comment",
                body: payload.variables.body,
                issue: { identifier: payload.variables.identifier },
              },
            },
          },
        },
      };
    throw new Error("unexpected fixture Linear query");
  }

  public snapshot(): readonly LinearIssue[] {
    return [...this.#issues.values()];
  }
  #wireIssue(candidate: LinearIssue): unknown {
    return {
      ...candidate,
      state: { id: candidate.status.id, name: candidate.status.name, type: "backlog" },
      team: {
        id: "team-dev",
        states: {
          nodes: ["Todo", "In Progress", "In Review", "Done"].map((name) => ({
            id: `status-${name.toLowerCase().replaceAll(" ", "-")}`,
            name,
            type: "backlog",
          })),
        },
      },
    };
  }
  #statusForId(id: string): LinearIssueStatusName {
    return id.slice(7).replaceAll("-", " ") as LinearIssueStatusName;
  }
}

export class RuntimeGitHubAdapter {
  readonly #pullRequests: RuntimePullRequest[] = [];
  readonly requests: GitHubHttpRequest[] = [];
  public async request(request: GitHubHttpRequest): Promise<GitHubHttpResponse> {
    this.requests.push(request);
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname.endsWith("/pulls")) {
      const head = url.searchParams.get("head")?.split(":").at(-1);
      const base = url.searchParams.get("base");
      return {
        status: 200,
        body: this.#pullRequests
          .filter(
            (pull) =>
              pull.state === "open" && pull.sourceBranch === head && pull.targetBranch === base,
          )
          .map((pull) => this.#wire(pull)),
      };
    }
    if (request.method === "POST" && url.pathname.endsWith("/pulls")) {
      const body = JSON.parse(request.body ?? "{}") as {
        title: string;
        head: string;
        base: string;
      };
      const pull: RuntimePullRequest = {
        number: this.#pullRequests.length + 1,
        title: body.title,
        sourceBranch: body.head,
        targetBranch: body.base,
        state: "open",
      };
      this.#pullRequests.push(pull);
      return { status: 201, body: this.#wire(pull) };
    }
    throw new Error(`unexpected fixture GitHub request: ${request.method} ${url.pathname}`);
  }
  public snapshot(): readonly RuntimePullRequest[] {
    return this.#pullRequests.map((pull) => ({ ...pull }));
  }
  #wire(pull: RuntimePullRequest): unknown {
    return {
      number: pull.number,
      title: pull.title,
      state: pull.state,
      head: { ref: pull.sourceBranch },
      base: { ref: pull.targetBranch },
    };
  }
}

export function createCredentialFreeRuntimeFixture(statePath: string): RuntimeHarnessFixture {
  const docker = new RuntimeDockerAdapter();
  const git = new RuntimeGitAdapter();
  const tmux = new RuntimeTmuxAdapter();
  const process = new RuntimeProcessAdapter();
  const linear = new RuntimeLinearAdapter();
  const github = new RuntimeGitHubAdapter();
  const ports: RuntimePorts = {
    docker,
    git,
    tmux,
    process,
    linearHttp: linear,
    githubHttp: github,
    // These are non-secret test sentinels required by provider adapters; no
    // environment lookup or production credential is involved.
    credentials: new RuntimeCredentials({
      LINEAR_API_TOKEN: "fixture-linear",
      GITHUB_TOKEN: "fixture-github",
    }),
    clock: {
      now: () => 1,
      sleep: async () => {
        if (process.hang) await new Promise<void>(() => {});
      },
    },
  };
  return {
    runtime: createRuntime({
      config: {
        projects: [
          {
            name: "dev",
            linearTeam: "DEV",
            githubRepo: "dogfood/dummy-repository",
            defaultBranch: "main",
          },
        ],
        statePath,
        dockerPrefix: "dev-farm",
        portRange: { start: 41000, end: 41010 },
        baselineImage: "fixture/worker:latest",
      },
      ports,
      tmuxSessionName: "fixture",
    }),
    docker,
    process,
    linear,
    github,
  };
}

export async function runCredentialFreeComposedScenario(
  statePath: string,
): Promise<RuntimeHarnessFixture> {
  const fixture = createCredentialFreeRuntimeFixture(statePath);
  await fixture.runtime.start();
  await Promise.all(
    tickets.map((ticket) =>
      fixture.runtime.orchestrator.run({
        issueIdentifier: ticket.identifier,
        workerId: `worker-${ticket.identifier.toLowerCase()}`,
        project: "DEV-39-runtime",
        repository,
        workspacePath: `${statePath}-${ticket.identifier.toLowerCase()}`,
        definitionOfDone: ["Leave a deterministic branch ready for review."],
        securityRules: ["Use no credentials and do not merge from the worker."],
      }),
    ),
  );
  return fixture;
}

export { repository as runtimeHarnessRepository, tickets as runtimeHarnessTickets };
