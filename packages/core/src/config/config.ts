import { readFileSync } from "node:fs";

/** Names of the only credentials that the worker runtime may receive. */
export const RUNTIME_CREDENTIAL_NAMES = ["LINEAR_API_TOKEN", "GITHUB_TOKEN"] as const;

export type RuntimeCredentialName = (typeof RUNTIME_CREDENTIAL_NAMES)[number];

export interface PortRange {
  readonly start: number;
  readonly end: number;
}

export interface ProjectConfig {
  readonly name: string;
  readonly linearTeam: string;
  readonly githubRepo: string;
  readonly defaultBranch: string;
}

/** Credential environment names are references, never credential values. */
export interface CredentialConfig {
  readonly linear: "LINEAR_API_TOKEN";
  readonly github: "GITHUB_TOKEN";
}

export interface FarmConfig {
  readonly projects: readonly ProjectConfig[];
  readonly statePath: string;
  readonly dockerPrefix: string;
  readonly portRange: PortRange;
  readonly baselineImage: string;
  readonly credentials: CredentialConfig;
}

export interface ConfigIssue {
  readonly path: string;
  readonly message: string;
}

export class ConfigValidationError extends Error {
  public readonly issues: readonly ConfigIssue[];

  public constructor(issues: readonly ConfigIssue[]) {
    // Deliberately format only schema paths and fixed diagnostic text. This
    // prevents a malformed value (which may be a secret) entering an error.
    super(issues.map(({ path, message }) => `${path}: ${message}`).join("; "));
    this.name = "ConfigValidationError";
    this.issues = issues.map(({ path, message }) => ({ path, message }));
  }

  public toJSON(): { name: string; issues: readonly ConfigIssue[] } {
    return { name: this.name, issues: this.issues };
  }
}

export class ProjectMappingError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ProjectMappingError";
  }
}

export class RuntimeCredentialError extends Error {
  public constructor(message: string) {
    // Callers provide only fixed messages and credential names, never values.
    super(message);
    this.name = "RuntimeCredentialError";
  }
}

export type RuntimeCredentialValues = Partial<Record<RuntimeCredentialName, string>>;

/** Read-only credential injection port used by provider adapters. */
export interface CredentialProvider {
  get(name: RuntimeCredentialName): string | undefined;
}

/** Alias for composition roots that name all injected dependencies as ports. */
export type CredentialPort = CredentialProvider;

const DEFAULT_CREDENTIALS: CredentialConfig = {
  linear: "LINEAR_API_TOKEN",
  github: "GITHUB_TOKEN",
};

const ownKeys = (value: object): string[] => Object.keys(value);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function addIssue(issues: ConfigIssue[], path: string, message: string): void {
  issues.push({ path, message });
}

function requiredString(value: unknown, path: string, issues: ConfigIssue[]): string | undefined {
  if (typeof value !== "string" || value.trim().length === 0) {
    addIssue(issues, path, "must be a non-empty string");
    return undefined;
  }
  if (value !== value.trim() || /[\u0000-\u001f\u007f]/.test(value)) {
    addIssue(issues, path, "contains invalid whitespace or control characters");
    return undefined;
  }
  return value;
}

function checkUnknownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  issues: ConfigIssue[],
): void {
  for (const key of ownKeys(value)) {
    if (!allowed.includes(key)) addIssue(issues, `${path}.${key}`, "is not supported");
  }
}

