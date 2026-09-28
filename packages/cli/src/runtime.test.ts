import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  createRuntimeOperations,
  RuntimeOperationUnavailableError,
  type RuntimeFacade,
} from "./runtime";

function runtime(records: Record<string, unknown>[] = []): RuntimeFacade {
  const byId = new Map(records.map((record) => [record.workerId as string, record]));
  return {
    state: {
      list: (filter = {}) => {
        if (filter.issueIdentifier === undefined) return [...byId.values()];
        return [...byId.values()].filter(
          (record) => record.issueIdentifier === filter.issueIdentifier,
        );
      },
      get: (workerId) => byId.get(workerId),
      transition: (workerId, state) => {
        const record = byId.get(workerId);
        if (record !== undefined) {
          record.state = state;
          return record;
        }
        return undefined;
      },
    },
    docker: {
      stop: async () => undefined,
      remove: async () => undefined,
    },
    tmux: {
      sessionName: "dev-farm",
      attachCommand: () => "tmux attach -t dev-farm",
    },
    git: {
      status: async () => ({ clean: true }),
    },
  };
}

test("adapts runtime state and resource services to FarmOperations", async () => {
  const service = runtime([{ workerId: "worker-1", issueIdentifier: "FARM-1", state: "running" }]);
  const operations = createRuntimeOperations(service);

  assert.deepEqual(await operations.list({ command: "list", args: [], options: {} }), [
    { workerId: "worker-1", issueIdentifier: "FARM-1", state: "running" },
  ]);
  assert.equal(
    (
      (await operations.status({
        command: "status",
        target: "worker-1",
        args: ["worker-1"],
        options: {},
      })) as { workerId: string }
    ).workerId,
    "worker-1",
  );
  assert.match(
    (
      (await operations.attach({
        command: "attach",
        target: "worker-1",
        args: ["worker-1"],
        options: {},
      })) as { command: string }
    ).command,
    /tmux attach/,
  );
  assert.equal(
    (
      (await operations.stop({
        command: "stop",
        target: "worker-1",
        args: ["worker-1"],
        options: {},
      })) as { state: string }
    ).state,
    "stopped",
  );
});

test("delegates higher-level commands to injected runtime workflow handlers", async () => {
  const requests: string[] = [];
  const operations = createRuntimeOperations(runtime(), {
    merge: async (request) => {
      requests.push(request.command);
      return { merged: true };
    },
  });

  assert.deepEqual(
    await operations.merge({ command: "merge", target: "worker-1", args: [], options: {} }),
    { merged: true },
  );
  assert.deepEqual(requests, ["merge"]);
});

test("does not fake workflows absent from the runtime boundary", async () => {
  const operations = createRuntimeOperations(runtime());
  await assert.rejects(
    operations.merge({ command: "merge", target: "worker-1", args: [], options: {} }),
    (error: unknown) =>
      error instanceof RuntimeOperationUnavailableError && /merge/.test(error.message),
  );
});
