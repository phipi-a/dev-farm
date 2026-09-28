/**
 * Pi's integration boundary for the farm.
 *
 * This module deliberately does not import a Pi SDK or implement farm
 * lifecycle behavior. The host adapts the shared-core orchestrator to
 * `PiOrchestrator`, then registers `extension.tools` with Pi. Consequently
 * the adapter is also the only dependency a test needs to fake.
 */

export const TOOL_NAMES = [
  "ticket_start",
  "ticket_start_all",
  "ticket_status",
  "ticket_continue",
  "ticket_logs",
  "ticket_attach",
  "ticket_merge",
  "ticket_stop",
  "ticket_destroy",
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

export interface TicketStartInput {
  readonly ticketId: string;
}

export interface TicketStartAllInput {
  readonly tickets?: readonly string[];
}

export interface TicketStatusInput {
  readonly ticketId?: string;
}

export interface TicketContinueInput {
  readonly ticketId: string;
}

export interface TicketLogsInput {
  readonly ticketId: string;
  readonly tail?: number;
}

export interface TicketAttachInput {
  readonly ticketId: string;
}

export type TicketMergeInput =
  | {
      readonly ticketId: string;
      /** A literal acknowledgement prevents a prompt or ticket from confirming a merge. */
      readonly confirm: true;
    }
  | {
      readonly ticketId: string;
      /** Alternative explicit acknowledgement for hosts that use operation tokens. */
      readonly confirmation: "merge";
    };

/** Stop is reversible, but it still changes a running worker and is explicit. */
export interface TicketStopInput {
  readonly ticketId: string;
  readonly confirm: true;
}

/** Destroy removes local worker state and always requires explicit confirmation. */
export interface TicketDestroyInput {
  readonly ticketId: string;
  readonly confirm: true;
}

export interface ToolInputMap {
  readonly ticket_start: TicketStartInput;
  readonly ticket_start_all: TicketStartAllInput;
  readonly ticket_status: TicketStatusInput;
  readonly ticket_continue: TicketContinueInput;
  readonly ticket_logs: TicketLogsInput;
  readonly ticket_attach: TicketAttachInput;
  readonly ticket_merge: TicketMergeInput;
  readonly ticket_stop: TicketStopInput;
  readonly ticket_destroy: TicketDestroyInput;
}

export type ToolInput<Name extends ToolName = ToolName> = ToolInputMap[Name];

/**
 * The shared-core orchestrator port consumed by this package. Implementations
 * own state, workspace, process, VCS, and remote-service behavior; this layer
 * only validates a tool request and delegates it once.
 *
 * `unknown` results keep the extension independent of the core's eventual
 * result model. A host can return its typed core result and the extension
 * preserves it after redacting sensitive fields.
 */
export interface PiOrchestrator {
  ticketStart(input: TicketStartInput): Promise<unknown>;
  ticketStartAll(input: TicketStartAllInput): Promise<unknown>;
  ticketStatus(input: TicketStatusInput): Promise<unknown>;
  ticketContinue(input: TicketContinueInput): Promise<unknown>;
  ticketLogs(input: TicketLogsInput): Promise<unknown>;
  ticketAttach(input: TicketAttachInput): Promise<unknown>;
  ticketMerge(input: TicketMergeInput): Promise<unknown>;
  ticketStop(input: TicketStopInput): Promise<unknown>;
  ticketDestroy(input: TicketDestroyInput): Promise<unknown>;
}

export interface ToolSchema {
  readonly type: "object";
  readonly properties: Readonly<Record<string, Record<string, unknown>>>;
  readonly required?: readonly string[];
  readonly additionalProperties: false;
}

export interface PiToolDefinition<Name extends ToolName = ToolName> {
  readonly name: Name;
  readonly description: string;
  readonly inputSchema: ToolSchema;
}

export interface ToolSuccess<Name extends ToolName = ToolName> {
  readonly ok: true;
  readonly tool: Name;
  readonly data: unknown;
}

export interface ToolFailure<Name extends ToolName = ToolName> {
  readonly ok: false;
  readonly tool: Name;
  readonly error: {
    readonly code: "invalid_input" | "confirmation_required" | "orchestrator_error";
    readonly message: string;
  };
}

export type ToolResult<Name extends ToolName = ToolName> = ToolSuccess<Name> | ToolFailure<Name>;

export class ToolInputError extends Error {
  public readonly code: "invalid_input" | "confirmation_required";

  public constructor(
    message: string,
    code: "invalid_input" | "confirmation_required" = "invalid_input",
  ) {
    super(message);
    this.name = "ToolInputError";
    this.code = code;
  }
}

// Ticket IDs cross workspace/process boundaries; do not accept path or ref syntax.
const STRING_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const SENSITIVE_KEY =
  /(token|secret|password|credential|authorization|cookie|private.?key|api.?key)/i;
const SECRET_VALUE = /(bearer\s+)[^\s]+/gi;
const SECRET_ASSIGNMENT =
  /((?:linear_api_token|github_token|token|secret|password|api[_-]?key)\s*[:=]\s*)[^\s,;]+/gi;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function rejectUnknownKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new ToolInputError(`unsupported input field: ${key}`);
  }
}

