import type { QuestionMetadataPort, QuestionRecord } from "../question/models";
import { redactQuestionText } from "../question/signal";
import type { SqliteDatabase, StateDatabaseOptions } from "./database";
import { openSqliteDatabase } from "./sqlite";
import {
  canTransition,
  isWorkerState,
  RECOVERY_STATES,
  type RecoveryRecord,
  type TransitionOptions,
  type WorkerInput,
  type WorkerListFilter,
  type WorkerRecord,
  type WorkerState,
  type WorkerTransition,
} from "./models";

export const STATE_SCHEMA_VERSION = 2;

const QUESTION_MAX_LENGTH = 2_000;

export class StateStoreError extends Error {
  public constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "StateStoreError";
  }
}

export class WorkerNotFoundError extends StateStoreError {
  public constructor(workerId: string) {
    super(`worker ${workerId} was not found`);
    this.name = "WorkerNotFoundError";
  }
}

export class InvalidWorkerTransitionError extends StateStoreError {
  public constructor(from: WorkerState, to: WorkerState) {
    super(`invalid worker transition: ${from} -> ${to}`);
    this.name = "InvalidWorkerTransitionError";
  }
}

type WorkerRow = Record<string, unknown>;
type TransitionRow = Record<string, unknown>;

const WORKER_COLUMNS = [
  "worker_id", "issue_identifier", "project", "repository", "mapping_version", "state", "reason",
  "process_id", "session_name", "workspace_path", "branch", "base_commit", "commit_sha", "image_digest",
  "pull_request_number", "correlation_id", "snapshot_id", "last_error", "created_at", "updated_at",
  "last_transition_at",
] as const;

const QUESTION_COLUMNS = [
  "question_id", "worker_id", "issue_identifier", "question", "asked_at", "status", "answer", "answered_at",
] as const;

const RECOVERY_STATE_SQL = RECOVERY_STATES.map((state) => `'${state}'`).join(", ");

function text(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.length === 0 || value.includes("\u0000")) {
    throw new StateStoreError(`${field} must be a non-empty string without NUL`);
  }
  return value;
}

function requiredText(value: unknown, field: string): string {
  const result = text(value, field);
  if (result === undefined) throw new StateStoreError(`${field} is required`);
  return result;
}

function integer(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new StateStoreError(`${field} must be a positive safe integer`);
  }
  return value;
}

function timestamp(value: string | Date | undefined, field: string): string {
  const result = value instanceof Date ? value.toISOString() : value ?? new Date().toISOString();
  if (typeof result !== "string" || result.length === 0 || Number.isNaN(Date.parse(result))) {
    throw new StateStoreError(`${field} must be a valid timestamp`);
  }
  return result;
}

function optionalTimestamp(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  return timestamp(String(value), field);
}

function rowValue(row: WorkerRow, name: string): unknown {
  return row[name];
}

function rowToWorker(row: WorkerRow): WorkerRecord {
  const state = rowValue(row, "state");
  if (!isWorkerState(state)) throw new StateStoreError("database contains an invalid worker state");
  const processId = rowValue(row, "process_id");
  const pullRequestNumber = rowValue(row, "pull_request_number");
  return {
    workerId: requiredText(rowValue(row, "worker_id"), "workerId"),
    issueIdentifier: text(rowValue(row, "issue_identifier"), "issueIdentifier"),
    project: text(rowValue(row, "project"), "project"),
    repository: text(rowValue(row, "repository"), "repository"),
    mappingVersion: text(rowValue(row, "mapping_version"), "mappingVersion"),
    state,
    reason: text(rowValue(row, "reason"), "reason"),
    processId: processId === null || processId === undefined ? undefined : Number(processId),
    sessionName: text(rowValue(row, "session_name"), "sessionName"),
    workspacePath: text(rowValue(row, "workspace_path"), "workspacePath"),
    branch: text(rowValue(row, "branch"), "branch"),
    baseCommit: text(rowValue(row, "base_commit"), "baseCommit"),
    commitSha: text(rowValue(row, "commit_sha"), "commitSha"),
    imageDigest: text(rowValue(row, "image_digest"), "imageDigest"),
    pullRequestNumber: pullRequestNumber === null || pullRequestNumber === undefined ? undefined : Number(pullRequestNumber),
    correlationId: text(rowValue(row, "correlation_id"), "correlationId"),
    snapshotId: text(rowValue(row, "snapshot_id"), "snapshotId"),
    lastError: text(rowValue(row, "last_error"), "lastError"),
    createdAt: requiredText(rowValue(row, "created_at"), "createdAt"),
    updatedAt: requiredText(rowValue(row, "updated_at"), "updatedAt"),
    lastTransitionAt: requiredText(rowValue(row, "last_transition_at"), "lastTransitionAt"),
  };
}

