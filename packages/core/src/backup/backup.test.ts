import assert from "node:assert/strict";
import { test } from "node:test";
import { BackupManager, SnapshotIntegrityError, SnapshotVersionError } from "./index";
import { WorkerStateStore } from "../state/index";

const key = new Uint8Array(32).fill(7);

function sourceStore(): WorkerStateStore {
  const store = new WorkerStateStore({ path: ":memory:" });
  store.create({
    workerId: "worker-a",
    issueIdentifier: "DEV-33",
    project: "dev-farm",
    repository: "org/dev-farm",
    mappingVersion: "mapping-1",
    workspacePath: "/private/secret-checkout",
    sessionName: "tmux-secret",
    processId: 42,
    branch: "agent/dev-33",
    baseCommit: "base-1",
    commitSha: "commit-1",
    imageDigest: "sha256:image",
    lastError: "password=do-not-store",
  });
  store.transition("worker-a", "provisioning", { actor: "system" });
  store.transition("worker-a", "running", { actor: "operator" });
  return store;
}

test("creates an encrypted, integrity-checked redacted snapshot", () => {
  const source = sourceStore();
  const manager = new BackupManager(source, { key });
  const snapshot = manager.create("worker-a", {
    snapshotId: "snapshot-a",
    createdAt: "2025-01-01T00:00:00.000Z",
  });
  assert.equal(snapshot.format, "agent-farm.worker-snapshot");
  assert.equal(snapshot.retention.knownGood, true);
  assert.equal(manager.verify(JSON.stringify(snapshot)).payload.redacted, true);
  const payload = manager.verify(snapshot).payload;
  assert.equal("workspacePath" in payload.worker, false);
  assert.equal(payload.worker.lastError, "password=[REDACTED]");
  assert.equal(JSON.stringify(snapshot).includes("secret-checkout"), false);
  assert.equal(JSON.stringify(snapshot).includes("do-not-store"), false);
  source.close();
});

test("redacts authorization assignment and bearer header forms", () => {
  const source = sourceStore();
  source.update("worker-a", {
    lastError: "Authorization: Bearer header-secret authorization=assignment-secret",
  });
  const manager = new BackupManager(source, { key });
  const payload = manager.verify(manager.create("worker-a", { snapshotId: "redaction" })).payload;
  assert.equal(
    payload.worker.lastError,
    "Authorization: [REDACTED] authorization=[REDACTED]",
  );
  assert.doesNotMatch(JSON.stringify(payload), /header-secret|assignment-secret/);
  source.close();
});

test("redacts complete Basic and Digest authorization values", () => {
  const source = sourceStore();
  source.update("worker-a", {
    lastError:
      "Authorization: Basic basic-secret authorization=Digest username=alice, realm=private",
  });
  const manager = new BackupManager(source, { key });
  const payload = manager.verify(
    manager.create("worker-a", { snapshotId: "redaction-schemes" }),
  ).payload;
  assert.equal(payload.worker.lastError, "Authorization: [REDACTED] authorization=[REDACTED]");
  assert.doesNotMatch(JSON.stringify(payload), /basic-secret|username=alice|realm=private/);
  source.close();
});

test("rejects tampering and unsupported versions before restore", () => {
  const source = sourceStore();
  const manager = new BackupManager(source, { key });
  const snapshot = manager.create("worker-a", { snapshotId: "snapshot-a" });
  const tampered = { ...snapshot, workerId: "worker-b" };
  assert.throws(() => manager.verify(tampered), SnapshotIntegrityError);
  assert.throws(() => manager.verify({ ...snapshot, version: 999 }), SnapshotVersionError);
  source.close();
});

test("restores lifecycle metadata and history into an empty compatible store", () => {
  const source = sourceStore();
  const manager = new BackupManager(source, { key });
  const snapshot = manager.create("worker-a", { snapshotId: "snapshot-a" });
  const target = new WorkerStateStore({ path: ":memory:" });
  const restored = manager.restore(snapshot, target, { actor: "restore-test" });
  assert.equal(restored.state, "running");
  assert.equal(restored.workspacePath, undefined);
  assert.equal(target.history("worker-a").length, 3);
  assert.deepEqual(
    target.history("worker-a").map((entry) => entry.toState),
    ["queued", "provisioning", "running"],
  );
  source.close();
  target.close();
});

test("protects known-good snapshots from retention deletion", () => {
  const source = sourceStore();
  const manager = new BackupManager(source, { key });
  const protectedSnapshot = manager.create("worker-a", {
    snapshotId: "protected",
    createdAt: "2020-01-01T00:00:00.000Z",
  });
  const expiringSnapshot = manager.create("worker-a", {
    snapshotId: "expiring",
    createdAt: "2020-01-01T00:00:00.000Z",
    knownGood: false,
    retentionDays: 1,
  });
  assert.equal(manager.isDeletable(protectedSnapshot, "2030-01-01T00:00:00.000Z"), false);
  assert.equal(manager.isDeletable(expiringSnapshot, "2030-01-01T00:00:00.000Z"), true);
  source.close();
});
