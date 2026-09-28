import test from "node:test";

import {
  WorkspaceProvisioner,
  WorkspaceRecoveryError,
  WorkspaceProvisioningError,
} from "../workspace/provisioner";
import { FakeGitWorkspacePort, contractRepository } from "./fakes";
import { assert, rejectsWith } from "./harness";

const request = {
  path: "/workspaces/dev-25",
  repository: { ...contractRepository, cloneUrl: "https://github.com/acme/widget.git" },
  issueIdentifier: "DEV-25",
  issueSlug: "Contract tests",
};

test("workspace contract: provisioning is resumable and does not reset work", async () => {
  const git = new FakeGitWorkspacePort();
  const provisioner = new WorkspaceProvisioner({ git });

  const first = await provisioner.provision(request);
  const callsAfterFirst = [...git.calls];
  const second = await provisioner.resume(request);

  assert.equal(first.branch, "linear/dev-25-contract-tests");
  assert.deepEqual(second, first);
  assert.deepEqual(callsAfterFirst, [
    "isRepository", "clone", "fetchDefaultBranch", "resolveCommit",
    "currentBranch", "status", "branchExists", "createBranch", "checkout",
  ]);
  assert.equal(git.calls.filter((call) => call === "clone").length, 1);
  assert.equal(git.calls.filter((call) => call === "createBranch").length, 1);
  assert.equal(git.calls.filter((call) => call === "checkout").length, 1);
});

test("workspace contract: dirty work on another branch requires recovery", async () => {
  const git = new FakeGitWorkspacePort();
  git.repository = true;
  git.current = "feature/unrelated";
  git.clean = false;
  const provisioner = new WorkspaceProvisioner({ git });

  const error = await rejectsWith(
    provisioner.provision(request),
    WorkspaceRecoveryError,
    /uncommitted changes/,
  );

  assert.equal(error.path, request.path);
  assert.equal(git.calls.includes("checkout"), false);
  assert.equal(git.calls.includes("createBranch"), false);
});

test("workspace contract: port failures retain operation and path context", async () => {
  const git = new FakeGitWorkspacePort();
  git.cloneFailure = new Error("git unavailable");
  const provisioner = new WorkspaceProvisioner({ git });

  const error = await rejectsWith(
    provisioner.provision(request),
    WorkspaceProvisioningError,
    /clone failed: git unavailable/,
  );

  assert.equal(error.operation, "clone");
  assert.equal(error.path, request.path);
  assert.equal(error.retryable, true);
});
