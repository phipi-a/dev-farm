import assert from "node:assert/strict";
import test from "node:test";
import type { DockerContainerInspection } from "../docker/docker.ts";
import type { WorkerRecord, WorkerState } from "../state/models.ts";
import {
  CleanupService,
  DestroyConfirmationRequiredError,
  type CleanupDockerPort,
  type CleanupStatePort,
} from "./cleanup.ts";

function worker(state: WorkerState = "running"): WorkerRecord {
  return {
    workerId: "worker-a",
    state,
    branch: "dev/worker-a",
    commitSha: "abc123",
    pullRequestNumber: 42,
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-01T00:00:00.000Z",
    lastTransitionAt: "2025-01-01T00:00:00.000Z",
  };
}

class FakeState implements CleanupStatePort {
  current: WorkerRecord;
  readonly transitions: WorkerState[] = [];
  constructor(initial: WorkerRecord = worker()) { this.current = initial; }
  get(): WorkerRecord { return this.current; }
  transition(workerId: string, state: WorkerState): WorkerRecord {
    assert.equal(workerId, this.current.workerId);
    this.transitions.push(state);
    this.current = { ...this.current, state };
    return this.current;
  }
}

class FakeClock {
  time = 0;
  readonly sleeps: number[] = [];
  now(): Date { return new Date(this.time); }
  async sleep(milliseconds: number): Promise<void> { this.sleeps.push(milliseconds); this.time += milliseconds; }
}

class FakeDocker implements CleanupDockerPort {
  running = true;
  readonly calls: string[] = [];
  readonly inspections: boolean[] = [];
  killContainer = async (container: string): Promise<void> => {
    this.calls.push(`kill:${container}`);
    this.running = false;
  };
  inspectContainer = async (container: string): Promise<DockerContainerInspection> => {
    this.calls.push(`inspect:${container}`);
    const sequence = this.inspections.shift();
    return { id: container, name: container, labels: {}, mounts: [], state: { status: this.running ? "running" : "exited", running: sequence ?? this.running } };
  };
  stopContainer = async (container: string): Promise<void> => { this.calls.push(`stop:${container}`); this.running = false; };
  removeContainer = async (container: string): Promise<void> => { this.calls.push(`remove:${container}`); };
  removeNetwork = async (network: string): Promise<void> => { this.calls.push(`network:${network}`); };
  removeVolume = async (volume: string): Promise<void> => { this.calls.push(`volume:${volume}`); };
}

class FakePorts {
  readonly released: string[] = [];
  release(workerId: string): void { this.released.push(workerId); }
}

test("graceful stop completes before timeout and releases the worker port", async () => {
  const docker = new FakeDocker();
  const state = new FakeState();
  const ports = new FakePorts();
  const service = new CleanupService({ docker, state, ports, gracefulTimeoutMs: 100, pollIntervalMs: 10, clock: new FakeClock() });

  const result = await service.stop({ workerId: "worker-a", containerId: "container-a" });

  assert.equal(result.done, true);
  assert.equal(result.state, "stopped");
  assert.deepEqual(state.transitions, ["stopped"]);
  assert.deepEqual(ports.released, ["worker-a"]);
  assert.equal(docker.calls.includes("kill:container-a"), false);
});

test("a non-cooperating container is killed after the injected graceful deadline", async () => {
  const docker = new FakeDocker();
  docker.stopContainer = async (container): Promise<void> => { docker.calls.push(`stop:${container}`); };
  const clock = new FakeClock();
  const state = new FakeState();
  const service = new CleanupService({ docker, state, gracefulTimeoutMs: 20, pollIntervalMs: 10, clock });

  const result = await service.stop({ workerId: "worker-a", containerId: "container-a" });

  assert.equal(result.done, true);
  assert.equal(docker.calls.includes("kill:container-a"), true);
  assert.deepEqual(clock.sleeps, [10, 10]);
});

test("destroy requires confirmation and warns without deleting git or pull-request data", async () => {
  const docker = new FakeDocker();
  const state = new FakeState();
  const service = new CleanupService({ docker, state });

  await assert.rejects(service.destroy({ workerId: "worker-a", containerId: "container-a" }), DestroyConfirmationRequiredError);
  const preview = service.previewDestroy({ workerId: "worker-a", containerId: "container-a", secrets: ["abc123"] });
  assert.equal(preview.warnings.length, 3);
  assert.equal(preview.warnings.some((warning) => warning.message.includes("abc123")), false);
  const result = await service.destroy({ workerId: "worker-a", containerId: "container-a", networkName: "network-a", volumeNames: ["volume-a"] }, { confirm: true });
  assert.equal(result.done, true);
  assert.equal(result.state, "destroyed");
  assert.deepEqual(state.transitions, ["stopped", "destroyed"]);
  assert.equal(docker.calls.includes("network:network-a"), true);
  assert.equal(docker.calls.includes("volume:volume-a"), true);
});

test("destroy retries partial failures idempotently and redacts operation errors", async () => {
  const docker = new FakeDocker();
  let failVolume = true;
  docker.removeVolume = async (volume): Promise<void> => {
    docker.calls.push(`volume:${volume}`);
    if (failVolume) { failVolume = false; throw new Error("token=super-secret failed"); }
  };
  const state = new FakeState();
  const service = new CleanupService({ docker, state });
  const request = { workerId: "worker-a", containerId: "container-a", volumeNames: ["volume-a"], secrets: ["super-secret"] };

  const first = await service.destroy(request, { confirm: true });
  assert.equal(first.done, false);
  assert.equal(first.state, "running");
  assert.equal(first.issues[0]?.message.includes("super-secret"), false);
  const second = await service.destroy(request, { confirm: true });
  assert.equal(second.done, true);
  assert.equal(second.state, "destroyed");
  assert.deepEqual(state.transitions, ["stopped", "destroyed"]);
});
