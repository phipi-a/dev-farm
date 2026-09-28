#!/usr/bin/env node

/**
 * The CLI is intentionally a thin boundary around FarmOperations. Runtime
 * composition is adapted in runtime.ts; this module owns parsing,
 * confirmation, output, and exit-code policy only.
 */

export const EXIT_CODES = {
  success: 0,
  usage: 2,
  operation: 3,
  confirmationRequired: 4,
} as const;

export type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];
export type CommandName =
  | "list"
  | "status"
  | "attach"
  | "shell"
  | "logs"
  | "preview"
  | "pr"
  | "continue"
  | "merge"
  | "stop"
  | "destroy";

export const COMMANDS: readonly CommandName[] = [
  "list",
  "status",
  "attach",
  "shell",
  "logs",
  "preview",
  "pr",
  "continue",
  "merge",
  "stop",
  "destroy",
];

export interface ParsedArguments {
  readonly command?: CommandName;
  readonly positionals: readonly string[];
  readonly options: Readonly<Record<string, string | boolean>>;
  readonly help: boolean;
  readonly json: boolean;
  readonly yes: boolean;
}

export class CliUsageError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "CliUsageError";
  }
}

/** Parse CLI arguments without consulting the environment or process state. */
export function parseArguments(argv: readonly string[]): ParsedArguments {
  const positionals: string[] = [];
  const options: Record<string, string | boolean> = {};
  let command: CommandName | undefined;
  let help = false;
  let json = false;
  let yes = false;
  let endOptions = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === undefined) continue;
    if (endOptions) {
      positionals.push(argument);
      continue;
    }
    if (argument === "--") {
      endOptions = true;
      continue;
    }
    if (argument === "-h" || argument === "--help") {
      help = true;
      continue;
    }
    if (argument === "-j" || argument === "--json") {
      json = true;
      options.json = true;
      continue;
    }
    if (argument === "-y" || argument === "--yes") {
      yes = true;
      options.yes = true;
      continue;
    }
    if (argument.startsWith("--")) {
      const raw = argument.slice(2);
      const equals = raw.indexOf("=");
      const key = equals === -1 ? raw : raw.slice(0, equals);
      if (!/^[a-z][a-z0-9-]*$/u.test(key)) {
        throw new CliUsageError(`invalid option: ${argument}`);
      }
      if (equals !== -1) {
        options[key] = raw.slice(equals + 1);
        continue;
      }
      const next = argv[index + 1];
      if (next !== undefined && !next.startsWith("-")) {
        options[key] = next;
        index += 1;
      } else {
        options[key] = true;
      }
      continue;
    }
    if (argument.startsWith("-") && argument !== "-") {
      throw new CliUsageError(`unknown option: ${argument}`);
    }
    if (command === undefined) {
      if (!COMMANDS.includes(argument as CommandName)) {
        throw new CliUsageError(`unknown command: ${argument}`);
      }
      command = argument as CommandName;
    } else {
      positionals.push(argument);
    }
  }

  if (options.format === "json" || options.output === "json") json = true;
  if (options.yes === true) yes = true;
  return { command, positionals, options, help, json, yes };
}

export interface FarmOperationRequest {
  readonly command: CommandName;
  readonly target?: string;
  readonly args: readonly string[];
  readonly options: Readonly<Record<string, string | boolean>>;
}

/**
 * Narrow seam for operations not currently provided by core. Implementations
 * should delegate to core/tool interfaces and must not put credentials in
 * returned values or error messages.
 */
export interface FarmOperations {
  list(request: FarmOperationRequest): Promise<unknown>;
  status(request: FarmOperationRequest): Promise<unknown>;
  attach(request: FarmOperationRequest): Promise<unknown>;
  shell(request: FarmOperationRequest): Promise<unknown>;
  logs(request: FarmOperationRequest): Promise<unknown>;
  preview(request: FarmOperationRequest): Promise<unknown>;
  pr(request: FarmOperationRequest): Promise<unknown>;
  continue(request: FarmOperationRequest): Promise<unknown>;
  merge(request: FarmOperationRequest): Promise<unknown>;
  stop(request: FarmOperationRequest): Promise<unknown>;
  destroy(request: FarmOperationRequest): Promise<unknown>;
}

export interface CliOutput {
  writeStdout(text: string): void;
  writeStderr(text: string): void;
  /** Return true only when the operator explicitly confirms. */
  confirm?(question: string): Promise<boolean>;
}

export interface CliDependencies {
  readonly operations: FarmOperations;
  readonly output?: CliOutput;
}

export interface CliResult {
  readonly exitCode: ExitCode;
  readonly stdout: string;
  readonly stderr: string;
}

export const USAGE = `Usage: agent-farm <command> [target] [options]

Commands:
  list       List developer farms
  status     Show farm status
  attach     Attach to the farm session
  shell      Open a shell in the farm
  logs       Show farm logs
  preview    Preview the proposed changes
  pr         Show or create the pull request
  continue   Continue a paused farm
  merge      Merge the pull request (requires --yes)
  stop       Stop the farm
  destroy    Destroy the farm (requires --yes)

Options:
  -j, --json       Emit machine-readable JSON
  -y, --yes        Confirm destructive operations
  -h, --help       Show help
`;

const DESTRUCTIVE_COMMANDS = new Set<CommandName>(["merge", "destroy"]);

