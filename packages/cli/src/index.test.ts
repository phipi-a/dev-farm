import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  EXIT_CODES,
  createUnavailableOperations,
  parseArguments,
  runCli,
  type FarmOperations,
} from "./index";

function operations(result: unknown, called: string[] = []): FarmOperations {
  const operation = async (request: { command: string }): Promise<unknown> => {
    called.push(request.command);
    return result;
  };
  return {
    list: operation,
    status: operation,
    attach: operation,
    shell: operation,
    logs: operation,
    preview: operation,
    pr: operation,
    continue: operation,
    merge: operation,
    stop: operation,
    destroy: operation,
  };
}

test("parses commands, target, and scriptable options", () => {
  const parsed = parseArguments(["status", "farm-1", "--json", "--label=demo"]);
  assert.equal(parsed.command, "status");
  assert.equal(parsed.positionals[0], "farm-1");
  assert.equal(parsed.json, true);
  assert.equal(parsed.options.label, "demo");
});

test("runs an operation with structured output", async () => {
  const called: string[] = [];
  const result = await runCli(["status", "farm-1", "--json"], {
    operations: operations({ state: "running", token: "must-not-print" }, called),
  });
  assert.equal(result.exitCode, EXIT_CODES.success);
  assert.deepEqual(JSON.parse(result.stdout), { state: "running", token: "[REDACTED]" });
  assert.deepEqual(called, ["status"]);
});

test("requires explicit confirmation for destructive operations", async () => {
  let invoked = false;
  const result = await runCli(["destroy", "farm-1"], {
    operations: operations(null),
    output: {
      writeStdout: () => undefined,
      writeStderr: () => undefined,
      confirm: async () => {
        invoked = true;
        return false;
      },
    },
  });
  assert.equal(result.exitCode, EXIT_CODES.confirmationRequired);
  assert.equal(invoked, true);
});

test("--yes bypasses confirmation and returns operation failures as exit code 3", async () => {
  const result = await runCli(["merge", "farm-1", "--yes"], {
    operations: createUnavailableOperations(),
  });
  assert.equal(result.exitCode, EXIT_CODES.operation);
  assert.match(result.stderr, /not available/);
});
