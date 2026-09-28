import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { RuntimeCredentials } from "../config/config";
import { createRuntime, type RuntimePorts } from "./runtime";

const config = (statePath: string) => ({
  projects: [{ name: "dev", linearTeam: "DEV", githubRepo: "acme/project", defaultBranch: "main" }],
  statePath,
  dockerPrefix: "dev-farm",
  portRange: { start: 41000, end: 41010 },
  baselineImage: "ghcr.io/acme/worker:latest",
});

function ports(): RuntimePorts {
  return {
    docker: { run: async () => ({ exitCode: 0, stdout: "", stderr: "" }) },
    git: { run: async () => ({ exitCode: 0, stdout: "", stderr: "" }) },
    tmux: { run: async () => ({ exitCode: 0, stdout: "", stderr: "" }) },
    process: {
      spawn: async () => ({ wait: async () => ({ exitCode: 0 }), abort: async () => {} }),
      signal: async () => {},
    },
    linearHttp: { request: async () => ({ status: 200, body: { data: {} } }) },
    githubHttp: { request: async () => ({ status: 200, body: {} }) },
    credentials: new RuntimeCredentials({}),
  };
}

test("runtime composition validates config and exposes every lifecycle service", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dev-farm-runtime-"));
  const statePath = join(directory, "state.sqlite");
  try {
    const runtime = createRuntime({ config: config(statePath), ports: ports() });
    assert.equal(runtime.config.statePath, statePath);
    assert.equal(runtime.state.schemaVersion, 2);
    assert.ok(runtime.orchestrator);
    assert.ok(runtime.recovery);
    assert.ok(runtime.events);
    assert.ok(runtime.docker);
    assert.ok(runtime.git);
    assert.ok(runtime.process);
    assert.ok(runtime.tmux);
    assert.ok(runtime.linear);
    assert.ok(runtime.github);
    assert.deepEqual(await runtime.start(), []);
    await runtime.shutdown();
    await runtime.close();
    await assert.rejects(runtime.start(), /shut down/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("runtime event recorder retains the explicit redaction boundary", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dev-farm-runtime-events-"));
  try {
    const runtime = createRuntime({
      config: config(join(directory, "state.sqlite")),
      ports: ports(),
      eventSecrets: ["secret-value"],
    });
    runtime.events.record({
      workerId: "worker-1",
      kind: "progress",
      message: "secret-value",
      data: { value: "secret-value" },
    });
    const [event] = runtime.events.query();
    assert.equal(event.message, "[REDACTED]");
    assert.equal(event.data.value, "[REDACTED]");
    await runtime.shutdown();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
