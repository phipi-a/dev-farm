/**
 * The small, serialisable input understood by the worker isolation validator.
 * It deliberately models security-sensitive settings instead of accepting a
 * Docker API object, so callers cannot accidentally bypass validation by
 * passing through unknown runtime options.
 */
export interface WorkerMount {
  readonly source: string;
  /** Docker calls this field `target`; `destination` is the portable spelling. */
  readonly destination?: string;
  readonly target?: string;
  readonly readOnly?: boolean;
  readonly type?: "bind" | "tmpfs";
}

export interface WorkerWorkspace {
  /** Host path containing the checkout. */
  readonly hostPath?: string;
  /** Container path at which the checkout is exposed. */
  readonly path?: string;
  readonly readOnly?: boolean;
}

export interface WorkerNetwork {
  readonly mode?: string;
  readonly allowedHosts?: readonly string[];
  /** A convenience spelling used by container adapters. */
  readonly hostNetwork?: boolean;
}

export interface WorkerResources {
  readonly memoryBytes?: number;
  readonly cpuCount?: number;
  readonly pidsLimit?: number;
  readonly diskBytes?: number;
}

export interface WorkerCredential {
  readonly name: string;
  readonly kind?: string;
  /** The value is accepted for adapter convenience, but is never echoed. */
  readonly value?: string;
}

export interface WorkerIsolationRequest {
  readonly workspace?: WorkerWorkspace;
  readonly mounts?: readonly WorkerMount[];
  readonly privileged?: boolean;
  readonly capabilities?: readonly string[];
  readonly user?: string | number;
  readonly runAsUser?: string | number;
  readonly network?: WorkerNetwork;
  readonly resources?: WorkerResources;
  readonly credentials?: readonly WorkerCredential[];
  /** Arbitrary fields intended for diagnostic/log output. */
  readonly logFields?: unknown;
}

export interface WorkspacePolicy {
  readonly containerPath?: string;
  readonly requireNonRootHostPath?: boolean;
}

export interface NetworkPolicy {
  readonly allowedModes?: readonly string[];
  readonly allowedHosts?: readonly string[];
}

export interface ResourcePolicy {
  readonly maxMemoryBytes?: number;
  readonly maxCpuCount?: number;
  readonly maxPids?: number;
  readonly maxDiskBytes?: number;
}

export interface CredentialPolicy {
  readonly allowedNames?: readonly string[];
  readonly allowedKinds?: readonly string[];
}

export interface WorkerIsolationPolicy {
  readonly allowedCapabilities?: readonly string[];
  readonly requireNonRoot?: boolean;
  readonly workspace?: WorkspacePolicy;
  readonly network?: NetworkPolicy;
  readonly resources?: ResourcePolicy;
  readonly credentials?: CredentialPolicy;
}

export interface IsolationValidationFailure {
  readonly path: string;
  readonly code:
    | "invalid"
    | "forbidden-mount"
    | "privileged"
    | "capability"
    | "root"
    | "workspace"
    | "network"
    | "resource"
    | "credential";
  readonly message: string;
}

export interface IsolationValidationResult {
  readonly valid: boolean;
  readonly failures: readonly IsolationValidationFailure[];
  /** Safe to include in diagnostics; secret-bearing fields are redacted. */
  readonly logFields: unknown;
}

export class WorkerIsolationValidationError extends Error {
  public readonly failures: readonly IsolationValidationFailure[];

  public constructor(failures: readonly IsolationValidationFailure[]) {
    super(`worker isolation validation failed (${failures.length} error${failures.length === 1 ? "" : "s"})`);
    this.name = "WorkerIsolationValidationError";
    this.failures = failures;
  }
}

const DEFAULT_POLICY: Required<Pick<WorkerIsolationPolicy, "allowedCapabilities" | "requireNonRoot">> &
  Required<Pick<WorkerIsolationPolicy, "workspace" | "network" | "resources" | "credentials">> = {
  allowedCapabilities: [],
  requireNonRoot: true,
  workspace: { containerPath: "/workspace", requireNonRootHostPath: true },
  network: { allowedModes: ["none", "restricted"], allowedHosts: [] },
  resources: {
    maxMemoryBytes: 16 * 1024 * 1024 * 1024,
    maxCpuCount: 64,
    maxPids: 32_768,
    maxDiskBytes: 1024 * 1024 * 1024 * 1024,
  },
  credentials: { allowedNames: [], allowedKinds: [] },
};

