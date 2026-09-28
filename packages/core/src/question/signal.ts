import { QuestionSignalError, type QuestionSignal } from "./models";

const MAX_QUESTION_LENGTH = 2_000;
const SECRET_PATTERNS = [
  /\b(?:ghp|gho|ghs|ghu|github_pat)[-_][A-Za-z0-9_-]+/gu,
  /\bglpat-[A-Za-z0-9_-]+/gu,
  /\bsk-[A-Za-z0-9_-]+/gu,
  /\bxox[baprs]-[A-Za-z0-9-]+/gu,
  /-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z0-9]+)* PRIVATE KEY-----/gu,
];
const BEARER_SECRET_PATTERN = /(\bBearer\s+)[A-Za-z0-9._~+/=-]+/giu;
const QUERY_SECRET_PATTERN = /([?&](?:token|access_token|api[_-]?key|password|secret)=)[^&\s]+/giu;
const ASSIGNMENT_SECRET_PATTERN = /(\b(?:token|access[_-]?token|api[_-]?key|password|secret|authorization)\s*[:=])\s*(?:Bearer\s+)?[^\s,;]+/giu;

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.includes("\u0000")) {
    throw new QuestionSignalError(`${field} must be a non-empty string without NUL`);
  }
  const result = value.trim();
  if (result.length > MAX_QUESTION_LENGTH) throw new QuestionSignalError(`${field} exceeds ${MAX_QUESTION_LENGTH} characters`);
  return result;
}

/** Redacts configured values and common credential forms before persistence or provider output. */
export function redactQuestionText(value: string, sensitiveValues: readonly string[] = []): string {
  let result = value;
  for (const secret of sensitiveValues) {
    if (typeof secret !== "string") throw new QuestionSignalError("sensitiveValues must be a list of strings");
    if (secret.length > 0) result = result.replaceAll(secret, "[REDACTED]");
  }
  for (const pattern of SECRET_PATTERNS) result = result.replace(pattern, "[REDACTED]");
  return result.replace(BEARER_SECRET_PATTERN, "$1[REDACTED]").replace(QUERY_SECRET_PATTERN, "$1[REDACTED]").replace(ASSIGNMENT_SECRET_PATTERN, "$1[REDACTED]");
}

function signalObject(value: Record<string, unknown>): QuestionSignal | null {
  const type = value.type ?? value.kind ?? value.event;
  const isQuestion = type === "worker_question" || type === "worker.question" || type === "question";
  if (!isQuestion) return null;
  const question = value.question ?? value.text ?? value.message;
  return { type: "worker_question", question: text(question, "question") };
}

/**
 * Parses the standard JSON worker question signal and the line-oriented form
 * emitted by simple workers (`WORKER_QUESTION: ...`). Non-question output is
 * ignored so callers can feed this function a complete worker stream.
 */
export function parseWorkerQuestionSignal(input: unknown): QuestionSignal | null {
  if (input !== null && typeof input === "object" && !Array.isArray(input)) {
    return signalObject(input as Record<string, unknown>);
  }
  if (typeof input !== "string") return null;
  const source = input.trim();
  if (source.length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(source);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) return signalObject(parsed as Record<string, unknown>);
  } catch {
    // The line-oriented signal is handled below.
  }
  const marker = source.match(/^(?:WORKER_QUESTION|WORKER QUESTION|QUESTION)\s*:\s*([\s\S]+)$/iu);
  if (marker?.[1] !== undefined) return { type: "worker_question", question: text(marker[1], "question") };
  const xml = source.match(/^<worker-question>\s*([\s\S]+?)\s*<\/worker-question>$/iu);
  if (xml?.[1] !== undefined) return { type: "worker_question", question: text(xml[1], "question") };
  return null;
}

export function questionText(value: unknown, sensitiveValues: readonly string[] = []): string {
  const checked = text(value, "question");
  const redacted = redactQuestionText(checked, sensitiveValues).trim();
  if (redacted.length === 0) throw new QuestionSignalError("question must contain text after redaction");
  return redacted;
}

export const QUESTION_MAX_LENGTH = MAX_QUESTION_LENGTH;