function requireObject(input: unknown): Record<string, unknown> {
  if (!isRecord(input)) throw new ToolInputError("input must be an object");
  return input;
}

function requireTicketId(value: unknown): string {
  if (typeof value !== "string" || !STRING_PATTERN.test(value)) {
    throw new ToolInputError("ticketId must be a valid ticket identifier");
  }
  return value;
}

function optionalTicketId(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  return requireTicketId(value);
}

function requireConfirmation(
  value: Record<string, unknown>,
  operation: "merge" | "stop" | "destroy",
): void {
  const confirmed = value.confirm === true || value.confirmation === operation;
  if (!confirmed)
    throw new ToolInputError(
      `${operation} requires explicit confirmation`,
      "confirmation_required",
    );
}

function parseInput<Name extends ToolName>(name: Name, input: unknown): ToolInputMap[Name] {
  const value = requireObject(input);
  switch (name) {
    case "ticket_start":
      rejectUnknownKeys(value, ["ticketId"]);
      return { ticketId: requireTicketId(value.ticketId) } as ToolInputMap[Name];
    case "ticket_start_all": {
      rejectUnknownKeys(value, ["tickets"]);
      if (value.tickets === undefined) return {} as ToolInputMap[Name];
      if (!Array.isArray(value.tickets) || value.tickets.length === 0) {
        throw new ToolInputError("tickets must be a non-empty array");
      }
      return { tickets: value.tickets.map(requireTicketId) } as unknown as ToolInputMap[Name];
    }
    case "ticket_status":
      rejectUnknownKeys(value, ["ticketId"]);
      return { ticketId: optionalTicketId(value.ticketId) } as ToolInputMap[Name];
    case "ticket_continue":
      rejectUnknownKeys(value, ["ticketId"]);
      return { ticketId: requireTicketId(value.ticketId) } as ToolInputMap[Name];
    case "ticket_logs": {
      rejectUnknownKeys(value, ["ticketId", "tail"]);
      const tail = value.tail;
      if (
        tail !== undefined &&
        (typeof tail !== "number" || !Number.isInteger(tail) || tail < 1 || tail > 10_000)
      ) {
        throw new ToolInputError("tail must be an integer from 1 to 10000");
      }
      return {
        ticketId: requireTicketId(value.ticketId),
        ...(tail === undefined ? {} : { tail }),
      } as ToolInputMap[Name];
    }
    case "ticket_attach":
      rejectUnknownKeys(value, ["ticketId"]);
      return { ticketId: requireTicketId(value.ticketId) } as ToolInputMap[Name];
    case "ticket_merge":
      rejectUnknownKeys(value, ["ticketId", "confirm", "confirmation"]);
      requireConfirmation(value, "merge");
      return {
        ticketId: requireTicketId(value.ticketId),
        ...(value.confirm === true ? { confirm: true as const } : {}),
        ...(value.confirmation === "merge" ? { confirmation: "merge" as const } : {}),
      } as ToolInputMap[Name];
    case "ticket_stop":
      rejectUnknownKeys(value, ["ticketId", "confirm"]);
      requireConfirmation(value, "stop");
      return { ticketId: requireTicketId(value.ticketId), confirm: true } as ToolInputMap[Name];
    case "ticket_destroy":
      rejectUnknownKeys(value, ["ticketId", "confirm"]);
      requireConfirmation(value, "destroy");
      return { ticketId: requireTicketId(value.ticketId), confirm: true } as ToolInputMap[Name];
  }
}

/** Validate and normalize an input without invoking the orchestrator. */
export function validateToolInput<Name extends ToolName>(
  name: Name,
  input: unknown,
): ToolInputMap[Name] {
  return parseInput(name, input);
}

function redact(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === "string") {
    return value.replace(SECRET_VALUE, "$1[REDACTED]").replace(SECRET_ASSIGNMENT, "$1[REDACTED]");
  }
  if (Array.isArray(value)) return value.map((item) => redact(item, seen));
  if (!isRecord(value)) return value;
  if (seen.has(value)) return "[REDACTED_CIRCULAR_VALUE]";
  seen.add(value);
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    result[key] = SENSITIVE_KEY.test(key) ? "[REDACTED]" : redact(item, seen);
  }
  return result;
}