const SENSITIVE_KEY = /(secret|token|password|passwd|authorization|api[-_]?key|private[-_]?key|credential|cookie)/i;
const HOME_PATH = /^(?:~(?:\/|$)|\/(?:home|root|Users)(?:\/|$)|\/private\/var\/root(?:\/|$))/;
const DOCKER_SOCKET = /(?:^|\/)(?:docker\.sock|docker\.socket)$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Redact values beneath secret-like keys, including nested log structures. */
export function redactSecrets<T>(value: T): T {
  const seen = new WeakSet<object>();
  const redact = (current: unknown, key?: string): unknown => {
    if (key !== undefined && SENSITIVE_KEY.test(key)) return "[REDACTED]";
    if (typeof current === "string") return current;
    if (current === null || typeof current !== "object") return current;
    if (seen.has(current)) return "[CIRCULAR]";
    seen.add(current);
    if (Array.isArray(current)) return current.map((item) => redact(item));
    const result: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(current)) {
      result[childKey] = redact(childValue, childKey);
    }
    return result;
  };
  return redact(value) as T;
}

/** Explicit name for callers that redact adapter diagnostic/log fields. */
export const redactLogFields = redactSecrets;

function pathHasTraversal(path: string): boolean {
  return path.split(/[\\/]+/u).some((part) => part === ".." || part === ".");
}

function isRoot(value: string | number | undefined): boolean {
  if (value === 0 || value === "0") return true;
  if (typeof value !== "string") return false;
  const identity = value.trim().toLowerCase().split(":", 1)[0];
  return identity === "0" || identity === "root";
}

function add(
  failures: IsolationValidationFailure[],
  path: string,
  code: IsolationValidationFailure["code"],
  message: string,
): void {
  failures.push({ path, code, message });
}

function mergedPolicy(policy: WorkerIsolationPolicy | undefined): WorkerIsolationPolicy {
  return {
    ...DEFAULT_POLICY,
    ...policy,
    workspace: { ...DEFAULT_POLICY.workspace, ...policy?.workspace },
    network: { ...DEFAULT_POLICY.network, ...policy?.network },
    resources: {
      ...DEFAULT_POLICY.resources,
      ...policy?.resources,
      maxMemoryBytes: policy?.resources?.maxMemoryBytes ?? DEFAULT_POLICY.resources.maxMemoryBytes,
      maxCpuCount: policy?.resources?.maxCpuCount ?? DEFAULT_POLICY.resources.maxCpuCount,
      maxPids: policy?.resources?.maxPids ?? DEFAULT_POLICY.resources.maxPids,
      maxDiskBytes: policy?.resources?.maxDiskBytes ?? DEFAULT_POLICY.resources.maxDiskBytes,
    },
    credentials: { ...DEFAULT_POLICY.credentials, ...policy?.credentials },
    allowedCapabilities: policy?.allowedCapabilities ?? DEFAULT_POLICY.allowedCapabilities,
    requireNonRoot: policy?.requireNonRoot ?? DEFAULT_POLICY.requireNonRoot,
  };
}

