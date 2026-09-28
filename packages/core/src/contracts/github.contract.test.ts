import test from "node:test";

import { findOrCreatePullRequest, updatePullRequest } from "../github/pull-request";
import { FakeGitHubTransport, contractPullRequest, contractRepository } from "./fakes";
import { assert, eventually } from "./harness";

function intent(sourceBranch: string) {
  return {
    repository: contractRepository,
    sourceBranch,
    targetBranch: "main",
    title: `DEV-25: ${sourceBranch}`,
  };
}

test("GitHub contract: existing open PR wins without a create mutation", async () => {
  const github = new FakeGitHubTransport();
  const existing = contractPullRequest();
  github.pullRequests.push(existing);

  const result = await findOrCreatePullRequest(github, intent(existing.sourceBranch));

  assert.equal(result, existing);
  assert.equal(github.created.length, 0);
});

test("GitHub contract: timeout after acceptance is recovered by lookup", async () => {
  const github = new FakeGitHubTransport();
  github.failNextCreateAfterPersist = true;

  const result = await eventually(() => findOrCreatePullRequest(github, intent("linear/dev-25-timeout")));

  assert.equal(result.number, 1);
  assert.equal(github.created.length, 1);
  assert.equal(github.pullRequests.length, 1);
});

test("GitHub contract: an unaccepted create error remains visible", async () => {
  const github = new FakeGitHubTransport();
  github.failNextCreate = true;

  await assert.rejects(
    findOrCreatePullRequest(github, intent("linear/dev-25-failure")),
    /timed out before acceptance/,
  );
  assert.equal(github.pullRequests.length, 0);
});

test("GitHub contract: independent intents can be reconciled in parallel", async () => {
  const github = new FakeGitHubTransport();
  const results = await Promise.all([
    findOrCreatePullRequest(github, intent("linear/dev-25-one")),
    findOrCreatePullRequest(github, intent("linear/dev-25-two")),
  ]);

  assert.deepEqual(results.map(({ sourceBranch }) => sourceBranch).sort(), [
    "linear/dev-25-one",
    "linear/dev-25-two",
  ]);
  assert.equal(github.pullRequests.length, 2);
});

test("GitHub contract: an empty update is a local idempotent no-op", async () => {
  const github = new FakeGitHubTransport();
  const current = contractPullRequest();

  const result = await updatePullRequest(github, current, {});

  assert.equal(result, current);
  assert.equal(github.updated.length, 0);
});

test("GitHub contract: status exposes CI and current head state", async () => {
  const github = new FakeGitHubTransport();
  const current = contractPullRequest({ headSha: "abc123", reviewState: "approved" });
  github.pullRequests.push(current);

  const status = await github.getPullRequestStatus({
    repository: contractRepository,
    sourceBranch: current.sourceBranch,
    targetBranch: current.targetBranch,
  });

  assert.equal(status.headSha, "abc123");
  assert.equal(status.reviewState, "approved");
  assert.equal(status.ci.state, "success");
});
