import assert from "node:assert/strict";
import test from "node:test";
import { DockerClient, WorkerContainerManager } from "./docker.ts";
import type { DockerCommandResult, DockerCommandRunner } from "./docker.ts";

type Call = { command: string; args: readonly string[] };

class FakeDockerRunner implements DockerCommandRunner {
  readonly calls: Call[] = [];
  readonly containers = new Map<string, Record<string, unknown>>();
  readonly volumes = new Set<string>();
  nextId = "container-123";

  async run(command: string, args: readonly string[]): Promise<DockerCommandResult> {
    this.calls.push({ command, args: [...args] });
    const operation = args[0];
    if (operation === "volume") {
      const name = args.at(-1)!;
      if (args[1] === "inspect") return this.result(this.volumes.has(name) ? "[]" : "", this.volumes.has(name) ? 0 : 1, this.volumes.has(name) ? "" : "No such volume");
      this.volumes.add(name);
      return this.result(`${name}\n`);
    }
    if (operation === "create") {
      const id = this.nextId;
      const name = args[2];
      const labels: Record<string, string> = {};
      for (let index = 3; index < args.length; index += 2) {
        if (args[index] !== "--label") break;
        const [key, ...value] = args[index + 1].split("=");
        labels[key] = value.join("=");
      }
      this.containers.set(id, { Id: id, Name: `/${name}`, Config: { Labels: labels, Image: args.at(-1) }, State: { Status: "created", Running: false, ExitCode: 0 }, Mounts: [] });
      return this.result(`${id}\n`);
    }
    if (operation === "start") {
      const row = this.containers.get(args[1]);
      if (row) {
        (row.State as Record<string, unknown>).Running = true;
        (row.State as Record<string, unknown>).Status = "running";
      }
      return this.result(row ? "" : "", row ? 0 : 1, row ? "" : "No such container");
    }
    if (operation === "inspect") {
      const row = this.containers.get(args[1]);
      return this.result(row ? JSON.stringify([row]) : "", row ? 0 : 1, row ? "" : "No such container");
    }
    if (operation === "ps") {
      return this.result([...this.containers].map(([id]) => JSON.stringify({ ID: id })).join("\n") + "\n");
    }
    return this.result("");
  }

  private result(stdout: string, exitCode = 0, stderr = ""): DockerCommandResult {
    return { stdout, stderr, exitCode };
  }
}

test("creates a labelled worker with an isolated volume and resumes it idempotently", async () => {
  const runner = new FakeDockerRunner();
  const manager = new WorkerContainerManager(new DockerClient(runner), { prefix: "farm" });
  const request = {
    workerId: "DEV-2",
    image: "worker:latest",
    workspace: {},
    metadata: { issue: "DEV-2" },
    network: { mode: "none" as const },
    resources: { memoryBytes: 1024, cpuCount: 2, pidsLimit: 64 },
    env: { CI: "1" },
  };

  const first = await manager.ensure(request);
  const second = await manager.resume(request);
  assert.equal(first.id, second.id);
  assert.equal(runner.containers.size, 1);
  assert.equal(runner.volumes.has("farm-workspace-dev-2"), true);
  const create = runner.calls.find(({ args }) => args[0] === "create")!;
  assert.deepEqual(create.args.slice(0, 3), ["create", "--name", "farm-worker-dev-2"]);
  assert.equal(create.args.includes("--network"), true);
  assert.equal((await manager.lookupByLabels({ "dev-farm/worker-id": "DEV-2" })).length, 1);
});

test("Docker client emits resource, environment, and lifecycle operations through the runner", async () => {
  const runner = new FakeDockerRunner();
  const client = new DockerClient(runner);
  const id = await client.createContainer({ name: "worker", image: "image", labels: { role: "worker" }, env: { A: "B" }, memoryBytes: 10, cpuCount: 2, pidsLimit: 3 });
  await client.startContainer(id);
  await client.stopContainer(id);
  await client.removeContainer(id, { force: true });
  const args = runner.calls.find(({ args }) => args[0] === "create")!.args;
  assert.equal(args.includes("--pids-limit"), true);
  assert.equal(args.includes("3"), true);
  assert.equal(args.includes("A=B"), true);
  assert.equal(runner.calls.some(({ args }) => args[0] === "rm" && args.includes("--force")), true);
});