function validateMounts(
  request: WorkerIsolationRequest,
  policy: WorkerIsolationPolicy,
  failures: IsolationValidationFailure[],
): void {
  const mounts = request.mounts ?? [];
  if (!Array.isArray(mounts)) {
    add(failures, "mounts", "invalid", "mounts must be an array");
  } else for (const [index, mount] of mounts.entries()) {
    const path = `mounts[${index}]`;
    const mountRecord: unknown = mount;
    if (!isRecord(mountRecord) || typeof mountRecord.source !== "string" || mountRecord.source.trim() === "") {
      add(failures, path, "invalid", "mount source must be a non-empty path");
      continue;
    }
    const typedMount = mountRecord as unknown as WorkerMount;
    const destination = typedMount.destination ?? typedMount.target;
    if (destination !== undefined && (destination.startsWith("/") === false || pathHasTraversal(destination))) {
      add(failures, `${path}.destination`, "forbidden-mount", "mount destination must be a safe absolute path");
    }
    if (DOCKER_SOCKET.test(typedMount.source) || (destination !== undefined && DOCKER_SOCKET.test(destination))) {
      add(failures, path, "forbidden-mount", "Docker socket mounts are not permitted");
    }
    if (!typedMount.source.startsWith("/") || pathHasTraversal(typedMount.source)) {
      add(failures, `${path}.source`, "forbidden-mount", "mount source must be an absolute, canonical path");
    }
    if (HOME_PATH.test(typedMount.source)) {
      add(failures, path, "forbidden-mount", "host-home mounts are not permitted");
    }
    if (["/", "/etc", "/var", "/usr", "/bin", "/sbin", "/proc", "/sys", "/dev"].includes(typedMount.source)) {
      add(failures, path, "forbidden-mount", "host system mounts are not permitted");
    }
    if (typedMount.type === "bind" && typedMount.readOnly !== true && destination === "/etc") {
      add(failures, path, "forbidden-mount", "sensitive system mounts must not be writable");
    }
  }

  const workspaceValue: unknown = request.workspace;
  if (workspaceValue === undefined) return;
  if (!isRecord(workspaceValue)) {
    add(failures, "workspace", "invalid", "workspace must be an object");
    return;
  }
  const workspace = workspaceValue as unknown as WorkerWorkspace;
  if (workspace.hostPath !== undefined) {
    if (typeof workspace.hostPath !== "string" || !workspace.hostPath.startsWith("/") || pathHasTraversal(workspace.hostPath)) {
      add(failures, "workspace.hostPath", "workspace", "workspace host path must be an absolute, canonical path");
    } else if ((policy.workspace?.requireNonRootHostPath ?? true) && HOME_PATH.test(workspace.hostPath)) {
      add(failures, "workspace.hostPath", "workspace", "workspace must not be inside a host home directory");
    }
  }
  if (workspace.path !== undefined) {
    const expected = policy.workspace?.containerPath ?? "/workspace";
    if (workspace.path !== expected || pathHasTraversal(workspace.path) || workspace.path === "/") {
      add(failures, "workspace.path", "workspace", `workspace path must be ${expected}`);
    }
  }
}

