/**
 * A port range is inclusive at both ends.
 */
export interface PortRange {
  readonly start: number;
  readonly end: number;
}

export interface PreviewOptions {
  /** Hostname only, for example `localhost` or `127.0.0.1`. */
  readonly host: string;
  readonly protocol?: "http" | "https";
  /** Optional path appended to the preview URL. */
  readonly path?: string;
}

export interface PersistedPortAllocation {
  readonly workerId: string;
  readonly port: number;
}

export interface PortAllocatorState {
  readonly allocations: readonly PersistedPortAllocation[];
}

export interface PortAllocation extends PersistedPortAllocation {
  readonly previewUrl?: string;
}

export interface PortAllocatorOptions {
  readonly range: PortRange;
  readonly preview?: PreviewOptions;
  readonly state?: PortAllocatorState;
}

/** Thrown when an allocation cannot be made or persisted state is invalid. */
export class PortAllocationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "PortAllocationError";
  }
}

const MIN_PORT = 1;
const MAX_PORT = 65535;

function validatePort(port: number, description: string): void {
  if (!Number.isInteger(port) || port < MIN_PORT || port > MAX_PORT) {
    throw new PortAllocationError(`${description} must be an integer from 1 to 65535`);
  }
}

function validateRange(range: PortRange): PortRange {
  if (range === null || typeof range !== "object") {
    throw new PortAllocationError("port range is required");
  }

  validatePort(range.start, "range.start");
  validatePort(range.end, "range.end");
  if (range.start > range.end) {
    throw new PortAllocationError("range.start must not be greater than range.end");
  }
  return { start: range.start, end: range.end };
}

function validateWorkerId(workerId: string): void {
  if (typeof workerId !== "string" || workerId.trim().length === 0) {
    throw new PortAllocationError("workerId must be a non-empty string");
  }
}

