import assert from "node:assert/strict";
import test from "node:test";

import { RuntimeCredentials } from "../config/config";
import {
  LinearApiTransport,
  LinearProviderError,
  type LinearHttpRequest,
  type LinearHttpResponse,
} from "./provider";

class FakeLinearHttp {
  readonly requests: LinearHttpRequest[] = [];
  responses: LinearHttpResponse[] = [];
  async request(request: LinearHttpRequest): Promise<LinearHttpResponse> {
    this.requests.push(request);
    const response = this.responses.shift();
    if (response === undefined) throw new Error("unexpected request");
    return response;
  }
}

const issue = {
  id: "issue-1",
  identifier: "DEV-35",
  title: "Provider adapters",
  description: "Implement adapters",
  url: "https://linear.example/DEV-35",
  team: {
    id: "team-1",
    states: {
      nodes: [
        { id: "state-todo", name: "Todo", type: "backlog" },
        { id: "state-done", name: "Done", type: "completed" },
      ],
    },
  },
  state: { id: "state-todo", name: "Todo", type: "backlog" },
};

test("Linear API transport injects credentials and maps issue state transitions", async () => {
  const http = new FakeLinearHttp();
  http.responses.push(
    { status: 200, body: { data: { issue } } },
    {
      status: 200,
      body: {
        data: {
          issueUpdate: {
            success: true,
            issue: { ...issue, state: { id: "state-done", name: "Done", type: "completed" } },
          },
        },
      },
    },
  );
  const transport = new LinearApiTransport(
    http,
    new RuntimeCredentials({ LINEAR_API_TOKEN: "linear-secret" }),
  );

  assert.equal((await transport.getIssue("DEV-35"))?.status.name, "Todo");
  assert.equal(
    (await transport.updateIssue({ identifier: "DEV-35", issueId: "issue-1", status: "Done" }))
      .status.name,
    "Done",
  );
  assert.equal(http.requests[0].headers.authorization, "Bearer linear-secret");
  assert.equal(JSON.parse(http.requests[1].body).variables.stateId, "state-done");
});

test("Linear API transport redacts HTTP failures", async () => {
  const http = {
    async request(): Promise<LinearHttpResponse> {
      throw new Error("token=linear-secret response body");
    },
  };
  const transport = new LinearApiTransport(
    http,
    new RuntimeCredentials({ LINEAR_API_TOKEN: "linear-secret" }),
  );
  await assert.rejects(
    () => transport.getIssue("DEV-35"),
    (error: unknown) => {
      assert(error instanceof LinearProviderError);
      assert.equal(error.message.includes("linear-secret"), false);
      return true;
    },
  );
});
