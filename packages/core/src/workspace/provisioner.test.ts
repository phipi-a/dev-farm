import assert from "node:assert/strict";
import test from "node:test";

import type { Repository } from "../github/models";
import {
  WorkspaceProvisioner,
  WorkspaceRecoveryError,
  type GitWorkspacePort,
} from "./provisioner";

const repository: Repository = {
  owner: "acme",
  name: "farm",
  defaultBranch: "trunk",
  cloneUrl: "https://github.com/acme/farm.git",
};

class FakeGit implements GitWorkspacePort {
  repository = false;
  current: string | undefined;
  dirty = false;
  branches = new Set<string>();
  calls: string[] = [];

  async isRepository(): Promise<boolean> {
    this.calls.push("isRepository");
    return this.repository;
  }

  async clone(url: string, path: string): Promise<void> {
    this.calls.push(`clone:${url}:${path}`);
    this.repository = true;
    this.current = "trunk";
  }

  async fetchDefaultBranch(path: string, branch: string): Promise<void> {
    this.calls.push(`fetch:${path}:${branch}`);
  }

  async status(): Promise<{ clean: boolean }> {
    this.calls.push("status");
    return { clean: !this.dirty };
  }

  async currentBranch(): Promise<string | undefined> {
    this.calls.push("currentBranch");
    return this.current;
  }

  async branchExists(_path: string, branch: string): Promise<boolean> {
    this.calls.push(`branchExists:${branch}`);
    return this.branches.has(branch);
  }

  async createBranch(_path: string, branch: string, startPoint: string): Promise<void> {
    this.calls.push(`create:${branch}:${startPoint}`);
    this.branches.add(branch);
  }

  async checkout(_path: string, branch: string): Promise<void> {
    this.calls.push(`checkout:${branch}`);
    this.current = branch;
  }

  async resolveCommit(_path: string, ref: string): Promise<string> {
    this.calls.push(`resolve:${ref}`);
    return "abc123";
  }
}

function request(path = "/tmp/workspace") {
  return {
    path,
    repository,
    issueIdentifier: "DEV-8",
    issueSlug: "Provision workspace",
  };
}

test("clones, fetches the discovered default branch, and records metadata", async () => {
  const git = new FakeGit();
  const metadata = await new WorkspaceProvisioner({ git }).provision(request());

  assert.deepEqual(metadata, {
    path: "/tmp/workspace",
    repository,
    branch: "linear/dev-8-provision-workspace",
    baseCommit: "abc123",
  });
  assert.deepEqual(git.calls, [
    "isRepository",
    "clone:https://github.com/acme/farm.git:/tmp/workspace",
    "fetch:/tmp/workspace:trunk",
    "resolve:origin/trunk",
    "currentBranch",
    "status",
    "branchExists:linear/dev-8-provision-workspace",
    "create:linear/dev-8-provision-workspace:origin/trunk",
    "checkout:linear/dev-8-provision-workspace",
  ]);
});

test("resumes a dirty issue branch without checkout or resetting changes", async () => {
  const git = new FakeGit();
  git.repository = true;
  git.current = "linear/dev-8-provision-workspace";
  git.branches.add(git.current);
  git.dirty = true;

  const metadata = await new WorkspaceProvisioner({ git }).resume(request());

  assert.equal(metadata.branch, git.current);
  assert.equal(git.calls.includes("checkout:linear/dev-8-provision-workspace"), false);
  assert.equal(git.calls.some((call) => call.startsWith("create:")), false);
  assert.equal(git.calls.includes("fetch:/tmp/workspace:trunk"), true);
});

test("does not switch away from uncommitted work on another branch", async () => {
  const git = new FakeGit();
  git.repository = true;
  git.current = "someone-else";
  git.branches.add("linear/dev-8-provision-workspace");
  git.dirty = true;

  await assert.rejects(
    () => new WorkspaceProvisioner({ git }).provision(request()),
    (error: unknown) => {
      assert.equal(error instanceof WorkspaceRecoveryError, true);
      assert.match((error as Error).message, /uncommitted changes/);
      return true;
    },
  );
  assert.equal(git.calls.includes("checkout:linear/dev-8-provision-workspace"), false);
});

test("creates a missing branch from the fetched default branch on a clean resume", async () => {
  const git = new FakeGit();
  git.repository = true;
  git.current = "trunk";

  await new WorkspaceProvisioner({ git }).provision(request());

  assert.equal(git.calls.includes("create:linear/dev-8-provision-workspace:origin/trunk"), true);
  assert.equal(git.current, "linear/dev-8-provision-workspace");
});
