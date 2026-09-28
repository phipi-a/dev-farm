import assert from "node:assert/strict";
import test from "node:test";
import {
  createPiExtension,
  PI_TOOL_DEFINITIONS,
  registerRuntimePiTools,
  registerPiTools,
  type PiOrchestrator,
  type PiRegisteredTool,
} from "./extension.js";

class FakeOrchestrator implements PiOrchestrator {
  readonly calls: string[] = [];
  secretResult = {
    status: "running",
    accessToken: "do-not-return",
    log: "authorization: bearer hidden token=also-hidden",
  };
  failure: Error | undefined;

  async ticketStart(input: { ticketId: string }): Promise<unknown> {
    this.calls.push(`start:${input.ticketId}`);
    return this.secretResult;
  }
  async ticketStartAll(): Promise<unknown> {
    this.calls.push("start-all");
    return { started: 2 };
  }
  async ticketStatus(): Promise<unknown> {
    this.calls.push("status");
    return { state: "running" };
  }
  async ticketContinue(input: { ticketId: string }): Promise<unknown> {
    this.calls.push(`continue:${input.ticketId}`);
    return { state: "running" };
  }
  async ticketLogs(): Promise<unknown> {
    this.calls.push("logs");
    return { lines: ["safe output"] };
  }
  async ticketAttach(): Promise<unknown> {
    this.calls.push("attach");
    return { target: "dev:pi" };
  }
  async ticketMerge(): Promise<unknown> {
    this.calls.push("merge");
    return { merged: true };
  }
  async ticketStop(): Promise<unknown> {
    this.calls.push("stop");
    return { state: "stopped" };
  }
  async ticketDestroy(): Promise<unknown> {
    this.calls.push("destroy");
    return { state: "destroyed" };
  }
}

test("exposes the nine SDK-neutral ticket tools", () => {
  assert.deepEqual(
    PI_TOOL_DEFINITIONS.map((tool) => tool.name),
    [
      "ticket_start",
      "ticket_start_all",
      "ticket_status",
      "ticket_continue",
      "ticket_logs",
      "ticket_attach",
      "ticket_merge",
      "ticket_stop",
      "ticket_destroy",
    ],
  );
  assert.equal(
    PI_TOOL_DEFINITIONS.find((tool) => tool.name === "ticket_destroy")?.inputSchema
      .additionalProperties,
    false,
  );
});

test("validates input, delegates once, and redacts result fields", async () => {
  const fake = new FakeOrchestrator();
  const extension = createPiExtension(fake);
  const result = await extension.invoke("ticket_start", { ticketId: "DEV-26" });
  assert.deepEqual(result, {
    ok: true,
    tool: "ticket_start",
    data: {
      status: "running",
      accessToken: "[REDACTED]",
      log: "authorization: bearer [REDACTED] token=[REDACTED]",
    },
  });
  assert.deepEqual(fake.calls, ["start:DEV-26"]);

  const invalid = await extension.invoke("ticket_start", { ticketId: "../../secret" });
  assert.deepEqual(invalid, {
    ok: false,
    tool: "ticket_start",
    error: { code: "invalid_input", message: "ticketId must be a valid ticket identifier" },
  });
  assert.deepEqual(fake.calls, ["start:DEV-26"]);
});

test("requires explicit confirmation before merge and destructive operations", async () => {
  const fake = new FakeOrchestrator();
  const extension = createPiExtension(fake);
  for (const name of ["ticket_merge", "ticket_stop", "ticket_destroy"] as const) {
    const result = await extension.invoke(name, { ticketId: "DEV-26" });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "confirmation_required");
  }
  assert.deepEqual(fake.calls, []);

  await extension.invoke("ticket_merge", { ticketId: "DEV-26", confirm: true });
  await extension.invoke("ticket_stop", { ticketId: "DEV-26", confirm: true });
  await extension.invoke("ticket_destroy", { ticketId: "DEV-26", confirm: true });
  assert.deepEqual(fake.calls, ["merge", "stop", "destroy"]);
});

test("returns a stable safe error when the adapter fails", async () => {
  const fake = new FakeOrchestrator();
  fake.ticketStatus = async () => {
    throw new Error("provider response includes token=secret");
  };
  const result = await createPiExtension(fake).invoke("ticket_status", {});
  assert.deepEqual(result, {
    ok: false,
    tool: "ticket_status",
    error: { code: "orchestrator_error", message: "tool operation failed" },
  });
});

test("registers every tool through the Pi host surface", async () => {
  const fake = new FakeOrchestrator();
  const registered: PiRegisteredTool[] = [];
  const host = { registerTool: (tool: PiRegisteredTool) => registered.push(tool) };
  registerPiTools(host, fake);

  assert.deepEqual(
    registered.map((tool) => tool.name),
    PI_TOOL_DEFINITIONS.map((tool) => tool.name),
  );
  assert.equal(registered[0]?.parameters, PI_TOOL_DEFINITIONS[0]?.inputSchema);

  const result = await registered
    .find((tool) => tool.name === "ticket_start")!
    .execute("call-1", { ticketId: "DEV-36" }, new AbortController().signal, () => {}, {});
  assert.deepEqual(result, {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          status: "running",
          accessToken: "[REDACTED]",
          log: "authorization: bearer [REDACTED] token=[REDACTED]",
        }),
      },
    ],
    details: {
      ok: true,
      tool: "ticket_start",
      data: {
        status: "running",
        accessToken: "[REDACTED]",
        log: "authorization: bearer [REDACTED] token=[REDACTED]",
      },
    },
  });

  const mergeResult = await registered
    .find((tool) => tool.name === "ticket_merge")!
    .execute("call-merge", { ticketId: "DEV-36" }, undefined, undefined, {});
  assert.deepEqual(mergeResult.details, {
    ok: false,
    tool: "ticket_merge",
    error: { code: "confirmation_required", message: "merge requires explicit confirmation" },
  });
  assert.deepEqual(fake.calls, ["start:DEV-36"]);
});

test("registers a runtime-created orchestrator without owning runtime lifecycle", async () => {
  const fake = new FakeOrchestrator();
  const registered: PiRegisteredTool[] = [];
  registerRuntimePiTools(
    { registerTool: (tool: PiRegisteredTool) => registered.push(tool) },
    { orchestrator: fake },
  );
  await registered
    .find((tool) => tool.name === "ticket_stop")!
    .execute(
      "call-2",
      { ticketId: "DEV-36", confirm: true },
      new AbortController().signal,
      () => {},
      {},
    );
  assert.deepEqual(fake.calls, ["stop"]);
});
