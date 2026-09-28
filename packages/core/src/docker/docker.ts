import type { FarmConfig } from "../config/config.ts";
import type {
  WorkerIsolationPolicy,
  WorkerIsolationRequest,
  WorkerMount,
  WorkerNetwork,
  WorkerResources,
} from "../security/isolation-policy.ts";
import { assertWorkerIsolation } from "../security/isolation-policy.ts";

/** Result returned by an injected Docker CLI/process boundary. */
export interface DockerCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs Docker without coupling this package to a process implementation. */
export interface DockerCommandRunner {
  run(command: string, args: readonly string[]): Promise<DockerCommandResult>;
}

export class DockerError extends Error {
  public constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "DockerError";
  }
}

export class DockerValidationError extends DockerError {
  public constructor(message: string) {
    super(message);
    this.name = "DockerValidationError";
  }
}

export class DockerCommandError extends DockerError {
  readonly command: string;
  readonly args: readonly string[];
  readonly exitCode: number;
  readonly stderr: string;

  public constructor(command: string, args: readonly string[], result: Pick<DockerCommandResult, "exitCode" | "stderr">) {
    super(`${command} ${args.join(" ")} failed with exit code ${result.exitCode}`
      + (result.stderr.length > 0 ? `: ${result.stderr}` : ""));
    this.name = "DockerCommandError";
    this.command = command;
    this.args = [...args];
    this.exitCode = result.exitCode;
    this.stderr = result.stderr;
  }
}

export class DockerNotFoundError extends DockerError {
  readonly resource: string;
  public constructor(resource: string) {
    super(`Docker resource was not found: ${resource}`);
    this.name = "DockerNotFoundError";
    this.resource = resource;
  }
}

export interface DockerContainerState {
  readonly status: string;
  readonly running: boolean;
  readonly exitCode?: number;
}

export interface DockerMount {
  readonly type: string;
  readonly name?: string;
  readonly source?: string;
  readonly destination: string;
  readonly readOnly?: boolean;
}

/** The stable subset of `docker inspect` consumed by the worker adapter. */
export interface DockerContainerInspection {
  readonly id: string;
  readonly name: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly state: DockerContainerState;
  readonly mounts: readonly DockerMount[];
  readonly image?: string;
}

export interface DockerContainerFilters {
  readonly labels?: Readonly<Record<string, string>>;
  readonly all?: boolean;
}

/** Client operations required by the manager; useful for higher-level fakes. */
export interface DockerClientPort {
  createContainer(options: DockerCreateOptions): Promise<string>;
  startContainer(container: string): Promise<void>;
  stopContainer(container: string): Promise<void>;
  removeContainer(container: string, options?: { readonly force?: boolean }): Promise<void>;
  inspectContainer(container: string): Promise<DockerContainerInspection>;
  listContainers(filters?: DockerContainerFilters): Promise<readonly DockerContainerInspection[]>;
  createVolume(name: string): Promise<void>;
  inspectVolume(name: string): Promise<boolean>;
}

export interface DockerCreateOptions {
  readonly name: string;
  readonly image: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly env?: Readonly<Record<string, string>>;
  readonly mounts?: readonly DockerMount[];
  readonly networkMode?: string;
  readonly memoryBytes?: number;
  readonly cpuCount?: number;
  readonly pidsLimit?: number;
  readonly user?: string | number;
  readonly workingDirectory?: string;
  readonly command?: readonly string[];
}

/** A small Docker client implemented entirely in terms of DockerCommandRunner. */
export class DockerClient implements DockerClientPort {
  readonly #runner: DockerCommandRunner;

  public constructor(runner: DockerCommandRunner) {
    if (runner === null || typeof runner !== "object" || typeof runner.run !== "function") {
      throw new DockerValidationError("a Docker command runner is required");
    }
    this.#runner = runner;
  }