function validatePreviewHost(host: string): void {
  const invalidHost = (): never => {
    throw new PortAllocationError(
      "preview.host must be a hostname without credentials, a port, or a path",
    );
  };

  // Do not let URL silently trim or reinterpret URL-shaped input before it is
  // validated as a host-only value.
  if (host !== host.trim() || /[\u0000-\u001f\u007f]/.test(host)) invalidHost();
  if (/[\/?#@\\]/.test(host)) invalidHost();

  let authority = host;
  if (host.startsWith("[")) {
    if (!host.endsWith("]") || host.slice(1, -1).includes("[")) invalidHost();
  } else {
    if (host.includes("[") || host.includes("]")) invalidHost();
    // A colon is only valid as part of an IPv6 literal. Bracketing the value
    // makes URL reject ports, credentials, and non-IPv6 colon-delimited input.
    if (host.includes(":")) authority = `[${host}]`;
  }

  try {
    const url = new URL(`http://${authority}`);
    if (url.username !== "" || url.password !== "" || url.port !== "" || url.pathname !== "/") {
      invalidHost();
    }
  } catch {
    invalidHost();
  }
}

function validatePreview(preview: PreviewOptions | undefined): PreviewOptions | undefined {
  if (preview === undefined) return undefined;
  if (typeof preview.host !== "string" || preview.host.trim().length === 0) {
    throw new PortAllocationError("preview.host must be a non-empty hostname");
  }
  if (preview.protocol !== undefined && preview.protocol !== "http" && preview.protocol !== "https") {
    throw new PortAllocationError("preview.protocol must be http or https");
  }
  if (preview.host.includes("/") || preview.host.includes("?") || preview.host.includes("#")) {
    throw new PortAllocationError("preview.host must be a hostname without a path");
  }
  validatePreviewHost(preview.host);
  return { ...preview };
}

function preferredOffset(workerId: string, size: number): number {
  // FNV-1a is small, deterministic across processes, and does not require state.
  let hash = 2166136261;
  for (let index = 0; index < workerId.length; index += 1) {
    hash ^= workerId.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % size;
}

/**
 * Allocates ports without opening sockets. Allocation state is entirely in memory
 * and can be serialized with `snapshot()` and restored in a new process.
 *
 * Each worker has a deterministic preferred slot derived from its ID. A circular
 * probe handles collisions while preserving the range boundary. Calls are
 * synchronous, so allocations made from concurrent callers cannot interleave.
 */
export class PortAllocator {
  readonly #range: PortRange;
  readonly #preview: PreviewOptions | undefined;
  readonly #byWorker = new Map<string, number>();
  readonly #byPort = new Map<number, string>();

  public constructor(options: PortAllocatorOptions) {
    if (options === null || typeof options !== "object") {
      throw new PortAllocationError("allocator options are required");
    }
    this.#range = validateRange(options.range);
    this.#preview = validatePreview(options.preview);
    if (options.state !== undefined) this.restore(options.state);
  }

  /** The deterministic first port considered for this worker. */
  public preferredPort(workerId: string): number {
    validateWorkerId(workerId);
    const size = this.#range.end - this.#range.start + 1;
    return this.#range.start + preferredOffset(workerId, size);
  }

  /** Return an existing allocation, or reserve the next available port. */
  public allocate(workerId: string): PortAllocation {
    validateWorkerId(workerId);
    const existing = this.#byWorker.get(workerId);
    if (existing !== undefined) return this.#allocation(workerId, existing);

    const size = this.#range.end - this.#range.start + 1;
    const preferred = this.preferredPort(workerId);
    const preferredOffsetInRange = preferred - this.#range.start;
    for (let probe = 0; probe < size; probe += 1) {
      const port = this.#range.start + ((preferredOffsetInRange + probe) % size);
      if (!this.#byPort.has(port)) {
        this.#byWorker.set(workerId, port);
        this.#byPort.set(port, workerId);
        return this.#allocation(workerId, port);
      }
    }

    throw new PortAllocationError(`no available ports in ${this.#range.start}-${this.#range.end}`);
  }

  /** Release a worker's reservation. The freed port may be reused immediately. */
  public release(workerId: string): PortAllocation | undefined {
    validateWorkerId(workerId);
    const port = this.#byWorker.get(workerId);
    if (port === undefined) return undefined;
    this.#byWorker.delete(workerId);
    this.#byPort.delete(port);
    return this.#allocation(workerId, port);
  }

  public get(workerId: string): PortAllocation | undefined {
    validateWorkerId(workerId);
    const port = this.#byWorker.get(workerId);
    return port === undefined ? undefined : this.#allocation(workerId, port);
  }

  /** Replace all active reservations after validating the complete state atomically. */
  public restore(state: PortAllocatorState): void {
    if (state === null || typeof state !== "object" || !Array.isArray(state.allocations)) {
      throw new PortAllocationError("state.allocations must be an array");
    }

    const byWorker = new Map<string, number>();
    const byPort = new Map<number, string>();
    for (const allocation of state.allocations) {
      if (allocation === null || typeof allocation !== "object") {
        throw new PortAllocationError("each persisted allocation must be an object");
      }
      validateWorkerId(allocation.workerId);
      validatePort(allocation.port, "persisted port");
      if (allocation.port < this.#range.start || allocation.port > this.#range.end) {
        throw new PortAllocationError(`persisted port ${allocation.port} is outside the allocator range`);
      }
      if (byWorker.has(allocation.workerId)) {
        throw new PortAllocationError(`worker ${allocation.workerId} is persisted more than once`);
      }
      if (byPort.has(allocation.port)) {
        throw new PortAllocationError(`port ${allocation.port} is persisted more than once`);
      }
      byWorker.set(allocation.workerId, allocation.port);
      byPort.set(allocation.port, allocation.workerId);
    }

    this.#byWorker.clear();
    this.#byPort.clear();
    for (const [workerId, port] of byWorker) {
      this.#byWorker.set(workerId, port);
      this.#byPort.set(port, workerId);
    }
  }

  /** Return JSON-safe state; no preview-derived data is persisted. */
  public snapshot(): PortAllocatorState {
    const allocations = [...this.#byWorker.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([workerId, port]) => ({ workerId, port }));
    return { allocations };
  }

  /** Build the preview URL for a worker, if preview configuration was supplied. */
  public previewUrl(workerId: string, path?: string): string | undefined {
    const allocation = this.get(workerId);
    return allocation === undefined ? undefined : buildPreviewUrl(allocation.port, this.#preview, path);
  }

  #allocation(workerId: string, port: number): PortAllocation {
    const previewUrl = buildPreviewUrl(port, this.#preview);
    return previewUrl === undefined
      ? { workerId, port }
      : { workerId, port, previewUrl };
  }
}

/** Construct a preview URL without binding or probing the port. */
export function buildPreviewUrl(
  port: number,
  preview: PreviewOptions | undefined,
  path?: string,
): string | undefined {
  if (preview === undefined) return undefined;
  validatePort(port, "port");
  const validated = validatePreview(preview);
  if (validated === undefined) return undefined;
  const protocol = validated.protocol ?? "http";
  const host = validated.host.includes(":") && !validated.host.startsWith("[")
    ? `[${validated.host}]`
    : validated.host;
  const url = new URL(`${protocol}://${host}`);
  url.port = String(port);
  const pathname = path ?? validated.path;
  if (pathname === undefined) return `${url.protocol}//${url.host}`;
  url.pathname = pathname.startsWith("/") ? pathname : `/${pathname}`;
  return url.toString();
}
