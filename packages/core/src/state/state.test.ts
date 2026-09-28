import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { InvalidWorkerTransitionError, WorkerStateStore } from "./index";

test("persists worker fields and migrations at the configured path", () => {
  const directory = mkdtempSync(join(tmpdir(), "dev-farm-state-"));
  const path = join(directory, "farm.sqlite");
  try {
    const first = new WorkerStateStore({ path });
    assert.equal(first.schemaVersion, 1);
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
