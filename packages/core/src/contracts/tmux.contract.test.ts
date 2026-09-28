import test from "node:test";

import {
  TmuxCommandError,
  TmuxError,
  TmuxSessionManager,
  TmuxSessionError,
  TmuxValidationError,
} from "../tmux/tmux";
import { FakeTmuxRunner } from "./fakes";
import { assert, rejectsWith } from "./harness";

test("tmux contract: ensure creates missing windows once and resumes in place", async () => {
  const runner = new FakeTmuxRunner();
  const manager = new TmuxSessionManager(runner);

  const first = await manager.ensure();
  const callsAfterFirst = runner.calls.length;
  const second = await manager.createOrResume();

  assert.equal(first.created, true);
  assert.deepEqual(first.windows, ["pi", "app", "tests", "shell"]);
  assert.equal(second.created, false);
  assert.deepEqual(second.windows, first.windows);
  assert.equal(runner.calls.length, callsAfterFirst + 2);
  assert.equal(runner.calls.some(({ args }) => args[0] === "attach-session"), false);
});

test("tmux contract: command generation validates input and quotes shell output", () => {
  const runner = new FakeTmuxRunner();
  const manager = new TmuxSessionManager(runner, { sessionName: "dev-farm" });

  assert.equal(manager.attachCommand(), "tmux attach-session -t 'dev-farm'");
  assert.equal(
    manager.execCommand("tests", "echo 'safe'"),
    "tmux send-keys -t 'dev-farm:tests' 'echo '\\\''safe'\\\''' C-m",
  );
  assert.throws(() => manager.execCommand("tests", ""), TmuxValidationError);
  assert.throws(() => new TmuxSessionManager(runner, { sessionName: "bad\u0000name" }), TmuxValidationError);
});

test("tmux contract: command and runner failures retain typed context", async () => {
  const runner = new FakeTmuxRunner();
  runner.nextResult = { exitCode: 2, stdout: "", stderr: "permission denied" };
  const manager = new TmuxSessionManager(runner);

  const error = await rejectsWith(manager.ensure(), TmuxSessionError, /could not inspect/);
  assert.equal(error.sessionName, "dev");
  assert.ok(error.cause instanceof TmuxCommandError);

  runner.rejectNext = new Error("tmux unavailable");
  await rejectsWith(manager.exec("tests", "echo ok"), TmuxError, /failed to run/);
});