function parseProject(
  value: unknown,
  path: string,
  nameFromMap: string | undefined,
  issues: ConfigIssue[],
): ProjectConfig | undefined {
  if (!isRecord(value)) {
    addIssue(issues, path, "must be an object");
    return undefined;
  }
  checkUnknownKeys(value, ["name", "linearTeam", "githubRepo", "defaultBranch"], path, issues);

  const name = requiredString(nameFromMap ?? value.name, `${path}.name`, issues);
  if (nameFromMap !== undefined && value.name !== undefined && value.name !== nameFromMap) {
    addIssue(issues, `${path}.name`, "must match its project map key");
  }
  const linearTeam = requiredString(value.linearTeam, `${path}.linearTeam`, issues);
  const githubRepo = requiredString(value.githubRepo, `${path}.githubRepo`, issues);
  const defaultBranch = requiredString(value.defaultBranch, `${path}.defaultBranch`, issues);
  if (githubRepo !== undefined && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(githubRepo)) {
    addIssue(issues, `${path}.githubRepo`, "must be an owner/repository name");
  }
  if (linearTeam !== undefined && !/^[A-Za-z][A-Za-z0-9_-]*$/.test(linearTeam)) {
    addIssue(issues, `${path}.linearTeam`, "must be a valid team key");
  }
  if (
    defaultBranch !== undefined &&
    (defaultBranch.startsWith("/") ||
      defaultBranch.endsWith("/") ||
      defaultBranch.includes("..") ||
      /[~^:?*[\\\s\u0000-\u001f\u007f]/.test(defaultBranch))
  ) {
    addIssue(issues, `${path}.defaultBranch`, "must be a valid branch name");
  }
  if (
    name === undefined ||
    linearTeam === undefined ||
    githubRepo === undefined ||
    defaultBranch === undefined
  ) {
    return undefined;
  }
  return { name, linearTeam, githubRepo, defaultBranch };
}

function parseProjects(value: unknown, issues: ConfigIssue[]): ProjectConfig[] | undefined {
  const projects: ProjectConfig[] = [];
  if (Array.isArray(value)) {
    if (value.length === 0) addIssue(issues, "projects", "must contain at least one project");
    value.forEach((project, index) => {
      const parsed = parseProject(project, `projects[${index}]`, undefined, issues);
      if (parsed !== undefined) projects.push(parsed);
    });
  } else if (isRecord(value)) {
    const entries = Object.entries(value);
    if (entries.length === 0) addIssue(issues, "projects", "must contain at least one project");
    for (const [name, project] of entries) {
      const parsed = parseProject(project, `projects.${name}`, name, issues);
      if (parsed !== undefined) projects.push(parsed);
    }
  } else {
    addIssue(issues, "projects", "must be an array or object map");
    return undefined;
  }

  const names = new Set<string>();
  const linearTeams = new Set<string>();
  for (const project of projects) {
    if (names.has(project.name)) addIssue(issues, "projects", "project names must be unique");
    names.add(project.name);
    if (linearTeams.has(project.linearTeam)) {
      addIssue(issues, "projects", "linear team mappings must be unique");
    }
    linearTeams.add(project.linearTeam);
  }
  return projects;
}

function parsePortRange(value: unknown, issues: ConfigIssue[]): PortRange | undefined {
  if (!isRecord(value)) {
    addIssue(issues, "portRange", "must be an object");
    return undefined;
  }
  checkUnknownKeys(value, ["start", "end"], "portRange", issues);
  const start = value.start;
  const end = value.end;
  for (const [name, port] of [
    ["start", start],
    ["end", end],
  ] as const) {
    if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) {
      addIssue(issues, `portRange.${name}`, "must be an integer from 1 to 65535");
    }
  }
  if (
    typeof start === "number" &&
    Number.isInteger(start) &&
    typeof end === "number" &&
    Number.isInteger(end) &&
    start > end
  ) {
    addIssue(issues, "portRange", "start must not be greater than end");
  }
  if (
    typeof start !== "number" ||
    !Number.isInteger(start) ||
    start < 1 ||
    start > 65535 ||
    typeof end !== "number" ||
    !Number.isInteger(end) ||
    end < 1 ||
    end > 65535
  )
    return undefined;
  return { start, end };
}

function parseCredentials(value: unknown, issues: ConfigIssue[]): CredentialConfig {
  if (value === undefined) return DEFAULT_CREDENTIALS;
  if (!isRecord(value)) {
    addIssue(issues, "credentials", "must contain allowlisted environment names");
    return DEFAULT_CREDENTIALS;
  }
  checkUnknownKeys(value, ["linear", "github"], "credentials", issues);
  if (value.linear !== DEFAULT_CREDENTIALS.linear) {
    addIssue(issues, "credentials.linear", "must be LINEAR_API_TOKEN");
  }
  if (value.github !== DEFAULT_CREDENTIALS.github) {
    addIssue(issues, "credentials.github", "must be GITHUB_TOKEN");
  }
  return DEFAULT_CREDENTIALS;
}

/** Validate and normalize an already parsed config value. */
export function validateConfig(input: unknown): FarmConfig {
  const issues: ConfigIssue[] = [];
  if (!isRecord(input)) {
    throw new ConfigValidationError([{ path: "config", message: "must be an object" }]);
  }
  checkUnknownKeys(
    input,
    ["projects", "statePath", "dockerPrefix", "portRange", "baselineImage", "credentials"],
    "config",
    issues,
  );

  const projects = parseProjects(input.projects, issues);
  const statePath = requiredString(input.statePath, "statePath", issues);
  const dockerPrefix = requiredString(input.dockerPrefix, "dockerPrefix", issues);
  const baselineImage = requiredString(input.baselineImage, "baselineImage", issues);
  const portRange = parsePortRange(input.portRange, issues);
  parseCredentials(input.credentials, issues);

  if (dockerPrefix !== undefined && !/^[a-z0-9][a-z0-9_.-]*$/.test(dockerPrefix)) {
    addIssue(
      issues,
      "dockerPrefix",
      "must start with a lowercase letter or digit and contain only [a-z0-9_.-]",
    );
  }
  if (baselineImage !== undefined && /[\s\u0000-\u001f\u007f]/.test(baselineImage)) {
    addIssue(issues, "baselineImage", "must not contain whitespace or control characters");
  }
  if (
    baselineImage !== undefined &&
    (baselineImage.includes("://") ||
      (baselineImage.includes("@") && !/@sha256:[a-f0-9]{64}$/.test(baselineImage)))
  ) {
    addIssue(
      issues,
      "baselineImage",
      "must be a container image reference, not a URL or credential-bearing reference",
    );
  }
  if (
    issues.length > 0 ||
    projects === undefined ||
    statePath === undefined ||
    dockerPrefix === undefined ||
    baselineImage === undefined ||
    portRange === undefined
  ) {
    throw new ConfigValidationError(issues);
  }
  return {
    projects,
    statePath,
    dockerPrefix,
    portRange,
    baselineImage,
    credentials: DEFAULT_CREDENTIALS,
  };
}

