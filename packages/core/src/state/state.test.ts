import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { InvalidWorkerTransitionError, openSqliteDatabase, WorkerStateStore } from "./index";

test("persists worker fields and migrations at the configured path", () => {
  const directory = mkdtempSync(join(tmpdir(), "dev-farm-state-"));
  const path = join(directory, "farm.sqlite");
  try {
    const first = new WorkerStateStore({ path });
    assert.equal(first.schemaVersion, 2);
    const created = first.create({
      workerId: "worker-a",
      issueIdentifier: "DEV-5",
      project: "dev-farm",
      repository: "org/dev-farm",
      mappingVersion: "mapping-1",
      workspacePath: "/private/workers/worker-a",
      branch: "agent/dev-5",
      baseCommit: "abc123",
      imageDigest: "sha256:image",
      sessionName: "dev-farm-worker-a",
      processId: 42,
      correlationId: "corr-a",
    });
    assert.equal(created.state, "queued");
    assert.equal(created.imageDigest, "sha256:image");
    first.close();

    const reopened = new WorkerStateStore({ path });
    assert.deepEqual(reopened.get("worker-a")?.workspacePath, "/private/workers/worker-a");
    assert.equal(reopened.history("worker-a").length, 1);
    reopened.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("persists question and answer metadata durably without replacing worker state", () => {
  const directory = mkdtempSync(join(tmpdir(), "dev-farm-question-"));
  const path = join(directory, "farm.sqlite");
  try {
    const store = new WorkerStateStore({ path });
    store.create({ workerId: "worker-q", issueIdentifier: "DEV-32" });
    const asked = store.saveQuestion({
      questionId: "question-1",
      workerId: "worker-q",
      issueIdentifier: "DEV-32",
      question: "Which region? token=question-token secret=question-secret authorization=question-auth Bearer question-bearer",
      askedAt: "2025-01-14T10:00:00.000Z",
      status: "unanswered",
    });
    assert.equal(asked.status, "unanswered");
    assert.equal(
      store.getQuestion("worker-q")?.question,
      "Which region? token=[REDACTED] secret=[REDACTED] authorization=[REDACTED] Bearer [REDACTED]",
    );
    const answered = store.saveQuestion({
      ...asked,
      status: "answered",
      answer: "eu-west-1 token=answer-token secret=answer-secret authorization=answer-auth Bearer answer-bearer",
      answeredAt: "2025-01-14T10:01:00.000Z",
    });
    assert.equal(
      answered.answer,
      "eu-west-1 token=[REDACTED] secret=[REDACTED] authorization=[REDACTED] Bearer [REDACTED]",
    );
    assert.doesNotMatch(JSON.stringify(answered), /question-token|question-secret|question-auth|question-bearer|answer-token|answer-secret|answer-auth|answer-bearer/);
    assert.equal(store.get("worker-q")?.state, "queued");
    assert.equal(store.questionMetadata().get("worker-q")?.questionId, "question-1");
    store.close();

    const reopened = new WorkerStateStore({ path });
    assert.equal(
      reopened.getQuestion("worker-q")?.answer,
      "eu-west-1 token=[REDACTED] secret=[REDACTED] authorization=[REDACTED] Bearer [REDACTED]",
    );
    assert.doesNotMatch(JSON.stringify(reopened.getQuestion("worker-q")), /answer-token|answer-secret|answer-auth|answer-bearer/);
    reopened.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("waiting_for_input is recoverable and has only explicit recovery transitions", () => {
  const store = new WorkerStateStore({ path: ":memory:" });
  store.create({ workerId: "worker-w" });
  store.transition("worker-w", "provisioning");
  store.transition("worker-w", "running");
  store.transition("worker-w", "waiting_for_input");
  assert.equal(store.listRecovery()[0]?.state, "waiting_for_input");
  store.transition("worker-w", "recovering");
  store.transition("worker-w", "waiting_for_input");
  assert.throws(() => store.transition("worker-w", "queued"), InvalidWorkerTransitionError);
  store.close();
});

test("migrates a v1 database while preserving workers and transition history", () => {
  const directory = mkdtempSync(join(tmpdir(), "dev-farm-state-v1-"));
  const path = join(directory, "farm.sqlite");
  try {
    const database = openSqliteDatabase(path);
    database.exec(`
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      INSERT INTO schema_migrations VALUES (1, CURRENT_TIMESTAMP);
      CREATE TABLE workers (
        worker_id TEXT PRIMARY KEY NOT NULL, issue_identifier TEXT, project TEXT, repository TEXT,
        mapping_version TEXT, state TEXT NOT NULL CHECK (state IN ('queued','provisioning','running','awaiting-review','paused','recovering','stopped','failed','destroyed')),
        reason TEXT, process_id INTEGER, session_name TEXT, workspace_path TEXT, branch TEXT, base_commit TEXT,
        commit_sha TEXT, image_digest TEXT, pull_request_number INTEGER, correlation_id TEXT, snapshot_id TEXT,
        last_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_transition_at TEXT NOT NULL
      );
      CREATE TABLE worker_transitions (
        id INTEGER PRIMARY KEY AUTOINCREMENT, worker_id TEXT NOT NULL, from_state TEXT, to_state TEXT NOT NULL,
        actor TEXT NOT NULL, reason TEXT, provider_evidence TEXT, occurred_at TEXT NOT NULL
      );
      INSERT INTO workers(worker_id, state, created_at, updated_at, last_transition_at) VALUES ('legacy', 'running', '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z');
      INSERT INTO worker_transitions(worker_id, to_state, actor, occurred_at) VALUES ('legacy', 'running', 'system', '2025-01-01T00:00:00.000Z');
    `);
    database.close?.();
    const store = new WorkerStateStore({ path });
    assert.equal(store.schemaVersion, 2);
    assert.equal(store.get("legacy")?.state, "running");
    assert.equal(store.history("legacy").length, 1);
    store.transition("legacy", "waiting_for_input");
    assert.equal(store.listRecovery()[0]?.workerId, "legacy");
    store.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("validates transitions atomically and isolates workers", () => {
  const store = new WorkerStateStore({ path: ":memory:" });
  store.create({ workerId: "one" });
  store.create({ workerId: "two" });

  store.transition("one", "provisioning", { actor: "system" });
  store.transition("one", "running", { actor: "system" });
  assert.throws(() => store.transition("one", "destroyed"), InvalidWorkerTransitionError);
  assert.equal(store.get("one")?.state, "running");
  assert.equal(store.get("two")?.state, "queued");
  assert.equal(store.listRecovery().map((worker) => worker.workerId).join(), "one");
  assert.equal(store.history("one").length, 3);
  store.close();
});

test("failed and stopped workers are readable for recovery without credentials", () => {
  const store = new WorkerStateStore({ path: ":memory:" });
  store.create({ workerId: "worker-a" });
  store.transition("worker-a", "failed", { reason: "process exited", actor: "system" });
  assert.equal(store.listRecovery().length, 0);
  assert.equal(store.getRecoveryState("worker-a"), undefined);
  store.transition("worker-a", "recovering", { actor: "operator" });
  assert.equal(store.getRecoveryState("worker-a")?.recoveryRequired, true);
  store.close();
});
