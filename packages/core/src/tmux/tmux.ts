/** The command result returned by an injected tmux process boundary. */
export interface TmuxCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Runs a program without making the tmux integration depend on a process API.
 * Production code can adapt `child_process`, while tests can keep an in-memory
 * tmux server and record every invocation.
 */
export interface TmuxCommandRunner {
  run(command: string, args: readonly string[]): Promise<TmuxCommandResult>;
}

/** A tmux window managed by the developer session. */
export type TmuxWindowName = "pi" | "app" | "tests" | "shell";

export const DEFAULT_TMUX_SESSION = "dev";
export const DEFAULT_TMUX_WINDOWS: readonly TmuxWindowName[] = [
  "pi",
  "app",
  "tests",
  "shell",
];

export interface TmuxSessionOptions {
  readonly sessionName?: string;
  readonly windows?: readonly TmuxWindowName[];
}

export interface TmuxSession {
  readonly name: string;
  readonly windows: readonly TmuxWindowName[];
  /** True only when this call had to create the session. */
  readonly created: boolean;
}

/** Base class for failures at the tmux boundary. */
export class TmuxError extends Error {
  public constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "TmuxError";
  }
}

/** Input or result-shape failure, before a tmux command can be used safely. */
export class TmuxValidationError extends TmuxError {
  public constructor(message: string) {
    super(message);
    this.name = "TmuxValidationError";
  }
}

/** A tmux command returned a non-zero status. */
export class TmuxCommandError extends TmuxError {
  readonly command: string;
  readonly args: readonly string[];
  readonly exitCode: number;
  readonly stderr: string;

  public constructor(
    command: string,
    args: readonly string[],
    result: Pick<TmuxCommandResult, "exitCode" | "stderr">,
  ) {
    const safeArgs = args.map((arg) => redactTmuxText(arg));
    const safeStderr = redactTmuxText(result.stderr);
    super(
      `${command} ${safeArgs.join(" ")} failed with exit code ${result.exitCode}`
      + (safeStderr.length > 0 ? `: ${safeStderr}` : ""),
    );
    this.name = "TmuxCommandError";
    this.command = command;
    this.args = safeArgs;
    this.exitCode = result.exitCode;
    this.stderr = safeStderr;
  }
}

/** A session could not be inspected or created. */
export class TmuxSessionError extends TmuxError {
  readonly sessionName: string;

  public constructor(sessionName: string, message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "TmuxSessionError";
    this.sessionName = sessionName;
  }
}

/** A requested window target is not valid for the managed session. */
export class TmuxWindowError extends TmuxError {
  readonly windowName: string;

  public constructor(windowName: string, message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "TmuxWindowError";
    this.windowName = windowName;
  }
}

function requireNonEmpty(value: string, description: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.includes("\u0000")) {
    throw new TmuxValidationError(`${description} must be a non-empty string without NUL`);
  }
  return value;
}

function validateWindowName(name: string): TmuxWindowName {
  if (name !== "pi" && name !== "app" && name !== "tests" && name !== "shell") {
    throw new TmuxWindowError(name, `unsupported tmux window: ${name}`);
  }
  return name;
}

function validateWindows(windows: readonly TmuxWindowName[]): readonly TmuxWindowName[] {
  if (!Array.isArray(windows) || windows.length === 0) {
    throw new TmuxValidationError("tmux windows must contain at least one window");
  }
  const result: TmuxWindowName[] = [];
  const seen = new Set<TmuxWindowName>();
  for (const window of windows) {
    const validated = validateWindowName(window);
    if (!seen.has(validated)) {
      seen.add(validated);
      result.push(validated);
    }
  }
  return result;
}

function redactTmuxText(value: string): string {
  return value
    .replace(/(token|secret|password|passwd|authorization|api[-_]?key|credential)=([^\s]+)/giu, "$1=[REDACTED]")
    .replace(/\b(?:gh[pousr]|github_pat|glpat|sk)[-_][A-Za-z0-9_-]+\b/gu, "[REDACTED]");
}