function rowToTransition(row: TransitionRow): WorkerTransition {
  const from = row.from_state;
  if (from !== null && !isWorkerState(from)) throw new StateStoreError("database contains an invalid prior state");
  const to = row.to_state;
  if (!isWorkerState(to)) throw new StateStoreError("database contains an invalid transition state");
  return {
    id: Number(row.id),
    workerId: requiredText(row.worker_id, "workerId"),
    fromState: from as WorkerState | null,
    toState: to,
    actor: requiredText(row.actor, "actor"),
    reason: text(row.reason, "reason"),
    providerEvidence: text(row.provider_evidence, "providerEvidence"),
    occurredAt: requiredText(row.occurred_at, "occurredAt"),
  };
}

function questionText(value: unknown, field: string): string {
  const result = text(value, field);
  if (result === undefined) throw new StateStoreError(`${field} is required`);
  if (result.length > QUESTION_MAX_LENGTH) throw new StateStoreError(`${field} exceeds ${QUESTION_MAX_LENGTH} characters`);
  const redacted = redactQuestionText(result).trim();
  if (redacted.length === 0) throw new StateStoreError(`${field} must contain text after redaction`);
  if (redacted.length > QUESTION_MAX_LENGTH) throw new StateStoreError(`${field} exceeds ${QUESTION_MAX_LENGTH} characters`);
  return redacted;
}

function rowToQuestion(row: WorkerRow): QuestionRecord {
  const status = row.status;
  if (status !== "unanswered" && status !== "answered") throw new StateStoreError("database contains an invalid question status");
  const answer = row.answer === null || row.answer === undefined ? undefined : questionText(row.answer, "answer");
  const answeredAt = optionalTimestamp(row.answered_at, "answeredAt");
  const askedAt = timestamp(String(row.asked_at), "askedAt");
  if (status === "unanswered" && (answer !== undefined || answeredAt !== undefined)) {
    throw new StateStoreError("database contains an unanswered question with an answer");
  }
  if (status === "answered" && (answer === undefined || answeredAt === undefined)) {
    throw new StateStoreError("database contains an answered question without an answer");
  }
  return {
    questionId: requiredText(row.question_id, "questionId"),
    workerId: requiredText(row.worker_id, "question workerId"),
    issueIdentifier: requiredText(row.issue_identifier, "question issueIdentifier"),
    question: questionText(row.question, "question"),
    askedAt,
    status,
    ...(answer === undefined ? {} : { answer }),
    ...(answeredAt === undefined ? {} : { answeredAt }),
  };
}

function toDbValue(value: unknown): unknown {
  return value === undefined ? null : value;
}

/** Persistent, synchronous SQLite store for worker lifecycle state. */
export class WorkerStateStore {
  readonly #database: SqliteDatabase;
  readonly #ownsDatabase: boolean;
  readonly #schemaVersion: number;

  public constructor(options: StateDatabaseOptions | string = {}) {
    const normalized: StateDatabaseOptions = typeof options === "string" ? { path: options } : options;
    if (normalized === null || typeof normalized !== "object") throw new StateStoreError("database options are required");
    this.#database = normalized.database ?? openSqliteDatabase(normalized.path ?? "./state.sqlite");
    this.#ownsDatabase = normalized.database === undefined;
    this.#schemaVersion = this.migrate();
  }

  public get schemaVersion(): number {
    return this.#schemaVersion;
  }