  public async createContainer(options: DockerCreateOptions): Promise<string> {
    validateCreateOptions(options);
    const args = ["create", "--name", options.name];
    for (const [key, value] of Object.entries(options.labels).sort(([a], [b]) => a.localeCompare(b))) {
      args.push("--label", `${key}=${value}`);
    }
    for (const [key, value] of Object.entries(options.env ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
      args.push("--env", `${key}=${value}`);
    }
    for (const mount of options.mounts ?? []) {
      args.push("--mount", mountArgument(mount));
    }
    if (options.networkMode !== undefined) args.push("--network", options.networkMode);
    if (options.memoryBytes !== undefined) args.push("--memory", String(options.memoryBytes));
    if (options.cpuCount !== undefined) args.push("--cpus", String(options.cpuCount));
    if (options.pidsLimit !== undefined) args.push("--pids-limit", String(options.pidsLimit));
    if (options.user !== undefined) args.push("--user", String(options.user));
    if (options.workingDirectory !== undefined) args.push("--workdir", options.workingDirectory);
    args.push(options.image, ...(options.command ?? []));
    const result = await this.#run(args);
    const id = result.stdout.trim().split(/\s+/u)[0];
    if (result.exitCode !== 0) throw new DockerCommandError("docker", args, result);
    if (!/^[^\s]+$/u.test(id)) throw new DockerError("Docker create returned an invalid container id");
    return id;
  }

  public async startContainer(container: string): Promise<void> {
    const args = ["start", requireRef(container)];
    await this.#expectSuccess(args);
  }

  public async stopContainer(container: string): Promise<void> {
    const args = ["stop", requireRef(container)];
    await this.#expectSuccess(args);
  }

  public async removeContainer(container: string, options: { readonly force?: boolean } = {}): Promise<void> {
    const args = ["rm"];
    if (options.force) args.push("--force");
    args.push(requireRef(container));
    await this.#expectSuccess(args);
  }

  public async inspectContainer(container: string): Promise<DockerContainerInspection> {
    const args = ["inspect", requireRef(container)];
    const result = await this.#run(args);
    if (result.exitCode !== 0) {
      if (isNotFound(result)) throw new DockerNotFoundError(container);
      throw new DockerCommandError("docker", args, result);
    }
    let parsed: unknown;
    try { parsed = JSON.parse(result.stdout); } catch (error) {
      throw new DockerError("Docker inspect returned invalid JSON", { cause: error });
    }
    if (!Array.isArray(parsed) || parsed.length === 0) throw new DockerError("Docker inspect returned no containers");
    return parseInspection(parsed[0]);
  }

  public async listContainers(filters: DockerContainerFilters = {}): Promise<readonly DockerContainerInspection[]> {
    const args = ["ps"];
    if (filters.all ?? true) args.push("--all");
    for (const [key, value] of Object.entries(filters.labels ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
      args.push("--filter", `label=${key}=${value}`);
    }
    args.push("--format", "{{json .}}");
    const result = await this.#run(args);
    if (result.exitCode !== 0) throw new DockerCommandError("docker", args, result);
    const ids = result.stdout.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
    const containers: DockerContainerInspection[] = [];
    for (const line of ids) {
      let row: unknown;
      try { row = JSON.parse(line); } catch (error) {
        throw new DockerError("Docker ps returned invalid JSON", { cause: error });
      }
      if (row !== null && typeof row === "object" && typeof (row as { ID?: unknown }).ID === "string") {
        containers.push(await this.inspectContainer((row as { ID: string }).ID));
      }
    }
    return containers;
  }

  public async createVolume(name: string): Promise<void> {
    const args = ["volume", "create", "--name", requireRef(name)];
    await this.#expectSuccess(args);
  }

  public async inspectVolume(name: string): Promise<boolean> {
    const args = ["volume", "inspect", requireRef(name)];
    const result = await this.#run(args);
    if (result.exitCode === 0) return true;
    if (isNotFound(result)) return false;
    throw new DockerCommandError("docker", args, result);
  }

  async #expectSuccess(args: string[]): Promise<void> {
    const result = await this.#run(args);
    if (result.exitCode !== 0) {
      if (isNotFound(result)) throw new DockerNotFoundError(args.at(-1) ?? "unknown");
      throw new DockerCommandError("docker", args, result);
    }
  }

  async #run(args: readonly string[]): Promise<DockerCommandResult> {
    let result: DockerCommandResult;
    try { result = await this.#runner.run("docker", args); } catch (error) {
      throw new DockerError(`Docker command failed to run: ${args.join(" ")}`, { cause: error });
    }
    if (result === null || typeof result !== "object" || !Number.isInteger(result.exitCode)
      || typeof result.stdout !== "string" || typeof result.stderr !== "string") {
      throw new DockerError("Docker command runner returned an invalid result");
    }
    return result;
  }
}