/**
 * Resolve an explicitly configured project mapping. No fallback project or
 * repository inference is permitted when a team is not mapped.
 */
export function projectForLinearTeam(
  projects: readonly ProjectConfig[],
  linearTeam: string,
): ProjectConfig {
  if (typeof linearTeam !== "string" || !linearTeam.trim()) {
    throw new ProjectMappingError("linear team must be a non-empty key");
  }
  const matches = projects.filter((project) => project.linearTeam === linearTeam);
  if (matches.length !== 1) {
    throw new ProjectMappingError("linear team is not mapped to exactly one project");
  }
  return matches[0];
}

/** Validate that a provider target is the exact configured repository mapping. */
export function validateProjectMapping(
  project: ProjectConfig,
  target: { readonly linearTeam: string; readonly githubRepo: string },
): void {
  if (project.linearTeam !== target.linearTeam || project.githubRepo !== target.githubRepo) {
    throw new ProjectMappingError("provider target does not match the configured project mapping");
  }
}

/** Parse JSON text or validate a parsed config without exposing its values in errors. */
export function loadConfig(input: unknown): FarmConfig {
  if (typeof input === "string") {
    try {
      return validateConfig(JSON.parse(input) as unknown);
    } catch (error) {
      if (error instanceof ConfigValidationError) throw error;
      throw new ConfigValidationError([{ path: "config", message: "must contain valid JSON" }]);
    }
  }
  return validateConfig(input);
}

/** Read a JSON config file while keeping filesystem and parse details out of diagnostics. */
export function loadConfigFile(path: string): FarmConfig {
  try {
    return loadConfig(readFileSync(path, "utf8"));
  } catch (error) {
    if (error instanceof ConfigValidationError) throw error;
    throw new ConfigValidationError([
      { path: "config", message: "could not read configuration file" },
    ]);
  }
}

function validateCredentialValues(input: unknown): RuntimeCredentialValues {
  if (!isRecord(input)) throw new RuntimeCredentialError("credentials must be an object");
  for (const key of ownKeys(input)) {
    if (!(RUNTIME_CREDENTIAL_NAMES as readonly string[]).includes(key)) {
      throw new RuntimeCredentialError(`credential ${key} is not allowlisted`);
    }
  }
  const values: RuntimeCredentialValues = {};
  for (const name of RUNTIME_CREDENTIAL_NAMES) {
    const value = input[name];
    if (value !== undefined) {
      if (typeof value !== "string" || value.length === 0) {
        throw new RuntimeCredentialError(`credential ${name} must be a non-empty string`);
      }
      values[name] = value;
    }
  }
  return values;
}

/** Opaque runtime credentials. JSON and inspection intentionally reveal no values. */
export class RuntimeCredentials implements CredentialProvider {
  readonly #values: Readonly<RuntimeCredentialValues>;

  public constructor(input: RuntimeCredentialValues = {}) {
    this.#values = Object.freeze(validateCredentialValues(input));
  }

  public has(name: RuntimeCredentialName): boolean {
    return this.#values[name] !== undefined;
  }

  public get(name: RuntimeCredentialName): string | undefined {
    return this.#values[name];
  }

  /** Return an environment for a child process; only allowlisted names are copied. */
  public injectInto(environment: Readonly<Record<string, string>> = {}): Record<string, string> {
    return { ...environment, ...this.#values };
  }

  public toJSON(): string {
    return "[REDACTED CREDENTIALS]";
  }

  public toString(): string {
    return "[REDACTED CREDENTIALS]";
  }
}

export function credentialsFromEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): RuntimeCredentials {
  const values: RuntimeCredentialValues = {};
  for (const name of RUNTIME_CREDENTIAL_NAMES) {
    const value = environment[name];
    if (value !== undefined) values[name] = value;
  }
  return new RuntimeCredentials(values);
}

export function injectRuntimeCredentials(
  environment: Readonly<Record<string, string>>,
  credentials: RuntimeCredentials,
): Record<string, string> {
  if (!(credentials instanceof RuntimeCredentials)) {
    throw new RuntimeCredentialError("credentials must be RuntimeCredentials");
  }
  return credentials.injectInto(environment);
}

/** Serialize only non-secret configuration. Runtime credentials are separate by design. */
export function serializeConfig(config: FarmConfig): string {
  return JSON.stringify(config);
}
