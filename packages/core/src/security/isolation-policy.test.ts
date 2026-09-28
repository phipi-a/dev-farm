import assert from "node:assert/strict";
import test from "node:test";
import {
  WorkerIsolationValidationError,
  WorkerIsolationValidator,
  assertWorkerIsolation,
  redactSecrets,
  validateWorkerIsolation,
} from "./isolation-policy.ts";

const validRequest = {
  user: 1000,
  workspace: { hostPath: "/tmp/worker-a", path: "/workspace" },
  mounts: [{ source: "/tmp/worker-a", destination: "/workspace", readOnly: false }],
  network: { mode: "restricted", allowedHosts: [] },
  resources: { memoryBytes: 512 * 1024 * 1024, cpuCount: 2, pidsLimit: 512 },
} as const;

test("allows a non-root worker with bounded resources and an isolated workspace", () => {
  const result = validateWorkerIsolation(validRequest);
  assert.equal(result.valid, true);
  assert.deepEqual(result.failures, []);
});

test("blocks Docker socket, host-home, privileged, root, and unapproved capability settings", () => {
  const result = validateWorkerIsolation({
    ...validRequest,
    user: 0,
    privileged: true,
    capabilities: ["CAP_SYS_ADMIN"],
    mounts: [
      { source: "/var/run/docker.sock", destination: "/var/run/docker.sock" },
      { source: "/home/worker", destination: "/workspace" },
    ],
  });

  assert.equal(result.valid, false);
  assert.deepEqual(
    result.failures.map(({ code }) => code),
    ["forbidden-mount", "forbidden-mount", "privileged", "capability", "root"],
  );
});

test("blocks unsafe network, resources, workspace, and credentials", () => {
  const result = validateWorkerIsolation(
    {
      ...validRequest,
      workspace: { hostPath: "/root/checkout", path: "/" },
      network: { mode: "host", allowedHosts: ["internal.example.test"] },
      resources: { memoryBytes: 0, cpuCount: 1000, pidsLimit: -1 },
      credentials: [{ name: "production-token", kind: "token", value: "do-not-log" }],
    },
    {
      network: { allowedHosts: ["github.example.test"] },
      credentials: { allowedNames: ["github-token"], allowedKinds: ["token"] },
      resources: { maxMemoryBytes: 1024 * 1024 * 1024, maxCpuCount: 8, maxPids: 1024 },
    },
  );

  assert.equal(result.valid, false);
  assert(result.failures.some(({ code }) => code === "workspace"));
  assert(result.failures.some(({ code }) => code === "network"));
  assert(result.failures.some(({ code }) => code === "resource"));
  assert(result.failures.some(({ code }) => code === "credential"));
});

test("allowlisted capabilities and credentials can be validated by a reusable validator", () => {
  const validator = new WorkerIsolationValidator({
    allowedCapabilities: ["CAP_NET_BIND_SERVICE"],
    credentials: { allowedNames: ["github-token"], allowedKinds: ["token"] },
  });
  const result = validator.validate({
    ...validRequest,
    capabilities: ["CAP_NET_BIND_SERVICE"],
    credentials: [{ name: "github-token", kind: "token", value: "secret" }],
  });
  assert.equal(result.valid, true);
  assert.doesNotThrow(() => validator.assertValid({ ...validRequest }));
});

test("blocking assertion exposes failures without exposing secret values", () => {
  const request = {
    ...validRequest,
    credentials: [{ name: "unknown", value: "super-secret-token" }],
    logFields: { token: "super-secret-token", nested: { password: "pw" }, attemptId: "a-1" },
  };
  const result = validateWorkerIsolation(request);
  assert.equal(result.valid, false);
  assert.equal(JSON.stringify(result.failures).includes("super-secret-token"), false);
  assert.deepEqual(result.logFields, {
    token: "[REDACTED]",
    nested: { password: "[REDACTED]" },
    attemptId: "a-1",
  });
  assert.deepEqual(redactSecrets({ apiKey: "hidden", visible: "ok" }), {
    apiKey: "[REDACTED]",
    visible: "ok",
  });
  assert.throws(() => assertWorkerIsolation(request), WorkerIsolationValidationError);
});