export interface WorkerWorkspaceVolume {
  readonly name?: string;
  readonly containerPath?: string;
  readonly readOnly?: boolean;
}

export interface WorkerContainerRequest {
  readonly workerId: string;
  readonly image?: string;
  readonly workspace?: WorkerWorkspaceVolume;
  readonly isolation?: WorkerIsolationRequest;
  readonly isolationPolicy?: WorkerIsolationPolicy;
  readonly network?: WorkerNetwork;
  readonly resources?: WorkerResources;
  readonly env?: Readonly<Record<string, string>>;
  readonly labels?: Readonly<Record<string, string>>;
  readonly metadata?: Readonly<Record<string, string>>;
  readonly command?: readonly string[];
  readonly user?: string | number;
  readonly workingDirectory?: string;
}

export interface WorkerContainer {
  readonly id: string;
  readonly name: string;
  readonly workerId: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly metadata: Readonly<Record<string, string>>;
  readonly workspaceVolume?: string;
  readonly inspection: DockerContainerInspection;
}

export interface WorkerContainerManagerOptions {
  readonly prefix?: string;
  readonly labelNamespace?: string;
  /** Optional typed farm configuration; values are never read from secrets. */
  readonly config?: Pick<FarmConfig, "dockerPrefix" | "baselineImage">;
}

const DEFAULT_LABEL_NAMESPACE = "dev-farm";

/** Creates and reconciles one labelled, isolated worker container. */
export class WorkerContainerManager {
  readonly #client: DockerClientPort;
  readonly #prefix: string;
  readonly #namespace: string;
  readonly #baselineImage: string | undefined;

  public constructor(client: DockerClientPort, options: WorkerContainerManagerOptions = {}) {
    if (client === null || typeof client !== "object") throw new DockerValidationError("a Docker client is required");
    this.#client = client;
    this.#prefix = validName(options.prefix ?? options.config?.dockerPrefix ?? "dev-farm", "Docker prefix");
    this.#namespace = validName(options.labelNamespace ?? DEFAULT_LABEL_NAMESPACE, "label namespace");
    this.#baselineImage = options.config?.baselineImage;
  }

  public containerName(workerId: string): string {
    return `${this.#prefix}-worker-${safeName(workerId)}`;
  }

  public workspaceVolumeName(workerId: string): string {
    return `${this.#prefix}-workspace-${safeName(workerId)}`;
  }

  public labelsFor(workerId: string, metadata: Readonly<Record<string, string>> = {}): Readonly<Record<string, string>> {
    const labels: Record<string, string> = {
      [`${this.#namespace}/managed`]: "worker",
      [`${this.#namespace}/worker-id`]: workerId,
    };
    for (const [key, value] of Object.entries(metadata)) {
      labels[`${this.#namespace}/metadata/${validName(key, "metadata key")}`] = validName(value, "metadata value");
    }
    return labels;
  }

  public async lookupByLabels(labels: Readonly<Record<string, string>>): Promise<readonly WorkerContainer[]> {
    const containers = await this.#client.listContainers({ labels, all: true });
    return containers.map((inspection) => this.toWorkerContainer(inspection));
  }

  public findByLabels(labels: Readonly<Record<string, string>>): Promise<readonly WorkerContainer[]> {
    return this.lookupByLabels(labels);
  }

