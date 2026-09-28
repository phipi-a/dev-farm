import type { ContinueInjectionInput, ContinuePullRequestIdentity, ContinueWorkerResult } from "../continue/models";
import {
  QuestionDuplicateAnswerError,
  QuestionInvalidStateError,
  QuestionPendingError,
  QuestionProviderError,
  QuestionSignalError,
  QuestionValidationError,
  QuestionWorkerNotFoundError,
  QuestionWorkflowError,
  WAITING_FOR_INPUT_STATE,
  type QuestionAnswerRequest,
  type QuestionAnswerResult,
  type QuestionRecord,
  type QuestionRequest,
  type QuestionResult,
  type QuestionSignal,
  type QuestionWorkerRecord,
  type QuestionWorkflowDependencies,
} from "./models";
import { parseWorkerQuestionSignal, questionText, redactQuestionText } from "./signal";

function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.includes("\u0000")) {
    throw new QuestionValidationError(`${field} must be a non-empty string without NUL`);
  }
  return value.trim();
}

function timestamp(value: unknown, field: string): string {
  const result = requiredText(value, field);
  if (Number.isNaN(Date.parse(result))) throw new QuestionValidationError(`${field} must be a valid timestamp`);
  return result;
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new QuestionValidationError(`${field} must be a positive safe integer`);
  return value as number;
}

function identity(worker: QuestionWorkerRecord): ContinuePullRequestIdentity {
  const pullRequest = worker.pullRequest;
  const repository = pullRequest.repository;
  const result: ContinuePullRequestIdentity = {
    repository: {
      owner: requiredText(repository.owner, "pull request repository owner"),
      name: requiredText(repository.name, "pull request repository name"),
      defaultBranch: requiredText(repository.defaultBranch, "pull request repository default branch"),
      ...(repository.cloneUrl === undefined ? {} : { cloneUrl: requiredText(repository.cloneUrl, "pull request repository clone URL") }),
      ...(repository.webUrl === undefined ? {} : { webUrl: requiredText(repository.webUrl, "pull request repository web URL") }),
    },
    number: positiveInteger(pullRequest.number, "pull request number"),
    sourceBranch: requiredText(pullRequest.sourceBranch, "pull request source branch"),
    targetBranch: requiredText(pullRequest.targetBranch, "pull request target branch"),
    ...(pullRequest.headSha === undefined ? {} : { headSha: requiredText(pullRequest.headSha, "pull request head SHA") }),
  };
  if (result.sourceBranch !== requiredText(worker.branch, "worker branch")) {
    throw new QuestionValidationError("pull request source branch does not match worker branch");
  }
  if (result.targetBranch !== result.repository.defaultBranch) {
    throw new QuestionValidationError("pull request target branch does not match repository default branch");
  }
  if (worker.pullRequestNumber !== undefined && worker.pullRequestNumber !== result.number) {
    throw new QuestionValidationError("pull request identity does not match worker pull request number");
  }
  requiredText(worker.containerId, "worker containerId");
  requiredText(worker.workspacePath, "worker workspacePath");
  return result;
}

function diagnostic(error: unknown, sensitiveValues: readonly string[] = []): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactQuestionText(message, sensitiveValues).slice(0, 300);
}

function validSensitiveValues(value: readonly string[] | undefined): readonly string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new QuestionValidationError("sensitiveValues must be a list of strings");
  }
  return value;
}

function defaultQuestionId(input: { readonly worker: QuestionWorkerRecord; readonly askedAt: string; readonly question: string }): string {
  return `question-${input.worker.workerId}-${input.askedAt}-${input.question}`.replace(/[^A-Za-z0-9._-]+/gu, "-").slice(0, 180);
}

function commentBody(record: QuestionRecord): string {
  return `[worker-question:${record.questionId}]\nWorker ${record.workerId} is waiting for input (${record.askedAt}).\nQuestion: ${record.question}`;
}

function validateQuestionRecord(record: QuestionRecord): QuestionRecord {
  const question = questionText(record.question);
  const result: QuestionRecord = {
    questionId: requiredText(record.questionId, "questionId"),
    workerId: requiredText(record.workerId, "question workerId"),
    issueIdentifier: requiredText(record.issueIdentifier, "question issueIdentifier"),
    question,
    askedAt: timestamp(record.askedAt, "askedAt"),
    status: record.status,
    ...(record.answer === undefined ? {} : { answer: questionText(record.answer) }),
    ...(record.answeredAt === undefined ? {} : { answeredAt: timestamp(record.answeredAt, "answeredAt") }),
  };
  if (record.status !== "unanswered" && record.status !== "answered") throw new QuestionValidationError("question status is invalid");
  if (record.status === "unanswered" && (result.answer !== undefined || result.answeredAt !== undefined)) {
    throw new QuestionValidationError("unanswered question cannot contain an answer");
  }
  if (record.status === "answered" && (result.answer === undefined || result.answeredAt === undefined)) {
    throw new QuestionValidationError("answered question must contain an answer and timestamp");
  }
  return result;
}

/** Coordinates one worker question without owning CLI, Pi, tmux, Linear, or persistence adapters. */
export class QuestionWorkflow {
  readonly #dependencies: QuestionWorkflowDependencies;
  readonly #now: () => string;
  readonly #createQuestionId: NonNullable<QuestionWorkflowDependencies["createQuestionId"]>;
  readonly #answered = new Set<string>();