/** Create an adapter that makes missing runtime integrations explicit. */
export function createUnavailableOperations(): FarmOperations {
  const unavailable = async (request: FarmOperationRequest): Promise<never> => {
    throw new Error(`core integration for '${request.command}' is not available`);
  };
  return {
    list: unavailable,
    status: unavailable,
    attach: unavailable,
    shell: unavailable,
    logs: unavailable,
    preview: unavailable,
    pr: unavailable,
    continue: unavailable,
    merge: unavailable,
    stop: unavailable,
    destroy: unavailable,
  };
}

function defaultOutput(): CliOutput {
  return {
    writeStdout: (text) => process.stdout.write(text),
    writeStderr: (text) => process.stderr.write(text),
    confirm: async (question) => {
      // readline is loaded only for the interactive executable path. Tests and
      // embedders can inject a deterministic confirmation function instead.
      const readline = await import("node:readline/promises");
      const terminal = readline.createInterface({ input: process.stdin, output: process.stderr });
      try {
        const answer = await terminal.question(`${question} [y/N] `);
        return answer.trim().toLowerCase() === "y" || answer.trim().toLowerCase() === "yes";
      } finally {
        terminal.close();
      }
    },
  };
}

function redact(value: unknown, key?: string): unknown {
  if (
    key !== undefined &&
    /(token|secret|password|credential|authorization|private.?key)/iu.test(key)
  ) {
    return "[REDACTED]";
  }
  if (typeof value === "string") {
    // Cover common bearer/basic forms and assignment-style secrets without
    // attempting to identify ordinary application output as a credential.
    return value
      .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/giu, "Bearer [REDACTED]")
      .replace(/\bBasic\s+[A-Za-z0-9._~+/=-]+/giu, "Basic [REDACTED]")
      .replace(/\b(token|secret|password|api[-_]?key)\s*[:=]\s*[^\s,;]+/giu, "$1=[REDACTED]");
  }
  if (Array.isArray(value)) return value.map((item) => redact(item));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entryValue]) => [
        entryKey,
        redact(entryValue, entryKey),
      ]),
    );
  }
  return value;
}

function humanValue(value: unknown, indent = ""): string {
  if (value === undefined || value === null) return "ok";
  if (typeof value !== "object") return String(value);
  if (Array.isArray(value)) {
    return value.length === 0
      ? "(none)"
      : value.map((item) => `${indent}- ${humanValue(item, `${indent}  `)}`).join("\n");
  }
  return Object.entries(value)
    .map(([key, item]) => `${indent}${key}: ${humanValue(item, `${indent}  `)}`)
    .join("\n");
}

function outputSuccess(value: unknown, json: boolean): string {
  const safe = redact(value);
  return json ? `${JSON.stringify(safe)}\n` : `${humanValue(safe)}\n`;
}

function outputError(error: unknown, json: boolean): string {
  const message = redact(error instanceof Error ? error.message : String(error));
  return json ? `${JSON.stringify({ error: message })}\n` : `Error: ${message}\n`;
}

/** Execute a command with injectable operations and output/confirmation ports. */
export async function runCli(
  argv: readonly string[],
  dependencies: CliDependencies,
): Promise<CliResult> {
  let parsed: ParsedArguments;
  try {
    parsed = parseArguments(argv);
  } catch (error) {
    const message = outputError(error, false);
    return { exitCode: EXIT_CODES.usage, stdout: "", stderr: `${message}${USAGE}` };
  }

  if (parsed.help || parsed.command === undefined) {
    const stdout = parsed.command === undefined && !parsed.help ? "" : USAGE;
    return {
      exitCode:
        parsed.command === undefined && !parsed.help ? EXIT_CODES.usage : EXIT_CODES.success,
      stdout,
      stderr: parsed.command === undefined && !parsed.help ? USAGE : "",
    };
  }

  const request: FarmOperationRequest = {
    command: parsed.command,
    target: parsed.positionals[0],
    args: parsed.positionals,
    options: parsed.options,
  };

  if (DESTRUCTIVE_COMMANDS.has(parsed.command) && !parsed.yes) {
    const confirm = dependencies.output?.confirm;
    if (
      confirm === undefined ||
      !(await confirm(
        `Confirm ${parsed.command}${request.target ? ` for ${request.target}` : ""}?`,
      ))
    ) {
      const error = outputError("confirmation required; pass --yes to continue", parsed.json);
      return { exitCode: EXIT_CODES.confirmationRequired, stdout: "", stderr: error };
    }
  }

  try {
    const operation = dependencies.operations[parsed.command];
    const value = await operation(request);
    return { exitCode: EXIT_CODES.success, stdout: outputSuccess(value, parsed.json), stderr: "" };
  } catch (error) {
    return {
      exitCode: EXIT_CODES.operation,
      stdout: "",
      stderr: outputError(error, parsed.json),
    };
  }
}

/** Run the CLI and write its result to an injected or process output port. */
export async function main(
  argv: readonly string[] = process.argv.slice(2),
  dependencies: CliDependencies = { operations: createUnavailableOperations() },
): Promise<number> {
  const result = await runCli(argv, dependencies);
  const output = dependencies.output ?? defaultOutput();
  if (result.stdout) output.writeStdout(result.stdout);
  if (result.stderr) output.writeStderr(result.stderr);
  return result.exitCode;
}

export * from "./runtime";

const invokedDirectly =
  process.argv[1]?.endsWith("/cli/src/index.ts") === true ||
  process.argv[1]?.endsWith("/cli/dist/index.js") === true ||
  process.argv[1]?.endsWith("/.bin/agent-farm") === true ||
  process.argv[1] === "agent-farm";
if (invokedDirectly) {
  void main().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
