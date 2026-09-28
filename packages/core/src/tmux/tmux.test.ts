import assert from "node:assert/strict";
import test from "node:test";
import {
  TmuxCommandError,
  TmuxSessionManager,
  TmuxValidationError,
  generateAttachCommand,
  generateExecCommand,
} from "./tmux";
import type { TmuxCommandResult, TmuxCommandRunner } from "./tmux";

type Call = { command: string; args: readonly string[] };

class FakeTmuxRunner implements TmuxCommandRunner {
  readonly calls: Call[] = [];
  readonly windows = new Set<string>();
  sessionExists = false;
  fail: { command: string; exitCode: number; stderr: string } | undefined;

  async run(command: string, args: readonly string[]): Promise<TmuxCommandResult> {
    this.calls.push({ command, args: [...args] });
    if (this.fail?.command === args[0]) {
      return { exitCode: this.fail.exitCode, stdout: "", stderr: this.fail.stderr };
    }
    switch (args[0]) {
      case "has-session":
        return { exitCode: this.sessionExists ? 0 : 1, stdout: "", stderr: "" };
      case "new-session":
        this.sessionExists = true;
        this.windows.add(args[args.indexOf("-n") + 1]);
        return { exitCode: 0, stdout: "", stderr: "" };
      case "list-windows":
        return { exitCode: 0, stdout: `${[...this.windows].join("\n")}\n`, stderr: "" };
      case "new-window":
        this.windows.add(args[args.indexOf("-n") + 1]);
        return { exitCode: 0, stdout: "", stderr: "" };
      case "send-keys":
        return { exitCode: 0, stdout: "", stderr: "" };
      default:
        return { exitCode: 127, stdout: "", stderr: "unknown command" };
    }
  }
}

test("creates a detached dev session and all required windows", async () => {
  const runner = new FakeTmuxRunner();
  const manager = new TmuxSessionManager(runner);

  const session = await manager.ensure();

  assert.deepEqual(session, {
    name: "dev",
    windows: ["pi", "app", "tests", "shell"],
    created: true,
  });
  assert.deepEqual(runner.windows, new Set(["pi", "app", "tests", "shell"]));
  assert.deepEqual(runner.calls[1].args, ["new-session", "-d", "-s", "dev", "-n", "pi"]);
  assert.ok(runner.calls.slice(2).every(({ args }) => args[0] !== "attach-session"));
  assert.ok(runner.calls.slice(3).every(({ args }) => args[1] === "-d"));
});

test("resumes an existing detached session without recreating windows", async () => {
  const runner = new FakeTmuxRunner();
  runner.sessionExists = true;
  for (const window of ["pi", "app", "tests", "shell"]) runner.windows.add(window);
  const manager = new TmuxSessionManager(runner);

  const session = await manager.createOrResume();
  assert.equal(session.created, false);
  assert.equal(runner.calls.filter(({ args }) => args[0] === "new-window").length, 0);
  assert.equal(runner.calls.filter(({ args }) => args[0] === "new-session").length, 0);
});

test("reconciliation only creates missing windows and is idempotent", async () => {
  const runner = new FakeTmuxRunner();
  runner.sessionExists = true;
  runner.windows.add("pi");
  const manager = new TmuxSessionManager(runner);

  await manager.ensure();
  const created = runner.calls.filter(({ args }) => args[0] === "new-window");
  assert.deepEqual(created.map(({ args }) => args[args.indexOf("-n") + 1]), ["app", "tests", "shell"]);

  runner.calls.length = 0;
  await manager.ensure();
  assert.equal(runner.calls.filter(({ args }) => args[0] === "new-window").length, 0);
});

test("generates safe attach and exec commands and executes through the runner", async () => {
  const runner = new FakeTmuxRunner();
  const manager = new TmuxSessionManager(runner);

  assert.equal(generateAttachCommand(), "tmux attach-session -t 'dev'");
  assert.equal(generateExecCommand("app", "echo it's ready"), "tmux send-keys -t 'dev:app' 'echo it'\\''s ready' C-m");
  assert.equal(manager.attachCommand(), "tmux attach-session -t 'dev'");
  await manager.exec("tests", "npm test");
  assert.deepEqual(runner.calls[0].args, ["send-keys", "-t", "dev:tests", "npm test", "C-m"]);
});

test("reports typed command and window failures", async () => {
  const runner = new FakeTmuxRunner();
  runner.fail = { command: "has-session", exitCode: 2, stderr: "permission denied" };
  await assert.rejects(
    () => new TmuxSessionManager(runner).ensure(),
    (error: unknown) => error instanceof Error
      && error.name === "TmuxSessionError"
      && error.cause instanceof TmuxCommandError,
  );

  await assert.rejects(
    () => new TmuxSessionManager(new FakeTmuxRunner()).exec("app", ""),
    TmuxValidationError,
  );
});