const definitions: { [Name in ToolName]: PiToolDefinition<Name> } = {
  ticket_start: {
    name: "ticket_start",
    description: "Start the worker for one ticket.",
    inputSchema: {
      type: "object",
      properties: { ticketId: { type: "string" } },
      required: ["ticketId"],
      additionalProperties: false,
    },
  },
  ticket_start_all: {
    name: "ticket_start_all",
    description: "Start workers for all eligible tickets, or for the supplied ticket list.",
    inputSchema: {
      type: "object",
      properties: { tickets: { type: "array", items: { type: "string" }, minItems: 1 } },
      additionalProperties: false,
    },
  },
  ticket_status: {
    name: "ticket_status",
    description: "Read one ticket status, or all statuses when ticketId is omitted.",
    inputSchema: {
      type: "object",
      properties: { ticketId: { type: "string" } },
      additionalProperties: false,
    },
  },
  ticket_continue: {
    name: "ticket_continue",
    description: "Continue work for a paused or recoverable ticket.",
    inputSchema: {
      type: "object",
      properties: { ticketId: { type: "string" } },
      required: ["ticketId"],
      additionalProperties: false,
    },
  },
  ticket_logs: {
    name: "ticket_logs",
    description: "Read redacted worker logs for a ticket.",
    inputSchema: {
      type: "object",
      properties: {
        ticketId: { type: "string" },
        tail: { type: "integer", minimum: 1, maximum: 10000 },
      },
      required: ["ticketId"],
      additionalProperties: false,
    },
  },
  ticket_attach: {
    name: "ticket_attach",
    description: "Return the host attach target for a ticket worker.",
    inputSchema: {
      type: "object",
      properties: { ticketId: { type: "string" } },
      required: ["ticketId"],
      additionalProperties: false,
    },
  },
  ticket_merge: {
    name: "ticket_merge",
    description: "Merge a reviewed ticket branch after explicit confirmation.",
    inputSchema: {
      type: "object",
      properties: {
        ticketId: { type: "string" },
        confirm: { const: true },
        confirmation: { const: "merge" },
      },
      required: ["ticketId"],
      additionalProperties: false,
    },
  },
  ticket_stop: {
    name: "ticket_stop",
    description: "Stop a ticket worker after explicit confirmation.",
    inputSchema: {
      type: "object",
      properties: { ticketId: { type: "string" }, confirm: { const: true } },
      required: ["ticketId", "confirm"],
      additionalProperties: false,
    },
  },
  ticket_destroy: {
    name: "ticket_destroy",
    description: "Destroy local ticket worker state after explicit confirmation.",
    inputSchema: {
      type: "object",
      properties: { ticketId: { type: "string" }, confirm: { const: true } },
      required: ["ticketId", "confirm"],
      additionalProperties: false,
    },
  },
};

const methodByTool: {
  [Name in ToolName]: Name extends "ticket_start"
    ? "ticketStart"
    : Name extends "ticket_start_all"
      ? "ticketStartAll"
      : Name extends "ticket_status"
        ? "ticketStatus"
        : Name extends "ticket_continue"
          ? "ticketContinue"
          : Name extends "ticket_logs"
            ? "ticketLogs"
            : Name extends "ticket_attach"
              ? "ticketAttach"
              : Name extends "ticket_merge"
                ? "ticketMerge"
                : Name extends "ticket_stop"
                  ? "ticketStop"
                  : "ticketDestroy";
} = {
  ticket_start: "ticketStart",
  ticket_start_all: "ticketStartAll",
  ticket_status: "ticketStatus",
  ticket_continue: "ticketContinue",
  ticket_logs: "ticketLogs",
  ticket_attach: "ticketAttach",
  ticket_merge: "ticketMerge",
  ticket_stop: "ticketStop",
  ticket_destroy: "ticketDestroy",
};

export interface PiExtension {
  readonly tools: readonly PiToolDefinition[];
  invoke<Name extends ToolName>(name: Name, input: unknown): Promise<ToolResult<Name>>;
}

/**
 * The small part of Pi's extension host used by this package.  The concrete
 * SDK is intentionally not a dependency of the core workspace: Pi supplies
 * `registerTool`, while this package supplies the registration descriptor and
 * execution bridge.
 */
export interface PiExtensionHost<Schema = ToolSchema> {
  registerTool(tool: PiRegisteredTool<Schema>): void;
}

