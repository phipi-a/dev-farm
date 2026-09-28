import type { EventData, WorkerEvent } from "./models";

export const REDACTED = "[REDACTED]";
export const CIRCULAR_VALUE = "[CIRCULAR]";

const SENSITIVE_KEY =
  /(?:password|passwd|secret|token|credential|authorization|cookie|private[_-]?key|client[_-]?secret|api[_-]?key|access[_-]?key|signing[_-]?key|refresh[_-]?token|id[_-]?token)/i;

export interface RedactionOptions {
  readonly secrets?: readonly string[];
  readonly replacement?: string;
}

function replaceSecrets(value: string, secrets: readonly string[], replacement: string): string {
  return secrets
    .filter((secret) => secret.length > 0)
    .reduce((result, secret) => result.split(secret).join(replacement), value);
}

function redact(
  value: unknown,
  options: Required<RedactionOptions>,
  key: string | undefined,
  seen: WeakSet<object>,
): unknown {
  if (key !== undefined && SENSITIVE_KEY.test(key)) return options.replacement;
  if (typeof value === "string") return replaceSecrets(value, options.secrets, options.replacement);
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return CIRCULAR_VALUE;
  seen.add(value);

  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    return {
      name: value.name,
      message: replaceSecrets(value.message, options.secrets, options.replacement),
    };
  }
  if (Array.isArray(value)) return value.map((item) => redact(item, options, undefined, seen));

  const result: Record<string, unknown> = {};
  for (const [childKey, childValue] of Object.entries(value)) {
    result[childKey] = redact(childValue, options, childKey, seen);
  }
  return result;
}

/** Recursively redacts credential-shaped keys and configured secret values. */
export function redactSecrets<T>(value: T, options: RedactionOptions = {}): T {
  const resolved: Required<RedactionOptions> = {
    secrets: options.secrets ?? [],
    replacement: options.replacement ?? REDACTED,
  };
  return redact(value, resolved, undefined, new WeakSet<object>()) as T;
}

export function redactEvent(event: WorkerEvent, options: RedactionOptions = {}): WorkerEvent {
  return {
    ...event,
    message: redactSecrets(event.message, options),
    data: redactSecrets(event.data, options) as EventData,
  };
}
