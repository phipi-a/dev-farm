import assert from "node:assert/strict";
import test from "node:test";
import { ProcessAdapter, ProcessValidationError } from "./process.ts";
import type { ProcessCommandRunner, ProcessHandle } from "./process.ts";

class FakeHandle implements ProcessHandle {
  readonly pid = 41;
  aborted = false;
  async wait() { return { exitCode: 0 }; }
  async abort() { this.aborted = true; }
}

class FakeRunner implements ProcessCommandRunner {
  readonly starts: Array<{ command: string; args: readonly string[]; cwd: string }> = [];
  readonly signals: Array<{ pid: number; signal: string }> = [];
  readonly handle = new FakeHandle();
  spawn(command: string, args: readonly string[], options: { cwd: string }) {
    this.starts.push({ command, args: [...args], cwd: options.cwd });
    return this.handle;
  }
  async signal(pid: number, signal: "SIGTERM" | "SIGKILL") { this.signals.push({ pid, signal }); }
}

test("process adapter starts only the Pi worker in the dedicated tmux window", async () => {
  const runner = new FakeRunner();
  const process = new ProcessAdapter(runner);
  const handle = await process.start({ command: "pi", args: ["--session"], cwd: "/workspace", tmuxWindow: "pi" });
  assert.equal(handle, runner.handle);
  assert.deepEqual(runner.starts, [{ command: "pi", args: ["--session"], cwd: "/workspace" }]);
  await process.stop(41);
  await process.kill(41);
  assert.deepEqual(runner.signals, [{ pid: 41, signal: "SIGTERM" }, { pid: 41, signal: "SIGKILL" }]);
});

test("process adapter rejects unsafe worker specifications before spawning", async () => {
  const runner = new FakeRunner();
  const process = new ProcessAdapter(runner);
  await assert.rejects(
    () => process.start({ command: "pi", args: ["--bad\u0000arg"], cwd: "relative", tmuxWindow: "pi" }),
    ProcessValidationError,
  );
  assert.equal(runner.starts.length, 0);
});
