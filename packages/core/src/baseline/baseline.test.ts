import assert from "node:assert/strict";
import test from "node:test";
import {
  BaselineRefreshError,
  BaselineRefresher,
  type BaselineGitPort,
  type ContainerBuildRequest,
  type ContainerBuildResult,
} from "./index.ts";

class FakeGit implements BaselineGitPort {
  readonly calls: string[] = [];
  repository = false;
  commit = "abc123";

  async isRepository(path: string): Promise<boolean> {
    this.calls.push(`isRepository:${path}`);
    return this.repository;
  }
  async clone(url: string, path: string): Promise<void> { this.calls.push(`clone:${url}:${path}`); this.repository = true; }
  async fetchDefaultBranch(path: string, branch: string): Promise<void> { this.calls.push(`fetch:${path}:${branch}`); }
  async checkout(path: string, branch: string): Promise<void> { this.calls.push(`checkout:${path}:${branch}`); }
  async resolveCommit(path: string, ref: string): Promise<string> { this.calls.push(`resolve:${path}:${ref}`); return this.commit; }
}

class FakeBuilder {
  readonly requests: ContainerBuildRequest[] = [];
  result: ContainerBuildResult = { status: "success", version: "v-abc123", digest: "sha256:digest" };
  async build(request: ContainerBuildRequest): Promise<ContainerBuildResult> { this.requests.push(request); return this.result; }
}

function refresher(git: FakeGit, builder: FakeBuilder, now = "2025-01-01T00:00:00.000Z"): BaselineRefresher {
  return new BaselineRefresher({
    git,
    builder,
    clock: { now: () => new Date(now) },
    config: { baselineImage: "acme/app:baseline" },
  });
}

const request = {
  project: { name: "app", linearTeam: "DEV", githubRepo: "acme/app", defaultBranch: "main" },
  repositoryUrl: "https://github.com/acme/app.git",
  workspacePath: "/isolated/baseline",
  cache: { from: ["acme/app:cache-b", "acme/app:cache-a", "acme/app:cache-a"] },
} as const;

test("refreshes only the dedicated baseline workspace with deterministic build inputs", async () => {
  const git = new FakeGit();
  const builder = new FakeBuilder();
  const result = await refresher(git, builder).refresh(request);

  assert.equal(result.status, "succeeded");
  assert.equal(result.buildStatus, "success");
  assert.equal(result.version, "v-abc123");
  assert.equal(result.digest, "sha256:digest");
  assert.equal(result.startedAt, "2025-01-01T00:00:00.000Z");
  assert.deepEqual(git.calls, [
    "isRepository:/isolated/baseline",
    "clone:https://github.com/acme/app.git:/isolated/baseline",
    "fetch:/isolated/baseline:main",
    "checkout:/isolated/baseline:main",
    "resolve:/isolated/baseline:origin/main",
  ]);
  assert.deepEqual(builder.requests[0], {
    contextPath: "/isolated/baseline",
    image: "acme/app:baseline",
    dockerfile: "Dockerfile",
    commit: "abc123",
    buildArgs: [["SOURCE_COMMIT", "abc123"]],
    cacheFrom: ["acme/app:cache-a", "acme/app:cache-b"],
  });
});

test("reports failed builds without changing git state or hiding the builder error", async () => {
  const git = new FakeGit();
  git.repository = true;
  const builder = new FakeBuilder();
  builder.result = { status: "failure", error: "build failed" };

  await assert.rejects(
    () => refresher(git, builder).refresh(request),
    (error: unknown) => {
      assert.ok(error instanceof BaselineRefreshError);
      assert.equal(error.result.status, "failed");
      assert.equal(error.result.buildStatus, "failure");
      assert.equal(error.result.commit, "abc123");
      assert.equal(error.result.error, "build failed");
      return true;
    },
  );
  assert.deepEqual(git.calls, [
    "isRepository:/isolated/baseline",
    "fetch:/isolated/baseline:main",
    "checkout:/isolated/baseline:main",
    "resolve:/isolated/baseline:origin/main",
  ]);
});

test("does not accept credential-bearing repository URLs", async () => {
  const git = new FakeGit();
  const builder = new FakeBuilder();
  await assert.rejects(
    () => refresher(git, builder).refresh({ ...request, repositoryUrl: "https://token:secret@github.com/acme/app.git" }),
    /credentials/u,
  );
  assert.deepEqual(git.calls, []);
});
