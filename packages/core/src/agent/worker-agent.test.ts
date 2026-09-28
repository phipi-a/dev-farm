import assert from "node:assert/strict";
import test from "node:test";
import {
  WorkerAgent,
  WorkerAgentBusyError,
  buildWorkerPrompt,
  redactWorkerText,
} from "./worker-agent";
import type {
  WorkerAgentClockPort,
  WorkerAgentProcessPort,
  WorkerAgentProcessSpec,
  WorkerAgentTmuxPort,
  WorkerProcess,
  WorkerProcessExit,
} from "./worker-agent";

const request = {
  issue: { identifier: "DEV-20", title: "Run one worker", description: "Implement the ticket." },
  repository: { owner: "acme", name: "farm", url: "https://github.com/acme/farm" },
  branch: "dev/dev-20",
  definitionOfDone: ["Run tests", "Keep the boundary typed"],
  securityRules: ["Never print credentials", "Do not merge"],
  workspacePath: "/workspaces/dev-20",
};

class FakeClock implements WorkerAgentClockPort {
  time = 100;
  now(): number { return this.time; }
  async sleep(_milliseconds: number): Promise<void> { await new Promise<void>(() => undefined); }
}

class FakeTmux implements WorkerAgentTmuxPort {
  readonly windows: string[] = [];
  output = "last output";
  async ensureWindow(window: "pi"): Promise<void> { this.windows.push(window); }
  async captureLastOutput(_window: "pi"): Promise<string> { return this.output; }
}

class ImmediateProcess implements WorkerProcess {
  readonly exit: WorkerProcessExit;
  aborted = false;
  constructor(exit: WorkerProcessExit = { exitCode: 0 }) { this.exit = exit; }
  async wait(): Promise<WorkerProcessExit> { return this.exit; }
  async abort(): Promise<void> { this.aborted = true; }
}

class FakeProcess implements WorkerAgentProcessPort {
  specs: WorkerProcessSpec[] = [];
  readonly process: WorkerProcess;
  constructor(process: WorkerProcess = new ImmediateProcess()) { this.process = process; }
  async start(spec: WorkerProcessSpec): Promise<WorkerProcess> {
    this.specs.push(spec);
    return this.process;
  }
}

test("builds a ticket-scoped prompt and redacts supplied and conventional secrets", () => {
  const prompt = buildWorkerPrompt({
    ...request,
    issue: { ...request.issue, description: "Use token=super-secret and ghp_123456789." },
    sensitiveValues: ["super-secret"],
  });
  assert.match(prompt, /DEV-20/);
  assert.match(prompt, /acme\/farm/);
  assert.match(prompt, /dev\/dev-20/);
  assert.match(prompt, /Definition of done/);
  assert.match(prompt, /Security rules/);
  assert.doesNotMatch(prompt, /super-secret|ghp_123456789/);
  assert.equal(redactWorkerText("Bearer abc123"), "Bearer [REDACTED]");
});

test("starts Pi in tmux pi and records command, heartbeat, last output and exit", async () => {
  const tmux = new FakeTmux();
  const processes = new FakeProcess();
  const agent = new WorkerAgent({ workerId: "worker-1", process: processes, tmux, clock: new FakeClock() });
  const run = await agent.start(request);
  const result = await run.wait();

  assert.deepEqual(tmux.windows, ["pi"]);
  assert.equal(processes.specs[0]?.command, "pi");
  assert.equal(processes.specs[0]?.tmuxWindow, "pi");
  assert.equal(result.status, "completed");
  assert.deepEqual(result.signals.map((signal) => signal.type), ["command", "heartbeat", "last-output", "exit"]);
  assert.equal(result.signals.find((signal) => signal.type === "last-output")?.output, "last output");
});

test("allows only one issue per worker while a run is active", async () => {
  const never = new ImmediateProcess();
  never.wait = () => new Promise<WorkerProcessExit>(() => undefined);
  const agent = new WorkerAgent({
    workerId: "worker-1",
    process: new FakeProcess(never),
    tmux: new FakeTmux(),
    clock: new FakeClock(),
  });
  await agent.start(request);
  await assert.rejects(() => agent.start({ ...request, issue: { ...request.issue, identifier: "DEV-21" } }), WorkerAgentBusyError);
});

test("classifies timeout as failed diagnostics and aborts the process", async () => {
  let resolveSleep: (() => void) | undefined;
  const clock: WorkerAgentClockPort = {
    now: () => 5,
    sleep: () => new Promise<void>((resolve) => { resolveSleep = resolve; }),
  };
  const process = new ImmediateProcess();
  process.wait = () => new Promise<WorkerProcessExit>(() => undefined);
  const agent = new WorkerAgent({ workerId: "worker-1", process: new FakeProcess(process), tmux: new FakeTmux(), clock });
  const run = await agent.start({ ...request, timeoutMs: 10 });
  resolveSleep?.();
  const result = await run.wait();
  assert.equal(result.status, "failed");
  assert.equal(result.failure?.kind, "timeout");
  assert.equal(process.aborted, true);
});

test("explicit abort is a failed diagnostic", async () => {
  const process = new ImmediateProcess();
  process.wait = () => new Promise<WorkerProcessExit>(() => undefined);
  const agent = new WorkerAgent({ workerId: "worker-1", process: new FakeProcess(process), tmux: new FakeTmux(), clock: new FakeClock() });
  const run = await agent.start(request);
  const result = await run.abort();
  assert.equal(result.status, "failed");
  assert.equal(result.failure?.kind, "aborted");
  assert.equal(process.aborted, true);
});