function shellQuote(value: string): string {
  // Commands are shown to a POSIX shell in generated output. The runner path
  // never uses this function and passes command text as an argv element.
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** Generate a command that attaches interactively without changing the session. */
export function generateAttachCommand(sessionName = DEFAULT_TMUX_SESSION): string {
  requireNonEmpty(sessionName, "session name");
  return `tmux attach-session -t ${shellQuote(sessionName)}`;
}

/** Generate a command that sends one command to a managed window. */
export function generateExecCommand(
  window: TmuxWindowName,
  command: string,
  sessionName = DEFAULT_TMUX_SESSION,
): string {
  validateWindowName(window);
  requireNonEmpty(command, "command");
  requireNonEmpty(sessionName, "session name");
  return `tmux send-keys -t ${shellQuote(`${sessionName}:${window}`)} ${shellQuote(command)} C-m`;
}

/**
 * Idempotently provisions the detached `dev` session and its four windows.
 * This class never attaches, kills, or otherwise takes over an existing
 * session, so callers may safely reconcile it while a user is attached.
 */
export class TmuxSessionManager {
  readonly #runner: TmuxCommandRunner;
  readonly #sessionName: string;
  readonly #windows: readonly TmuxWindowName[];

  public constructor(runner: TmuxCommandRunner, options: TmuxSessionOptions = {}) {
    if (runner === null || typeof runner !== "object" || typeof runner.run !== "function") {
      throw new TmuxValidationError("a tmux command runner is required");
    }
    this.#runner = runner;
    this.#sessionName = requireNonEmpty(options.sessionName ?? DEFAULT_TMUX_SESSION, "session name");
    this.#windows = validateWindows(options.windows ?? DEFAULT_TMUX_WINDOWS);
  }

  public get sessionName(): string {
    return this.#sessionName;
  }

  public get windows(): readonly TmuxWindowName[] {
    return this.#windows;
  }

  /** Create the session if absent, then reconcile all required windows. */
  public async ensure(): Promise<TmuxSession> {
    const hasSession = await this.#run(["has-session", "-t", this.#sessionName]);
    let created = false;
    const existingWindows = new Set<TmuxWindowName>();

    if (hasSession.exitCode === 0) {
      // An existing session is resumed in place; no attach is attempted.
    } else if (hasSession.exitCode === 1) {
      const args = ["new-session", "-d", "-s", this.#sessionName, "-n", this.#windows[0]];
      const createdSession = await this.#run(args);
      if (createdSession.exitCode !== 0) {
        throw new TmuxSessionError(
          this.#sessionName,
          "could not create tmux session",
          { cause: new TmuxCommandError("tmux", args, createdSession) },
        );
      }
      created = true;
      existingWindows.add(this.#windows[0]);
    } else {
      throw new TmuxSessionError(
        this.#sessionName,
        "could not inspect tmux session",
        { cause: new TmuxCommandError("tmux", ["has-session", "-t", this.#sessionName], hasSession) },
      );
    }

    const listed = await this.#run([
      "list-windows",
      "-t",
      this.#sessionName,
      "-F",
      "#{window_name}",
    ]);
    if (listed.exitCode !== 0) {
      throw new TmuxSessionError(
        this.#sessionName,
        "could not list tmux session windows",
        { cause: new TmuxCommandError("tmux", ["list-windows", "-t", this.#sessionName, "-F", "#{window_name}"], listed) },
      );
    }
    for (const line of listed.stdout.split(/\r?\n/)) {
      const window = line.trim();
      if (window === "pi" || window === "app" || window === "tests" || window === "shell") {
        existingWindows.add(window);
      }
    }

    for (const window of this.#windows) {
      if (existingWindows.has(window)) continue;
      const args = ["new-window", "-d", "-t", this.#sessionName, "-n", window];
      const createdWindow = await this.#run(args);
      if (createdWindow.exitCode !== 0) {
        throw new TmuxWindowError(
          window,
          `could not create tmux window ${window}`,
          { cause: new TmuxCommandError("tmux", args, createdWindow) },
        );
      }
      existingWindows.add(window);
    }

    return { name: this.#sessionName, windows: [...this.#windows], created };
  }

  /** Alias emphasizing that this operation is safe to repeat. */
  public createOrResume(): Promise<TmuxSession> {
    return this.ensure();
  }

  public attachCommand(): string {
    return generateAttachCommand(this.#sessionName);
  }

  public execCommand(window: TmuxWindowName, command: string): string {
    return generateExecCommand(window, command, this.#sessionName);
  }

  /** Send a command to a window without attaching the caller. */
  public async exec(window: TmuxWindowName, command: string): Promise<void> {
    validateWindowName(window);
    requireNonEmpty(command, "command");
    const args = ["send-keys", "-t", `${this.#sessionName}:${window}`, command, "C-m"];
    const result = await this.#run(args);
    if (result.exitCode !== 0) {
      throw new TmuxWindowError(
        window,
        `could not execute command in tmux window ${window}`,
        { cause: new TmuxCommandError("tmux", args, result) },
      );
    }
  }

  async #run(args: readonly string[]): Promise<TmuxCommandResult> {
    let result: TmuxCommandResult;
    try {
      result = await this.#runner.run("tmux", args);
    } catch (error) {
      throw new TmuxError(`tmux command failed to run: ${args.map((arg) => redactTmuxText(arg)).join(" ")}`, { cause: error });
    }
    if (
      result === null
      || typeof result !== "object"
      || !Number.isInteger(result.exitCode)
      || typeof result.stdout !== "string"
      || typeof result.stderr !== "string"
    ) {
      throw new TmuxError("tmux command runner returned an invalid result");
    }
    return result;
  }
}

/** Short factory for callers that prefer a function over `new`. */
export function createTmuxSessionManager(
  runner: TmuxCommandRunner,
  options?: TmuxSessionOptions,
): TmuxSessionManager {
  return new TmuxSessionManager(runner, options);
}

export const attachCommand = generateAttachCommand;
export const execCommand = generateExecCommand;