/** The result shape consumed by Pi's ExtensionAPI.registerTool callback. */
export interface PiRegisteredToolResult {
  readonly content: { readonly type: "text"; readonly text: string }[];
  readonly details: ToolResult;
}

export type PiToolUpdate = (update: PiRegisteredToolResult) => void;

/** Structural equivalent of Pi's registerTool descriptor, without importing its SDK. */
export interface PiRegisteredTool<Schema = ToolSchema> {
  readonly name: ToolName;
  readonly label: string;
  readonly description: string;
  readonly parameters: Schema;
  execute(
    toolCallId: string,
    parameters: unknown,
    signal: AbortSignal | undefined,
    onUpdate: PiToolUpdate | undefined,
    context: unknown,
  ): Promise<PiRegisteredToolResult>;
}

/** The runtime surface needed by the registration boundary. */
export interface PiRuntimeService {
  readonly orchestrator: PiOrchestrator;
}

/** Create the SDK-neutral Pi boundary around a shared-core orchestrator. */
export function createPiExtension(orchestrator: PiOrchestrator): PiExtension {
  if (orchestrator === null || typeof orchestrator !== "object") {
    throw new Error("a core orchestrator adapter is required");
  }

  return {
    tools: TOOL_NAMES.map((name) => definitions[name]),
    async invoke<Name extends ToolName>(name: Name, input: unknown): Promise<ToolResult<Name>> {
      if (!TOOL_NAMES.includes(name)) {
        return {
          ok: false,
          tool: name,
          error: { code: "invalid_input", message: "unknown tool" },
        } as ToolResult<Name>;
      }
      try {
        const normalized = parseInput(name, input);
        const method = methodByTool[name] as keyof PiOrchestrator;
        const data = await (orchestrator[method] as (request: ToolInput<Name>) => Promise<unknown>)(
          normalized,
        );
        return { ok: true, tool: name, data: redact(data) };
      } catch (error) {
        if (error instanceof ToolInputError) {
          return { ok: false, tool: name, error: { code: error.code, message: error.message } };
        }
        // Do not expose adapter errors: they may contain command output,
        // filesystem paths, credentials, or provider response bodies.
        return {
          ok: false,
          tool: name,
          error: { code: "orchestrator_error", message: "tool operation failed" },
        };
      }
    },
  };
}

/** Tool descriptors ready to be translated to a Pi SDK registration shape. */
export const PI_TOOL_DEFINITIONS: readonly PiToolDefinition[] = TOOL_NAMES.map(
  (name) => definitions[name],
);

function resultText(result: ToolResult): string {
  if (!result.ok) return result.error.message;
  try {
    const serialized = JSON.stringify(result.data);
    return serialized === undefined ? String(result.data) : serialized;
  } catch {
    // `redact` has already run; avoid leaking a value by stringifying an
    // untrusted result again when a host-specific value is not serializable.
    return "tool operation completed";
  }
}

function registeredResult(result: ToolResult): PiRegisteredToolResult {
  return {
    content: [{ type: "text", text: resultText(result) }],
    details: result,
  };
}

/**
 * Register all ticket tools with Pi's actual host registration surface.
 *
 * The generic schema parameter lets an installed Pi SDK use its own schema
 * type (for example TypeBox's `TSchema`) at the call site.  The host adapter
 * owns that conversion; the execution path remains the validated,
 * redacted, confirmation-gated path in `createPiExtension`.
 */
export function registerPiTools<Schema = ToolSchema>(
  host: PiExtensionHost<Schema>,
  orchestrator: PiOrchestrator,
): PiExtension {
  if (host === null || typeof host !== "object" || typeof host.registerTool !== "function") {
    throw new Error("a Pi extension host with registerTool is required");
  }
  const extension = createPiExtension(orchestrator);
  for (const definition of extension.tools) {
    const name = definition.name;
    host.registerTool({
      name,
      label: name,
      description: definition.description,
      parameters: definition.inputSchema as Schema,
      execute: async (_toolCallId, parameters, _signal, _onUpdate, _context) =>
        registeredResult(await extension.invoke(name, parameters)),
    });
  }
  return extension;
}

/** Register tools against a runtime created by the DEV-31 composition root. */
export function registerRuntimePiTools<Schema = ToolSchema>(
  host: PiExtensionHost<Schema>,
  runtime: PiRuntimeService,
): PiExtension {
  if (runtime === null || typeof runtime !== "object") {
    throw new Error("a runtime service is required");
  }
  return registerPiTools(host, runtime.orchestrator);
}
