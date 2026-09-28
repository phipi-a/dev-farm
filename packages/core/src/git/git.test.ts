import assert from "node:assert/strict";
import test from "node:test";
import { GitCommandError, GitWorkspaceAdapter } from "./git.ts";
import type { GitCommandResult, GitCommandRunner } from "./git.ts";

class FakeGitRunner implements GitCommandRunner {
  readonly calls: Array<{ args: readonly string[]; cwd: string }> = [];
  results: GitCommandResult[] = [];
  async run(_command: string, args: readonly string[], options: { cwd: string }): Promise<GitCommandResult> {
    this.calls.push({ args: [...args], cwd: options.cwd });
    return this.results.shift() ?? { exitCode: 0, stdout: "", stderr: "" };
  }
}

test("Git workspace adapter resolves paths and uses safe argv for repository operations", async () => {
  const runner = new FakeGitRunner();
  runner.results.push(
    { exitCode: 0, stdout: "true\n", stderr: "" },
    { exitCode: 0, stdout: "", stderr: "" },
    { exitCode: 0, stdout: "\n", stderr: "" },
    { exitCode: 0, stdout: "main\n", stderr: "" },
    { exitCode: 1, stdout: "", stderr: "" },
    { exitCode: 0, stdout: "a".repeat(40) + "\n", stderr: "" },
  );
  const git = new GitWorkspaceAdapter(runner, { paths: { realpath: async () => "/real/workspace" } });

  assert.equal(await git.isRepository("/link/workspace"), true);
  await git.fetchDefaultBranch("/link/workspace", "main");
  assert.deepEqual(await git.status("/link/workspace"), { clean: true });
  assert.equal(await git.currentBranch("/link/workspace"), "main");
  assert.equal(await git.branchExists("/link/workspace", "feature/dev"), false);
  assert.equal(await git.resolveCommit("/link/workspace", "origin/main"), "a".repeat(40));
  assert.equal(runner.calls.every(({ cwd }) => cwd === "/real/workspace"), true);
  assert.deepEqual(runner.calls[1].args, ["fetch", "--prune", "origin", "main"]);
});

test("Git adapter reports dirty status and never echoes credential-bearing URLs", async () => {
  const runner = new FakeGitRunner();
  runner.results.push({ exitCode: 0, stdout: " M file\n?? untracked\n", stderr: "" });
  const git = new GitWorkspaceAdapter(runner, { paths: { realpath: async () => "/workspace" } });
  assert.deepEqual(await git.status("/workspace"), { clean: false });

  runner.results.push({ exitCode: 128, stdout: "", stderr: "https://user:secret@example.test denied" });
  await assert.rejects(
    () => git.fetchDefaultBranch("/workspace", "main"),
    (error: unknown) => error instanceof GitCommandError
      && !error.message.includes("secret")
      && !error.stderr.includes("secret"),
  );
});

test("missing paths are treated as the pre-clone state", async () => {
  const git = new GitWorkspaceAdapter(new FakeGitRunner(), { paths: { realpath: async () => { throw new Error("ENOENT"); } } });
  assert.equal(await git.isRepository("/workspace"), false);
});
