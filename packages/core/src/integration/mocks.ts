import type {
  DockerClientPort,
  DockerContainerFilters,
  DockerContainerInspection,
  DockerCreateOptions,
} from "../docker/docker.ts";

export interface RecordedContainerCreate {
  readonly id: string;
  readonly options: DockerCreateOptions;
}

/**
 * A deterministic barrier used to make parallel worker starts observable
 * without talking to a Docker daemon.
 */
export class ParallelStartGate {
  readonly #expected: number;
  #arrivals = 0;
  #arrivalResolvers: Array<() => void> = [];
  #releaseResolvers: Array<() => void> = [];
  #arrivalsComplete: Promise<void>;

  public constructor(expected: number) {
    if (!Number.isInteger(expected) || expected < 1)
      throw new Error("gate expected count must be positive");
    this.#expected = expected;
    this.#arrivalsComplete = new Promise((resolve) => {
      this.#arrivalResolvers.push(resolve);
    });
  }

  public arrive(): Promise<void> {
    this.#arrivals += 1;
    if (this.#arrivals === this.#expected) {
      for (const resolve of this.#arrivalResolvers) resolve();
      this.#arrivalResolvers = [];
    }
    return new Promise((resolve) => this.#releaseResolvers.push(resolve));
  }

  public waitForArrivals(): Promise<void> {
    return this.#arrivalsComplete;
  }

  public release(): void {
    for (const resolve of this.#releaseResolvers) resolve();
    this.#releaseResolvers = [];
  }
}

interface FakeContainer {
  readonly id: string;
  readonly options: DockerCreateOptions;
  running: boolean;
}

/**
 * In-memory Docker/security boundary. It stores exactly the create options
 * sent by the manager, making mount and limit assertions independent of host
 * Docker configuration and credentials.
 */
export class FakeDockerBoundary implements DockerClientPort {
  readonly creates: RecordedContainerCreate[] = [];
  readonly starts: string[] = [];
  readonly volumes = new Set<string>();
  readonly #containers = new Map<string, FakeContainer>();
  readonly #startGate: ParallelStartGate | undefined;
  #nextId = 1;

  public constructor(options: { readonly startGate?: ParallelStartGate } = {}) {
    this.#startGate = options.startGate;
  }

  public async createContainer(options: DockerCreateOptions): Promise<string> {
    const id = `fake-container-${this.#nextId}`;
    this.#nextId += 1;
    const storedOptions: DockerCreateOptions = {
      ...options,
      labels: { ...options.labels },
      env: options.env === undefined ? undefined : { ...options.env },
      mounts: options.mounts?.map((mount) => ({ ...mount })),
      command: options.command === undefined ? undefined : [...options.command],
    };
    this.#containers.set(id, { id, options: storedOptions, running: false });
    this.creates.push({ id, options: storedOptions });
    return id;
  }

  public async startContainer(container: string): Promise<void> {
    const found = this.#requireContainer(container);
    this.starts.push(container);
    if (this.#startGate !== undefined) await this.#startGate.arrive();
    found.running = true;
  }

  public async stopContainer(container: string): Promise<void> {
    this.#requireContainer(container).running = false;
  }

  public async removeContainer(container: string): Promise<void> {
    this.#containers.delete(container);
  }

  public async inspectContainer(container: string): Promise<DockerContainerInspection> {
    const found = this.#requireContainer(container);
    return this.#inspection(found);
  }

  public async listContainers(
    filters: DockerContainerFilters = {},
  ): Promise<readonly DockerContainerInspection[]> {
    return [...this.#containers.values()]
      .filter((container) => this.#matchesLabels(container, filters.labels))
      .map((container) => this.#inspection(container));
  }

  public async createVolume(name: string): Promise<void> {
    this.volumes.add(name);
  }

  public async inspectVolume(name: string): Promise<boolean> {
    return this.volumes.has(name);
  }

  #requireContainer(id: string): FakeContainer {
    const found = this.#containers.get(id);
    if (found === undefined) throw new Error(`fake container not found: ${id}`);
    return found;
  }

  #matchesLabels(
    container: FakeContainer,
    labels: Readonly<Record<string, string>> | undefined,
  ): boolean {
    if (labels === undefined) return true;
    return Object.entries(labels).every(([key, value]) => container.options.labels[key] === value);
  }

  #inspection(container: FakeContainer): DockerContainerInspection {
    return {
      id: container.id,
      name: container.options.name,
      labels: container.options.labels,
      state: { status: container.running ? "running" : "created", running: container.running },
      mounts: container.options.mounts ?? [],
      image: container.options.image,
    };
  }
}
