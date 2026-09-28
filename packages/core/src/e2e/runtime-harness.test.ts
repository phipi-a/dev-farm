import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import {
  createCredentialFreeRuntimeFixture,
  runCredentialFreeComposedScenario,
} from "./runtime-harness";

test("runs three tickets through the composed runtime with fake local adapters", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dev-farm-e2e-"));
  const fixture = await runCredentialFreeComposedScenario(join(directory, "state.sqlite"));
  try {
    const workers = fixture.runtime.state.list();
    assert.equal(workers.length, 3);
    assert.ok(workers.every((worker) => worker.state === "awaiting-review"));
    assert.equal(new Set(workers.map((worker) => worker.workspacePath)).size, 3);
    assert.equal(new Set(workers.map((worker) => worker.branch)).size, 3);
    assert.equal(
      new Set(fixture.github.snapshot().map((pullRequest) => pullRequest.number)).size,
      3,
    );
    assert.deepEqual(
      fixture.docker.activeWorkerIds().sort(),
      workers.map((worker) => worker.workerId).sort(),
    );

    for (const worker of workers) {
      await fixture.runtime.docker.stop({ workerId: worker.workerId });
      fixture.runtime.state.transition(worker.workerId, "stopped", {
        actor: "e2e",
        reason: "fixture cleanup",
      });
      fixture.runtime.state.transition(worker.workerId, "destroyed", {
        actor: "e2e",
        reason: "fixture cleanup complete",
      });
    }
    assert.deepEqual(fixture.docker.activeWorkerIds(), []);
    assert.equal(fixture.docker.stopped.length, 3);
    assert.ok(fixture.runtime.state.list().every((worker) => worker.state === "destroyed"));
  } finally {
    await fixture.runtime.shutdown();
    await rm(directory, { recursive: true, force: true });
  }
});

test("aborts a hanging composed worker, marks failure, and stops its Docker resource", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dev-farm-e2e-failure-"));
  const fixture = createCredentialFreeRuntimeFixture(join(directory, "state.sqlite"));
  fixture.process.hang = true;
  const run = fixture.runtime.orchestrator.run({
    issueIdentifier: "DEV-39-A",
    workerId: "worker-dev-39-a",
    project: "DEV-39-runtime",
    repository: {
      owner: "dogfood",
      name: "dummy-repository",
      defaultBranch: "main",
      cloneUrl: "https://example.invalid/dogfood/dummy-repository.git",
    },
    workspacePath: join(directory, "workspace-a"),
    definitionOfDone: ["Wait for the fixture abort."],
    securityRules: ["Use no credentials."],
  });
  try {
    while (fixture.process.starts.length === 0) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    assert.deepEqual(fixture.docker.activeWorkerIds(), ["worker-dev-39-a"]);
    await fixture.process.abortAll();
    await assert.rejects(run, /worker was aborted|aborted|exited unsuccessfully/);
    await fixture.runtime.docker.stop({ workerId: "worker-dev-39-a" });
    assert.deepEqual(fixture.docker.activeWorkerIds(), []);
    assert.deepEqual(fixture.docker.stopped, ["worker-dev-39-a"]);
    assert.equal(fixture.runtime.state.get("worker-dev-39-a")?.state, "failed");
  } finally {
    await fixture.runtime.shutdown();
    await rm(directory, { recursive: true, force: true });
  }
});