  public constructor(dependencies: QuestionWorkflowDependencies) {
    if (dependencies === null || typeof dependencies !== "object") throw new QuestionValidationError("question workflow dependencies are required");
    if (dependencies.state === undefined || dependencies.questions === undefined || dependencies.linear === undefined || dependencies.continuePort === undefined) {
      throw new QuestionValidationError("state, questions, linear, and continue ports are required");
    }
    this.#dependencies = dependencies;
    this.#now = dependencies.now ?? (() => new Date().toISOString());
    this.#createQuestionId = dependencies.createQuestionId ?? defaultQuestionId;
  }

  /** Parses and records a worker signal, transitioning exactly that worker to waiting_for_input. */
  public async ask(request: QuestionRequest): Promise<QuestionResult> {
    const workerId = requiredText(request?.workerId, "workerId");
    const sensitiveValues = validSensitiveValues(request.sensitiveValues);
    const parsed = parseWorkerQuestionSignal(request.signal);
    if (parsed === null) throw new QuestionSignalError("input is not a worker question signal");
    const question = questionText(parsed.question, sensitiveValues);
    const worker = await this.#worker(workerId);
    const existing = await this.#dependencies.questions.get(workerId);
    if (existing !== undefined && existing.status === "unanswered") {
      if (existing.question !== question) throw new QuestionPendingError(workerId);
      return { worker, question: validateQuestionRecord(existing), commentBody: commentBody(existing) };
    }
    if (worker.state !== "running") throw new QuestionInvalidStateError(workerId, worker.state, "running");
    const askedAt = timestamp(this.#now(), "askedAt");
    const questionId = requiredText(this.#createQuestionId({ worker, askedAt, question }), "questionId");
    const record = validateQuestionRecord({ questionId, workerId, issueIdentifier: requiredText(worker.issueIdentifier, "issueIdentifier"), question, askedAt, status: "unanswered" });
    const waiting = await this.#dependencies.state.transition(workerId, WAITING_FOR_INPUT_STATE, {
      actor: "question-workflow", reason: "worker requested input", expectedState: "running",
    });
    const saved = validateQuestionRecord(await this.#dependencies.questions.save(record));
    const body = commentBody(saved);
    try {
      await this.#dependencies.linear.addComment({ identifier: saved.issueIdentifier, body });
    } catch (error) {
      throw new QuestionWorkflowError(`could not record Linear question comment: ${diagnostic(error, sensitiveValues)}`, { cause: error });
    }
    return { worker: waiting, question: saved, commentBody: body };
  }

  async #worker(workerId: string): Promise<QuestionWorkerRecord> {
    const worker = await this.#dependencies.state.get(workerId);
    if (worker === undefined) throw new QuestionWorkerNotFoundError(workerId);
    return worker;
  }

  /** Alias for hosts that name the signal boundary receiveQuestion. */
  public receiveQuestion(request: QuestionRequest): ReturnType<QuestionWorkflow["ask"]> {
    return this.ask(request);
  }

  /** Records one safe answer and resumes the same container/workspace/branch/PR. */
  public async answer(request: QuestionAnswerRequest): Promise<QuestionAnswerResult> {
    const workerId = requiredText(request?.workerId, "workerId");
    const sensitiveValues = validSensitiveValues(request.sensitiveValues);
    const answer = questionText(request?.answer, sensitiveValues);
    const worker = await this.#worker(workerId);
    const pending = await this.#dependencies.questions.get(workerId);
    if (pending === undefined) throw new QuestionInvalidStateError(workerId, worker.state, "an unanswered question");
    const question = validateQuestionRecord(pending);
    if (question.status === "answered" || this.#answered.has(question.questionId)) throw new QuestionDuplicateAnswerError(workerId);
    if (worker.state !== WAITING_FOR_INPUT_STATE) {
      if (worker.state === "completed" || worker.state === "destroyed") throw new QuestionInvalidStateError(workerId, worker.state, "waiting_for_input");
      throw new QuestionInvalidStateError(workerId, worker.state, "waiting_for_input");
    }
    const answeredAt = timestamp(this.#now(), "answeredAt");
    const answered = validateQuestionRecord({ ...question, status: "answered", answer, answeredAt });
    this.#answered.add(question.questionId);
    const running = await this.#dependencies.state.transition(workerId, "running", {
      actor: "question-workflow", reason: "worker question answered", expectedState: WAITING_FOR_INPUT_STATE,
    });
    const saved = validateQuestionRecord(await this.#dependencies.questions.save(answered));
    let continued: ContinueWorkerResult;
    const continuation: ContinueInjectionInput = {
      workerId,
      containerId: requiredText(worker.containerId, "worker containerId"),
      workspacePath: requiredText(worker.workspacePath, "worker workspacePath"),
      branch: requiredText(worker.branch, "worker branch"),
      pullRequest: identity(worker),
      reason: "answer",
      instruction: saved.answer as string,
      preserveUncommittedWork: true,
    };
    try {
      continued = await this.#dependencies.continuePort.inject(continuation);
    } catch (error) {
      throw new QuestionProviderError(`could not continue worker after answer: ${diagnostic(error, sensitiveValues)}`, { cause: error });
    }
    if (continued === null || typeof continued !== "object" || (continued.status !== "completed" && continued.status !== "failed")) {
      throw new QuestionProviderError("continuation returned an invalid worker result");
    }
    return { worker: running, question: saved, answer: saved.answer as string, continued };
  }
}

export function createQuestionWorkflow(dependencies: QuestionWorkflowDependencies): QuestionWorkflow {
  return new QuestionWorkflow(dependencies);
}

export function parseQuestionSignal(input: unknown): QuestionSignal | null {
  return parseWorkerQuestionSignal(input);
}

export function parseWorkerQuestion(input: unknown): QuestionSignal | null {
  return parseWorkerQuestionSignal(input);
}