function validateNetwork(
  network: WorkerNetwork | undefined,
  policy: WorkerIsolationPolicy,
  failures: IsolationValidationFailure[],
): void {
  if (network === undefined) return;
  const networkValue: unknown = network;
  if (!isRecord(networkValue)) {
    add(failures, "network", "invalid", "network must be an object");
    return;
  }
  const typedNetwork = networkValue as unknown as WorkerNetwork;
  const mode = typedNetwork.mode ?? (typedNetwork.hostNetwork === true ? "host" : "none");
  const allowedModes = policy.network?.allowedModes ?? [];
  if (typedNetwork.hostNetwork === true || mode === "host" || mode === "container:host") {
    add(failures, "network", "network", "host networking is not permitted");
  } else if (!allowedModes.includes(mode)) {
    add(failures, "network.mode", "network", `network mode ${mode} is not allowlisted`);
  }
  if (typedNetwork.allowedHosts !== undefined && !Array.isArray(typedNetwork.allowedHosts)) {
    add(failures, "network.allowedHosts", "invalid", "network allowed hosts must be an array");
  } else if (typedNetwork.allowedHosts !== undefined) {
    const policyHosts = policy.network?.allowedHosts ?? [];
    for (const [index, host] of typedNetwork.allowedHosts.entries()) {
      if (typeof host !== "string" || host.trim() === "" || /[\u0000-\u001f\u007f/:?#@\\]/u.test(host)) {
        add(failures, `network.allowedHosts[${index}]`, "network", "network host is invalid");
      } else if (!policyHosts.includes(host)) {
        add(failures, `network.allowedHosts[${index}]`, "network", "network host is not allowlisted");
      }
    }
  }
}

function validateResources(
  resources: WorkerResources | undefined,
  policy: WorkerIsolationPolicy,
  failures: IsolationValidationFailure[],
): void {
  if (resources === undefined) return;
  const resourcesValue: unknown = resources;
  if (!isRecord(resourcesValue)) {
    add(failures, "resources", "invalid", "resources must be an object");
    return;
  }
  const typedResources = resourcesValue as unknown as WorkerResources;
  const limits: Array<[keyof WorkerResources, number | undefined, number | undefined]> = [
    ["memoryBytes", typedResources.memoryBytes, policy.resources?.maxMemoryBytes],
    ["cpuCount", typedResources.cpuCount, policy.resources?.maxCpuCount],
    ["pidsLimit", typedResources.pidsLimit, policy.resources?.maxPids],
    ["diskBytes", typedResources.diskBytes, policy.resources?.maxDiskBytes],
  ];
  for (const [name, value, maximum] of limits) {
    if (value === undefined) continue;
    if (
      !Number.isFinite(value) ||
      value <= 0 ||
      (name !== "cpuCount" && !Number.isInteger(value))
    ) {
      add(failures, `resources.${name}`, "resource", "resource limit must be a positive finite number");
    } else if (maximum !== undefined && value > maximum) {
      add(failures, `resources.${name}`, "resource", "resource limit exceeds the isolation policy");
    }
  }
}

function validateCredentials(
  credentials: readonly WorkerCredential[] | undefined,
  policy: WorkerIsolationPolicy,
  failures: IsolationValidationFailure[],
): void {
  if (credentials === undefined) return;
  if (!Array.isArray(credentials)) {
    add(failures, "credentials", "invalid", "credentials must be an array");
    return;
  }
  const allowedNames = policy.credentials?.allowedNames ?? [];
  const allowedKinds = policy.credentials?.allowedKinds ?? [];
  for (const [index, credential] of credentials.entries()) {
    const credentialRecord: unknown = credential;
    if (
      !isRecord(credentialRecord) ||
      typeof credentialRecord.name !== "string" ||
      credentialRecord.name.trim() === ""
    ) {
      add(failures, `credentials[${index}]`, "credential", "credential must have a non-empty name");
      continue;
    }
    const typedCredential = credentialRecord as unknown as WorkerCredential;
    if (!allowedNames.includes(typedCredential.name)) {
      add(failures, `credentials[${index}].name`, "credential", "credential is not allowlisted");
    }
    if (typedCredential.kind !== undefined && !allowedKinds.includes(typedCredential.kind)) {
      add(failures, `credentials[${index}].kind`, "credential", "credential kind is not allowlisted");
    }
  }
}

/** Validate a worker request. All failures are blocking; none are warnings. */
export function validateWorkerIsolation(
  request: WorkerIsolationRequest,
  policy?: WorkerIsolationPolicy,
): IsolationValidationResult {
  const failures: IsolationValidationFailure[] = [];
  const candidate: unknown = request;
  if (!isRecord(candidate)) {
    add(failures, "request", "invalid", "worker isolation request must be an object");
    return { valid: false, failures, logFields: redactSecrets(candidate) };
  }
  const effectivePolicy = mergedPolicy(policy);
  validateMounts(request, effectivePolicy, failures);
  if (request.privileged === true) add(failures, "privileged", "privileged", "privileged mode is not permitted");
  if (request.capabilities !== undefined && !Array.isArray(request.capabilities)) {
    add(failures, "capabilities", "invalid", "capabilities must be an array");
  } else if (request.capabilities !== undefined) {
    const allowed = effectivePolicy.allowedCapabilities ?? [];
    for (const [index, capability] of request.capabilities.entries()) {
      if (
        typeof capability !== "string" ||
        !allowed.some((allowedCapability) => allowedCapability.toUpperCase() === capability.toUpperCase())
      ) {
        add(failures, `capabilities[${index}]`, "capability", "capability is not allowlisted");
      }
    }
  }
  const user = request.runAsUser !== undefined ? request.runAsUser : request.user;
  if (user !== undefined && typeof user !== "string" && typeof user !== "number") {
    add(failures, "user", "invalid", "worker user must be a string or number");
  } else if (isRoot(user)) add(failures, "user", "root", "worker must not execute as root");
  else if (effectivePolicy.requireNonRoot && user === undefined) {
    add(failures, "user", "root", "worker user must be explicitly non-root");
  }
  validateNetwork(request.network, effectivePolicy, failures);
  validateResources(request.resources, effectivePolicy, failures);
  validateCredentials(request.credentials, effectivePolicy, failures);
  return { valid: failures.length === 0, failures, logFields: redactSecrets(request.logFields) };
}

/** Throw a blocking error when a request violates the isolation policy. */
export function assertWorkerIsolation(
  request: WorkerIsolationRequest,
  policy?: WorkerIsolationPolicy,
): void {
  const result = validateWorkerIsolation(request, policy);
  if (!result.valid) throw new WorkerIsolationValidationError(result.failures);
}

/** Stateful facade for adapters that validate multiple worker launches. */
export class WorkerIsolationValidator {
  readonly #policy: WorkerIsolationPolicy;

  public constructor(policy?: WorkerIsolationPolicy) {
    this.#policy = mergedPolicy(policy);
  }

  public validate(request: WorkerIsolationRequest): IsolationValidationResult {
    return validateWorkerIsolation(request, this.#policy);
  }

  public assertValid(request: WorkerIsolationRequest): void {
    assertWorkerIsolation(request, this.#policy);
  }
}

export const DEFAULT_WORKER_ISOLATION_POLICY: WorkerIsolationPolicy = DEFAULT_POLICY;