  public close(): void {
    if (this.#ownsDatabase) this.#database.close?.();
  }

  private transaction<T>(operation: () => T): T {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.#database.exec("COMMIT");
      return result;
    } catch (error) {
      try { this.#database.exec("ROLLBACK"); } catch { /* preserve the operation error */ }
      throw error;
    }
  }

  private migrate(): number {
    return this.transaction(() => {
      this.#database.exec(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          version INTEGER PRIMARY KEY,
          applied_at TEXT NOT NULL
        );
      `);
      const latest = this.#database.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations").get();
      const version = Number(latest?.version ?? 0);
      if (!Number.isInteger(version) || version > STATE_SCHEMA_VERSION) {
        throw new StateStoreError(`unsupported state schema version: ${version}`);
      }
      if (version < 1) {
        this.#database.exec(`
          CREATE TABLE workers (
            worker_id TEXT PRIMARY KEY NOT NULL,
            issue_identifier TEXT,
            project TEXT,
            repository TEXT,
            mapping_version TEXT,
            state TEXT NOT NULL CHECK (state IN ('queued','provisioning','running','waiting_for_input','awaiting-review','paused','recovering','stopped','failed','destroyed')),
            reason TEXT,
            process_id INTEGER,
            session_name TEXT,
            workspace_path TEXT,
            branch TEXT,
            base_commit TEXT,
            commit_sha TEXT,
            image_digest TEXT,
            pull_request_number INTEGER,
            correlation_id TEXT,
            snapshot_id TEXT,
            last_error TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            last_transition_at TEXT NOT NULL
          );
          CREATE INDEX workers_state_idx ON workers(state);
          CREATE INDEX workers_project_idx ON workers(project);
          CREATE TABLE worker_transitions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            worker_id TEXT NOT NULL REFERENCES workers(worker_id) ON DELETE CASCADE,
            from_state TEXT,
            to_state TEXT NOT NULL,
            actor TEXT NOT NULL,
            reason TEXT,
            provider_evidence TEXT,
            occurred_at TEXT NOT NULL
          );
          CREATE INDEX worker_transitions_worker_idx ON worker_transitions(worker_id, id);
          CREATE TABLE questions (
            question_id TEXT PRIMARY KEY NOT NULL,
            worker_id TEXT NOT NULL REFERENCES workers(worker_id) ON DELETE CASCADE,
            issue_identifier TEXT NOT NULL,
            question TEXT NOT NULL,
            asked_at TEXT NOT NULL,
            status TEXT NOT NULL CHECK (status IN ('unanswered','answered')),
            answer TEXT,
            answered_at TEXT,
            CHECK ((status = 'unanswered' AND answer IS NULL AND answered_at IS NULL) OR
                   (status = 'answered' AND answer IS NOT NULL AND answered_at IS NOT NULL))
          );
          CREATE INDEX questions_worker_idx ON questions(worker_id, asked_at DESC, question_id DESC);
          INSERT INTO schema_migrations(version, applied_at) VALUES (2, CURRENT_TIMESTAMP);
        `);
      } else if (version < 2) {
        // SQLite cannot alter a CHECK constraint. Rebuild both related tables so
        // existing workers and their complete transition history survive v1 -> v2.
        this.#database.exec(`
          CREATE TABLE workers_v2 (
            worker_id TEXT PRIMARY KEY NOT NULL,
            issue_identifier TEXT,
            project TEXT,
            repository TEXT,
            mapping_version TEXT,
            state TEXT NOT NULL CHECK (state IN ('queued','provisioning','running','waiting_for_input','awaiting-review','paused','recovering','stopped','failed','destroyed')),
            reason TEXT,
            process_id INTEGER,
            session_name TEXT,
            workspace_path TEXT,
            branch TEXT,
            base_commit TEXT,
            commit_sha TEXT,
            image_digest TEXT,
            pull_request_number INTEGER,
            correlation_id TEXT,
            snapshot_id TEXT,
            last_error TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            last_transition_at TEXT NOT NULL
          );
          INSERT INTO workers_v2 SELECT * FROM workers;
          CREATE TABLE worker_transitions_v2 (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            worker_id TEXT NOT NULL REFERENCES workers_v2(worker_id) ON DELETE CASCADE,
            from_state TEXT,
            to_state TEXT NOT NULL,
            actor TEXT NOT NULL,
            reason TEXT,
            provider_evidence TEXT,
            occurred_at TEXT NOT NULL
          );
          INSERT INTO worker_transitions_v2 SELECT * FROM worker_transitions;
          DROP TABLE worker_transitions;
          DROP TABLE workers;
          ALTER TABLE workers_v2 RENAME TO workers;
          ALTER TABLE worker_transitions_v2 RENAME TO worker_transitions;
          CREATE INDEX workers_state_idx ON workers(state);
          CREATE INDEX workers_project_idx ON workers(project);
          CREATE INDEX worker_transitions_worker_idx ON worker_transitions(worker_id, id);
          CREATE TABLE questions (
            question_id TEXT PRIMARY KEY NOT NULL,
            worker_id TEXT NOT NULL REFERENCES workers(worker_id) ON DELETE CASCADE,
            issue_identifier TEXT NOT NULL,
            question TEXT NOT NULL,
            asked_at TEXT NOT NULL,
            status TEXT NOT NULL CHECK (status IN ('unanswered','answered')),
            answer TEXT,
            answered_at TEXT,
            CHECK ((status = 'unanswered' AND answer IS NULL AND answered_at IS NULL) OR
                   (status = 'answered' AND answer IS NOT NULL AND answered_at IS NOT NULL))
          );
          CREATE INDEX questions_worker_idx ON questions(worker_id, asked_at DESC, question_id DESC);
          INSERT INTO schema_migrations(version, applied_at) VALUES (2, CURRENT_TIMESTAMP);
        `);
      }
      return STATE_SCHEMA_VERSION;
    });
  }

  public create(input: WorkerInput): WorkerRecord {
    const workerId = requiredText(input?.workerId, "workerId");
    const state = input.state ?? "queued";
    if (!isWorkerState(state)) throw new StateStoreError("state is invalid");
    const now = new Date().toISOString();
    const createdAt = timestamp(input.createdAt as unknown as string | Date | undefined, "createdAt");
    const updatedAt = timestamp(input.updatedAt as unknown as string | Date | undefined, "updatedAt");
    const lastTransitionAt = timestamp(input.lastTransitionAt as unknown as string | Date | undefined, "lastTransitionAt");
    const values = [
      workerId, text(input.issueIdentifier, "issueIdentifier"), text(input.project, "project"),
      text(input.repository, "repository"), text(input.mappingVersion, "mappingVersion"), state,
      text(input.reason, "reason"), integer(input.processId, "processId"), text(input.sessionName, "sessionName"),
      text(input.workspacePath, "workspacePath"), text(input.branch, "branch"), text(input.baseCommit, "baseCommit"),
      text(input.commitSha, "commitSha"), text(input.imageDigest, "imageDigest"), integer(input.pullRequestNumber, "pullRequestNumber"),
      text(input.correlationId, "correlationId"), text(input.snapshotId, "snapshotId"), text(input.lastError, "lastError"),
      createdAt, updatedAt, lastTransitionAt,
    ].map(toDbValue);
    return this.transaction(() => {
      this.#database.prepare(`INSERT INTO workers (${WORKER_COLUMNS.join(",")}) VALUES (${WORKER_COLUMNS.map(() => "?").join(",")})`).run(...values);
      this.#database.prepare(`INSERT INTO worker_transitions(worker_id, from_state, to_state, actor, reason, occurred_at) VALUES (?, NULL, ?, ?, ?, ?)`).run(
        workerId, state, "system", input.reason ?? "created", lastTransitionAt,
      );
      return this.getRequired(workerId);
    });
  }

  public get(workerId: string): WorkerRecord | undefined {
    const id = requiredText(workerId, "workerId");
    const row = this.#database.prepare("SELECT * FROM workers WHERE worker_id = ?").get(id);
    return row === undefined ? undefined : rowToWorker(row);
  }

  private getRequired(workerId: string): WorkerRecord {
    const result = this.get(workerId);
    if (result === undefined) throw new WorkerNotFoundError(workerId);
    return result;
  }

  public status(workerId: string): WorkerRecord | undefined {
    return this.get(workerId);
  }

  public list(filter: WorkerListFilter = {}): readonly WorkerRecord[] {
    const clauses: string[] = [];
    const values: unknown[] = [];
    if (filter.states !== undefined) {
      if (!Array.isArray(filter.states) || filter.states.length === 0 || filter.states.some((state) => !isWorkerState(state))) {
        throw new StateStoreError("states must be a non-empty list of valid worker states");
      }
      clauses.push(`state IN (${filter.states.map(() => "?").join(",")})`);
      values.push(...filter.states);
    }
    if (filter.project !== undefined) { clauses.push("project = ?"); values.push(text(filter.project, "project")); }
    if (filter.issueIdentifier !== undefined) { clauses.push("issue_identifier = ?"); values.push(text(filter.issueIdentifier, "issueIdentifier")); }
    const where = clauses.length === 0 ? "" : ` WHERE ${clauses.join(" AND ")}`;
    return this.#database.prepare(`SELECT * FROM workers${where} ORDER BY created_at ASC, worker_id ASC`).all(...values).map(rowToWorker);
  }

  public listRecovery(): readonly RecoveryRecord[] {
    return this.#database.prepare(`SELECT * FROM workers WHERE state IN (${RECOVERY_STATE_SQL}) ORDER BY updated_at ASC, worker_id ASC`).all().map((row) => ({
      ...rowToWorker(row), recoveryRequired: true as const,
    }));
  }

  public listRecoveryCandidates(): readonly RecoveryRecord[] {
    return this.listRecovery();
  }

  public getRecoveryState(workerId: string): RecoveryRecord | undefined {
    const worker = this.get(workerId);
    if (worker === undefined || !(RECOVERY_STATES as readonly WorkerState[]).includes(worker.state)) return undefined;
    return { ...worker, recoveryRequired: true };
  }

  /** Returns the most recently asked question for a worker, including answered metadata. */
  public getQuestion(workerId: string): QuestionRecord | undefined {
    const id = requiredText(workerId, "workerId");
    const row = this.#database.prepare(
      "SELECT * FROM questions WHERE worker_id = ? ORDER BY asked_at DESC, question_id DESC LIMIT 1",
    ).get(id);
    return row === undefined ? undefined : rowToQuestion(row);
  }

  /** Persists redacted question metadata and its answer without storing provider credentials. */
  public saveQuestion(record: QuestionRecord): QuestionRecord {
    const questionId = requiredText(record?.questionId, "questionId");
    const workerId = requiredText(record?.workerId, "question workerId");
    const issueIdentifier = requiredText(record?.issueIdentifier, "question issueIdentifier");
    const question = questionText(record?.question, "question");
    const askedAt = timestamp(record?.askedAt, "askedAt");
    const status = record?.status;
    if (status !== "unanswered" && status !== "answered") throw new StateStoreError("question status is invalid");
    const answer = status === "answered" ? questionText(record?.answer, "answer") : undefined;
    const answeredAt = status === "answered" ? timestamp(record?.answeredAt, "answeredAt") : undefined;
    if (status === "unanswered" && (record?.answer !== undefined || record?.answeredAt !== undefined)) {
      throw new StateStoreError("unanswered question cannot contain an answer");
    }
    const values = [questionId, workerId, issueIdentifier, question, askedAt, status, answer, answeredAt].map(toDbValue);
    return this.transaction(() => {
      this.getRequired(workerId);
      this.#database.prepare(`INSERT INTO questions (${QUESTION_COLUMNS.join(",")}) VALUES (${QUESTION_COLUMNS.map(() => "?").join(",")})
        ON CONFLICT(question_id) DO UPDATE SET worker_id = excluded.worker_id, issue_identifier = excluded.issue_identifier,
        question = excluded.question, asked_at = excluded.asked_at, status = excluded.status,
        answer = excluded.answer, answered_at = excluded.answered_at`).run(...values);
      const saved = this.#database.prepare("SELECT * FROM questions WHERE question_id = ?").get(questionId);
      if (saved === undefined) throw new StateStoreError("question could not be persisted");
      return rowToQuestion(saved);
    });
  }

  /** Adapter for QuestionWorkflow's durable metadata port. */
  public questionMetadata(): QuestionMetadataPort {
    return {
      get: (workerId) => this.getQuestion(workerId),
      save: (record) => this.saveQuestion(record),
    };
  }

  public transition(workerId: string, toState: WorkerState, options: TransitionOptions = {}): WorkerRecord {
    const id = requiredText(workerId, "workerId");
    if (!isWorkerState(toState)) throw new StateStoreError("toState is invalid");
    const actor = requiredText(options.actor ?? "system", "actor");
    const reason = options.reason === undefined ? undefined : text(options.reason, "reason");
    const providerEvidence = options.providerEvidence === undefined ? undefined : text(options.providerEvidence, "providerEvidence");
    const occurredAt = timestamp(options.at, "at");
    return this.transaction(() => {
      const current = this.getRequired(id);
      if (options.expectedState !== undefined && current.state !== options.expectedState) {
        throw new StateStoreError(`worker ${id} is ${current.state}, expected ${options.expectedState}`);
      }
      if (!canTransition(current.state, toState)) throw new InvalidWorkerTransitionError(current.state, toState);
      this.#database.prepare("UPDATE workers SET state = ?, reason = ?, updated_at = ?, last_transition_at = ? WHERE worker_id = ? AND state = ?").run(
        toState, toDbValue(reason), occurredAt, occurredAt, id, current.state,
      );
      this.#database.prepare("INSERT INTO worker_transitions(worker_id, from_state, to_state, actor, reason, provider_evidence, occurred_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
        id, current.state, toState, actor, toDbValue(reason), toDbValue(providerEvidence), occurredAt,
      );
      return this.getRequired(id);
    });
  }

  /** Update worker metadata atomically without changing lifecycle state. */
  public update(workerId: string, patch: Partial<Omit<WorkerRecord, "workerId" | "state" | "createdAt" | "updatedAt" | "lastTransitionAt">>): WorkerRecord {
    const id = requiredText(workerId, "workerId");
    const entries: [string, unknown][] = [];
    const add = (property: keyof typeof patch, column: string, value: unknown): void => {
      if (value !== undefined) entries.push([column, value]);
    };
    add("issueIdentifier", "issue_identifier", patch.issueIdentifier === undefined ? undefined : text(patch.issueIdentifier, "issueIdentifier"));
    add("project", "project", patch.project === undefined ? undefined : text(patch.project, "project"));
    add("repository", "repository", patch.repository === undefined ? undefined : text(patch.repository, "repository"));
    add("mappingVersion", "mapping_version", patch.mappingVersion === undefined ? undefined : text(patch.mappingVersion, "mappingVersion"));
    add("reason", "reason", patch.reason === undefined ? undefined : text(patch.reason, "reason"));
    add("processId", "process_id", integer(patch.processId, "processId"));
    add("sessionName", "session_name", patch.sessionName === undefined ? undefined : text(patch.sessionName, "sessionName"));
    add("workspacePath", "workspace_path", patch.workspacePath === undefined ? undefined : text(patch.workspacePath, "workspacePath"));
    add("branch", "branch", patch.branch === undefined ? undefined : text(patch.branch, "branch"));
    add("baseCommit", "base_commit", patch.baseCommit === undefined ? undefined : text(patch.baseCommit, "baseCommit"));
    add("commitSha", "commit_sha", patch.commitSha === undefined ? undefined : text(patch.commitSha, "commitSha"));
    add("imageDigest", "image_digest", patch.imageDigest === undefined ? undefined : text(patch.imageDigest, "imageDigest"));
    add("pullRequestNumber", "pull_request_number", integer(patch.pullRequestNumber, "pullRequestNumber"));
    add("correlationId", "correlation_id", patch.correlationId === undefined ? undefined : text(patch.correlationId, "correlationId"));
    add("snapshotId", "snapshot_id", patch.snapshotId === undefined ? undefined : text(patch.snapshotId, "snapshotId"));
    add("lastError", "last_error", patch.lastError === undefined ? undefined : text(patch.lastError, "lastError"));
    return this.transaction(() => {
      this.getRequired(id);
      if (entries.length > 0) {
        const now = new Date().toISOString();
        const assignments = entries.map(([column]) => `${column} = ?`).join(", ");
        this.#database.prepare(`UPDATE workers SET ${assignments}, updated_at = ? WHERE worker_id = ?`).run(
          ...entries.map(([, value]) => toDbValue(value)), now, id,
        );
      }
      return this.getRequired(id);
    });
  }

  public history(workerId: string): readonly WorkerTransition[] {
    const id = requiredText(workerId, "workerId");
    return this.#database.prepare("SELECT * FROM worker_transitions WHERE worker_id = ? ORDER BY id ASC").all(id).map(rowToTransition);
  }
}

/** Short alias for hosts that prefer the generic store name. */
export const StateStore = WorkerStateStore;