  public async inspect(worker: string): Promise<WorkerContainer> {
    return this.toWorkerContainer(await this.#client.inspectContainer(worker));
  }

  public async ensure(request: WorkerContainerRequest): Promise<WorkerContainer> {
    validateWorkerRequest(request);
    const image = request.image ?? this.#baselineImage;
    if (image === undefined) throw new DockerValidationError("worker image is required");
    if (request.isolation !== undefined) assertWorkerIsolation(request.isolation, request.isolationPolicy);
    // Caller labels are accepted, but cannot replace the identity labels used for reconciliation.
    const labels = { ...(request.labels ?? {}), ...this.labelsFor(request.workerId, request.metadata) };
    const existing = await this.lookupByLabels({ [`${this.#namespace}/worker-id`]: request.workerId });
    if (existing.length > 1) throw new DockerError(`multiple worker containers found for ${request.workerId}`);
    let worker: WorkerContainer;
    if (existing.length === 1) {
      worker = await this.inspect(existing[0].id);
      if (!worker.inspection.state.running) await this.#client.startContainer(worker.id);
      return this.inspect(worker.id);
    }

    const workspaceVolume = request.workspace === undefined ? undefined
      : request.workspace.name ?? this.workspaceVolumeName(request.workerId);
    if (workspaceVolume !== undefined) {
      if (!(await this.#client.inspectVolume(workspaceVolume))) await this.#client.createVolume(workspaceVolume);
    }
    const mounts = this.mounts(request, workspaceVolume);
    const isolation = request.isolation;
    const env = { ...(request.env ?? {}) };
    for (const credential of isolation?.credentials ?? []) {
      if (credential.value !== undefined) env[credential.name] = credential.value;
    }
    const id = await this.#client.createContainer({
      name: this.containerName(request.workerId),
      image,
      labels,
      env,
      mounts,
      networkMode: request.network?.mode ?? isolation?.network?.mode,
      memoryBytes: request.resources?.memoryBytes ?? isolation?.resources?.memoryBytes,
      cpuCount: request.resources?.cpuCount ?? isolation?.resources?.cpuCount,
      pidsLimit: request.resources?.pidsLimit ?? isolation?.resources?.pidsLimit,
      user: request.user ?? isolation?.runAsUser ?? isolation?.user,
      workingDirectory: request.workingDirectory,
      command: request.command,
    });
    await this.#client.startContainer(id);
    return this.inspect(id);
  }

  public createOrResume(request: WorkerContainerRequest): Promise<WorkerContainer> { return this.ensure(request); }
  public resume(request: WorkerContainerRequest): Promise<WorkerContainer> { return this.ensure(request); }

  public async stop(worker: string | WorkerContainerRequest): Promise<void> {
    const container = typeof worker === "string" ? await this.inspect(worker) : await this.#findRequest(worker);
    if (container.inspection.state.running) await this.#client.stopContainer(container.id);
  }

  public async remove(worker: string | WorkerContainerRequest, options: { readonly force?: boolean } = {}): Promise<void> {
    const container = typeof worker === "string" ? await this.inspect(worker) : await this.#findRequest(worker);
    await this.#client.removeContainer(container.id, options);
  }

  async #findRequest(request: WorkerContainerRequest): Promise<WorkerContainer> {
    validateWorkerRequest(request);
    const found = await this.lookupByLabels({ [`${this.#namespace}/worker-id`]: request.workerId });
    if (found.length === 0) throw new DockerNotFoundError(request.workerId);
    if (found.length > 1) throw new DockerError(`multiple worker containers found for ${request.workerId}`);
    return this.inspect(found[0].id);
  }

  mounts(request: WorkerContainerRequest, workspaceVolume: string | undefined): readonly DockerMount[] {
    const mounts: DockerMount[] = [];
    const workspace = request.workspace;
    if (workspaceVolume !== undefined) {
      mounts.push({ type: "volume", name: workspaceVolume, source: workspaceVolume,
        destination: workspace?.containerPath ?? "/workspace", readOnly: workspace?.readOnly });
    }
    const isolation = request.isolation;
    if (workspaceVolume === undefined && isolation?.workspace?.hostPath !== undefined) {
      mounts.push({ type: "bind", source: isolation.workspace.hostPath,
        destination: isolation.workspace.path ?? "/workspace", readOnly: isolation.workspace.readOnly });
    }
    for (const mount of isolation?.mounts ?? []) mounts.push(toDockerMount(mount));
    return mounts;
  }

