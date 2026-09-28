import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  DogfoodScenarioError,
  createCredentialFreeDogfoodPorts,
  runCredentialFreeDogfoodScenario,
  runDogfoodScenario,
} from "./harness";

test("runs the three-ticket dogfood scenario with isolated projections", async () => {
  const report = await runCredentialFreeDogfoodScenario();

  assert.equal(report.execution.mode, "fake");
  assert.equal(report.execution.liveProvidersSkipped, true);
  assert.deepEqual(report.workers.map((worker) => worker.issueIdentifier), ["DEV-28-A", "DEV-28-B", "DEV-28-C"]);
  assert.equal(new Set(report.workers.map((worker) => worker.workerId)).size, 3);
  assert.ok(report.workers.every((worker) => worker.finalState === "destroyed"));
  assert.ok(report.workers.every((worker) => worker.dockerCleaned && worker.tmuxCleaned));
  assert.equal(report.workers.find((worker) => worker.issueIdentifier === "DEV-28-C")?.linearStatus, "Done");
  assert.ok(report.workers.filter((worker) => worker.issueIdentifier !== "DEV-28-C").every((worker) => worker.linearStatus === "In Review"));
  assert.equal(report.workers.find((worker) => worker.issueIdentifier === "DEV-28-C")?.pullRequestState, "merged");
  assert.deepEqual(report.assertions, {
    workerIsolation: true,
    sameWorkerQuestionAndReview: true,
    exactlyOneExplicitMerge: true,
    cleanup: true,
    consistentProjections: true,
  });

  const continuations = report.agentRuns.filter((run) => run.kind === "continue");
  assert.deepEqual(continuations.map((run) => run.workerId), ["worker-dev-28-b", "worker-dev-28-c"]);
  assert.equal(report.calls.filter((call) => call.endsWith(":merged")).length, 1);
});

test("uses injected ports and rejects an opt-in live-provider run", async () => {
  const ports = createCredentialFreeDogfoodPorts();
  await assert.rejects(
    runDogfoodScenario(ports, { enableLiveProviders: true }),
    (error: unknown) => error instanceof DogfoodScenarioError && /live provider execution is disabled/.test(error.message),
  );
});

test("keeps the scenario checklist machine-readable and explicit about skipping live boundaries", async () => {
  const checklist = JSON.parse(await readFile(fileURLToPath(new URL("./scenario-checklist.json", import.meta.url)), "utf8")) as {
    mode: string;
    tickets: number;
    liveProviderExecution: { enabled: boolean; skipped: boolean };
    checks: Array<{ id: string }>;
  };
  assert.equal(checklist.mode, "fake-only-by-default");
  assert.equal(checklist.tickets, 3);
  assert.equal(checklist.liveProviderExecution.enabled, false);
  assert.equal(checklist.liveProviderExecution.skipped, true);
  assert.deepEqual(checklist.checks.map((check) => check.id), [
    "worker-isolation",
    "question-continue",
    "review-continue",
    "explicit-merge",
    "cleanup",
    "projection-consistency",
    "credential-free",
  ]);
});
