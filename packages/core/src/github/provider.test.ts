import assert from "node:assert/strict";
import test from "node:test";

import { RuntimeCredentials } from "../config/config";
import {
  GitHubApiTransport,
  GitHubProviderError,
  type GitHubHttpRequest,
  type GitHubHttpResponse,
} from "./provider";
import type { Repository } from "./models";

class FakeGitHubHttp {
  readonly requests: GitHubHttpRequest[] = [];
  responses: GitHubHttpResponse[] = [];
  async request(request: GitHubHttpRequest): Promise<GitHubHttpResponse> {
    this.requests.push(request);
    const response = this.responses.shift();
    if (response === undefined) throw new Error("unexpected request");
    return response;
  }
}

const repository: Repository = { owner: "acme", name: "widget", defaultBranch: "trunk" };
const pullRequest = {
  number: 7,
  title: "DEV-35: adapters",
  body: "Review this change",
  state: "open",
  html_url: "https://github.example/acme/widget/pull/7",
  head: { ref: "linear/dev-35", sha: "abc123" },
  base: { ref: "trunk" },
};

test("GitHub API transport preserves explicit PR semantics and injects credentials", async () => {
  const http = new FakeGitHubHttp();
  http.responses.push({ status: 200, body: [pullRequest] });
  http.responses.push({ status: 201, body: pullRequest });
  const transport = new GitHubApiTransport(
    http,
    new RuntimeCredentials({ GITHUB_TOKEN: "github-secret" }),
    { apiBaseUrl: "https://github.example/api" },
  );
  const ref = { repository, sourceBranch: "linear/dev-35", targetBranch: "trunk" };

  assert.equal((await transport.findPullRequest(ref))?.number, 7);
  assert.equal(
    (await transport.createPullRequest({ ...ref, title: "DEV-35: adapters" })).number,
    7,
  );
  assert.equal(http.requests[0].headers.authorization, "Bearer github-secret");
  assert.equal(http.requests[1].method, "POST");
  assert.equal(http.requests[1].body?.includes("github-secret"), false);
});

test("GitHub API transport exposes no HTTP error payloads", async () => {
  const http = {
    async request(): Promise<GitHubHttpResponse> {
      throw new Error("authorization github-secret");
    },
  };
  const transport = new GitHubApiTransport(
    http,
    new RuntimeCredentials({ GITHUB_TOKEN: "github-secret" }),
  );
  await assert.rejects(
    () =>
      transport.findPullRequest({
        repository,
        sourceBranch: "linear/dev-35",
        targetBranch: "trunk",
      }),
    (error: unknown) => {
      assert(error instanceof GitHubProviderError);
      assert.equal(error.message.includes("github-secret"), false);
      return true;
    },
  );
});