  toWorkerContainer(inspection: DockerContainerInspection): WorkerContainer {
    const workerId = inspection.labels[`${this.#namespace}/worker-id`] ?? inspection.name;
    const metadata: Record<string, string> = {};
    const marker = `${this.#namespace}/metadata/`;
    for (const [key, value] of Object.entries(inspection.labels)) if (key.startsWith(marker)) metadata[key.slice(marker.length)] = value;
    const workspace = inspection.mounts.find((mount) => mount.destination === "/workspace");
    return { id: inspection.id, name: inspection.name, workerId, labels: inspection.labels,
      metadata, workspaceVolume: workspace?.name ?? workspace?.source, inspection };
  }
}

export function createWorkerContainerManager(client: DockerClientPort, options?: WorkerContainerManagerOptions): WorkerContainerManager {
  return new WorkerContainerManager(client, options);
}

function validateWorkerRequest(request: WorkerContainerRequest): void {
  if (request === null || typeof request !== "object") throw new DockerValidationError("worker container request is required");
  validName(request.workerId, "worker id");
  if (request.image !== undefined) validName(request.image, "image");
}

function requireRef(value: string): string { return validName(value, "Docker resource"); }
function validName(value: string, description: string): string {
  if (typeof value !== "string" || value.trim() === "" || value.includes("\u0000")) throw new DockerValidationError(`${description} must be a non-empty string without NUL`);
  return value;
}
function safeName(value: string): string {
  return validName(value, "worker id").toLowerCase().replace(/[^a-z0-9_.-]+/gu, "-").replace(/^-+|-+$/gu, "") || "worker";
}
function mountArgument(mount: DockerMount): string {
  const source = mount.name ?? mount.source;
  if (source === undefined) throw new DockerValidationError("Docker mount source is required");
  return `type=${mount.type},source=${source},target=${validName(mount.destination, "mount destination")}${mount.readOnly ? ",readonly" : ""}`;
}
function toDockerMount(mount: WorkerMount): DockerMount {
  const destination = mount.destination ?? mount.target;
  if (destination === undefined) throw new DockerValidationError("mount destination is required");
  return { type: mount.type ?? "bind", source: mount.source, destination, readOnly: mount.readOnly };
}
function isNotFound(result: DockerCommandResult): boolean {
  return result.exitCode === 1 && /no such|not found|does not exist/iu.test(result.stderr);
}
function validateCreateOptions(options: DockerCreateOptions): void {
  validName(options.name, "container name");
  validName(options.image, "image");
  for (const [key, value] of Object.entries(options.labels)) { validName(key, "label key"); validName(value, "label value"); }
}
function parseInspection(value: unknown): DockerContainerInspection {
  if (!isRecord(value)) throw new DockerError("Docker inspect returned an invalid container");
  const raw = value;
  const state = isRecord(raw.State) ? raw.State : {};
  const config = isRecord(raw.Config) ? raw.Config : {};
  const labels: Record<string, string> = {};
  if (isRecord(config.Labels)) {
    for (const [key, label] of Object.entries(config.Labels)) if (typeof label === "string") labels[key] = label;
  }
  const mounts = Array.isArray(raw.Mounts) ? raw.Mounts.map((mount): DockerMount => {
    const typedMount = isRecord(mount) ? mount : {};
    return {
      type: String(typedMount.Type ?? ""), name: typeof typedMount.Name === "string" ? typedMount.Name : undefined,
      source: typeof typedMount.Source === "string" ? typedMount.Source : undefined,
      destination: String(typedMount.Destination ?? ""), readOnly: typedMount.RW === false,
    };
  }) : [];
  if (typeof raw.Id !== "string" || typeof raw.Name !== "string" || typeof state.Status !== "string") throw new DockerError("Docker inspect returned an incomplete container");
  return { id: raw.Id, name: raw.Name.replace(/^\//u, ""), labels,
    state: { status: state.Status, running: state.Running === true, exitCode: typeof state.ExitCode === "number" ? state.ExitCode : undefined },
    mounts, image: typeof config.Image === "string" ? config.Image : undefined };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
