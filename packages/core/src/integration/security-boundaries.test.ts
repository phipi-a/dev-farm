import assert from "node:assert/strict";
import test from "node:test";
import { WorkerContainerManager } from "../docker/docker.ts";
import type { WorkerContainerRequest } from "../docker/docker.ts";
import {
  WorkerIsolationValidationError,
  redactSecrets,
  validateWorkerIsolation,
} from "../security/isolation-policy.ts";
import { FakeDockerBoundary, ParallelStartGate } from "./mocks.ts";

const limits = {
  memoryBytes: 512 * 1024 * 1024,
  cpuCount: 2,
  pidsLimit: 256,
} as const;

function validRequest(workerId: string): WorkerContainerRequest {
  return {
    workerId,
    image: "worker:test",
    workspace: {},
    isolation: {
      user: 1000,
      network: { mode: "restricted", allowedHosts: [] },
      resources: limits,
    },
  };
}

test("blocks Docker socket and host-home mounts before the Docker boundary", async () => {
  const boundary = new FakeDockerBoundary();
  const manager = new WorkerContainerManager(boundary, { prefix: "security-test" });

  for (const source of ["/var/run/docker.sock", "/home/alice", "/root/.config"]) {
    const base = validRequest(`mount-${source.split("/").at(-1)}`);
    const request = {
      ...base,
      isolation: { ...base.isolation, mounts: [{ source, destination: "/workspace" }] },
    } satisfies WorkerContainerRequest;

    await assert.rejects(manager.ensure(request), WorkerIsolationValidationError);
  }

  assert.deepEqual(boundary.creates, []);
  assert.deepEqual(boundary.starts, []);
});

test("enforces non-root, capability, network, and resource policy at the manager boundary", async () => {
  const cases: Array<[string, WorkerContainerRequest["isolation"]]> = [
    ["root", { ...validRequest("root").isolation, user: 0 }],
    ["capability", { ...validRequest("capability").isolation, capabilities: ["CAP_SYS_ADMIN"] }],
    ["network", { ...validRequest("network").isolation, network: { mode: "host" } }],
    [
      "memory",
      {
        ...validRequest("memory").isolation,
        resources: { ...limits, memoryBytes: 512 * 1024 * 1024 * 1024 },
      },
    ],
    ["pids", { ...validRequest("pids").isolation, resources: { ...limits, pidsLimit: 100_000 } }],
  ];
  const boundary = new FakeDockerBoundary();
  const manager = new WorkerContainerManager(boundary, { prefix: "security-test" });

  for (const [name, isolation] of cases) {
    await assert.rejects(
      manager.ensure({ ...validRequest(`invalid-${name}`), isolation }),
      WorkerIsolationValidationError,
    );
  }

  assert.equal(boundary.creates.length, 0);
});

test("keeps parallel workers separate and applies deterministic resource limits", async () => {
  const gate = new ParallelStartGate(2);
  const boundary = new FakeDockerBoundary({ startGate: gate });
  const manager = new WorkerContainerManager(boundary, { prefix: "parallel-test" });

  const firstRequest = validRequest("DEV-24-A");
  const secondRequest = {
    ...validRequest("DEV-24-B"),
    isolation: {
      ...validRequest("DEV-24-B").isolation,
      resources: { memoryBytes: 1024 * 1024 * 1024, cpuCount: 4, pidsLimit: 512 },
    },
  } satisfies WorkerContainerRequest;
  const firstPromise = manager.ensure(firstRequest);
  const secondPromise = manager.ensure(secondRequest);

  await gate.waitForArrivals();
  assert.equal(boundary.creates.length, 2);
  assert.equal(new Set(boundary.creates.map(({ id }) => id)).size, 2);
  assert.deepEqual(boundary.creates.map(({ options }) => options.name).sort(), [
    "parallel-test-worker-dev-24-a",
    "parallel-test-worker-dev-24-b",
  ]);
  assert.deepEqual(boundary.creates.map(({ options }) => options.mounts?.[0]?.name).sort(), [
    "parallel-test-workspace-dev-24-a",
    "parallel-test-workspace-dev-24-b",
  ]);
  assert.deepEqual(
    boundary.creates
      .map(({ options }) => ({
        memoryBytes: options.memoryBytes,
        cpuCount: options.cpuCount,
        pidsLimit: options.pidsLimit,
        networkMode: options.networkMode,
        user: options.user,
      }))
      .sort((left, right) => left.memoryBytes! - right.memoryBytes!),
    [
      {
        memoryBytes: 512 * 1024 * 1024,
        cpuCount: 2,
        pidsLimit: 256,
        networkMode: "restricted",
        user: 1000,
      },
      {
        memoryBytes: 1024 * 1024 * 1024,
        cpuCount: 4,
        pidsLimit: 512,
        networkMode: "restricted",
        user: 1000,
      },
    ],
  );

  gate.release();
  const [first, second] = await Promise.all([firstPromise, secondPromise]);
  assert.notEqual(first.id, second.id);
  assert.deepEqual(new Set(boundary.starts), new Set([first.id, second.id]));
});

test("redacts credential-bearing diagnostics and rejects unknown credentials", async () => {
  const sentinel = "synthetic-test-secret-never-a-real-credential";
  const base = validRequest("redaction");
  const request = {
    ...base,
    isolation: {
      ...base.isolation,
      credentials: [{ name: "unknown-token", kind: "token", value: sentinel }],
      logFields: { token: sentinel, nested: { password: sentinel }, workerId: base.workerId },
    },
  } satisfies WorkerContainerRequest;

  const validation = validateWorkerIsolation(request.isolation!);
  assert.equal(validation.valid, false);
  assert.equal(JSON.stringify(validation.logFields).includes(sentinel), false);
  assert.deepEqual(validation.logFields, {
    token: "[REDACTED]",
    nested: { password: "[REDACTED]" },
    workerId: "redaction",
  });
  assert.equal(JSON.stringify(redactSecrets(request)).includes(sentinel), false);

  const boundary = new FakeDockerBoundary();
  const manager = new WorkerContainerManager(boundary, { prefix: "security-test" });
  await assert.rejects(manager.ensure(request), WorkerIsolationValidationError);
  assert.equal(boundary.creates.length, 0);
});
