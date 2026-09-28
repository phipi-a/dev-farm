import assert from "node:assert/strict";
import test from "node:test";
import type { ContinueInjectionInput } from "../continue/models";
import {
  QuestionDuplicateAnswerError,
  QuestionInvalidStateError,
  QuestionPendingError,
  QuestionWorkflow,
  WAITING_FOR_INPUT_STATE,
  parseWorkerQuestionSignal,
  redactQuestionText,
  type QuestionMetadataPort,
  type QuestionRecord,
  type QuestionWorkerRecord,
} from "./index";

const worker: QuestionWorkerRecord = {
  workerId: "worker-14",
  issueIdentifier: "DEV-14",
  state: "running",
  containerId: "container-14",
  workspacePath: "/workspaces/worker-14",
  branch: "agent/dev-14",
  pullRequest: {
    repository: { owner: "acme", name: "farm", defaultBranch: "main" },
    number: 14,
    sourceBranch: "agent/dev-14",
    targetBranch: "main",
    headSha: "head-1",
  },
};

class FakeState {
  current: QuestionWorkerRecord = { ...worker };
  readonly transitions: string[] = [];

  get(): QuestionWorkerRecord { return { ...this.current }; }
  transition(workerId: string, state: QuestionWorkerRecord["state"], options?: { expectedState?: QuestionWorkerRecord["state"] }): QuestionWorkerRecord {
    assert.equal(workerId, this.current.workerId);
    if (options?.expectedState !== undefined) assert.equal(this.current.state, options.expectedState);
    this.current = { ...this.current, state };
    this.transitions.push(state);
    return { ...this.current };
  }
}

class FakeQuestions implements QuestionMetadataPort {
  record: QuestionRecord | undefined;
  readonly saves: QuestionRecord[] = [];
  get(): QuestionRecord | undefined { return this.record; }
  save(record: QuestionRecord): QuestionRecord {
    this.record = record;
    this.saves.push(record);
    return record;
  }
}

function setup() {
  const state = new FakeState();
  const questions = new FakeQuestions();
  const comments: { identifier: string; body: string }[] = [];
  const continuations: ContinueInjectionInput[] = [];
  const workflow = new QuestionWorkflow({
    state,
    questions,
    linear: { addComment: (input) => { comments.push(input); } },
    continuePort: {
      inject: (input) => {
        continuations.push(input);
        return { status: "completed" as const };
      },
    },
    now: (() => {
      let index = 0;
      return () => index++ === 0 ? "2025-01-14T10:00:00.000Z" : "2025-01-14T10:01:00.000Z";
    })(),
    createQuestionId: () => "question-14",
  });
  return { state, questions, comments, continuations, workflow };
}

test("parses standard JSON and line worker question signals, ignoring normal output", () => {
  assert.deepEqual(parseWorkerQuestionSignal({ type: "worker_question", question: "Which region?" }), { type: "worker_question", question: "Which region?" });
  assert.deepEqual(parseWorkerQuestionSignal('{"type":"question","text":"Which region?"}'), { type: "worker_question", question: "Which region?" });
  assert.deepEqual(parseWorkerQuestionSignal("WORKER_QUESTION: Which region?"), { type: "worker_question", question: "Which region?" });
  assert.equal(parseWorkerQuestionSignal("progress: 50%"), null);
});

test("redacts configured and credential-shaped question text", () => {
  const safe = redactQuestionText("Use token=super-secret and Bearer abc123", ["super-secret"]);
  assert.equal(safe, "Use token=[REDACTED] and Bearer [REDACTED]");
  assert.equal(safe.includes("super-secret"), false);
});

test("transitions the exact worker, persists metadata, and writes a safe Linear comment", async () => {
  const fakes = setup();
  const result = await fakes.workflow.ask({
    workerId: "worker-14",
    signal: { type: "worker_question", question: "Which region? token=super-secret" },
    sensitiveValues: ["super-secret"],
  });
  assert.equal(result.worker.workerId, "worker-14");
  assert.equal(result.worker.state, WAITING_FOR_INPUT_STATE);
  assert.deepEqual(fakes.state.transitions, [WAITING_FOR_INPUT_STATE]);
  assert.equal(fakes.questions.record?.askedAt, "2025-01-14T10:00:00.000Z");
  assert.equal(fakes.questions.record?.question, "Which region? token=[REDACTED]");
  assert.equal(fakes.comments.length, 1);
  assert.match(fakes.comments[0]?.body ?? "", /\[worker-question:question-14\]/);
  assert.equal(JSON.stringify(fakes.comments).includes("super-secret"), false);
});

test("answers once and resumes the exact container/workspace/branch/PR", async () => {
  const fakes = setup();
  await fakes.workflow.ask({ workerId: "worker-14", signal: { type: "worker_question", question: "Which region?" } });
  const result = await fakes.workflow.answer({ workerId: "worker-14", answer: "eu-west-1 token=answer-secret", sensitiveValues: ["answer-secret"] });
  assert.equal(result.worker.state, "running");
  assert.equal(result.question.status, "answered");
  assert.equal(result.answer, "eu-west-1 token=[REDACTED]");
  assert.equal(JSON.stringify(fakes.questions.saves).includes("answer-secret"), false);
  assert.equal(fakes.continuations.length, 1);
  assert.equal(fakes.continuations[0]?.containerId, "container-14");
  assert.equal(fakes.continuations[0]?.workspacePath, "/workspaces/worker-14");
  assert.equal(fakes.continuations[0]?.branch, "agent/dev-14");
  assert.deepEqual(fakes.continuations[0]?.pullRequest, worker.pullRequest);
  assert.equal(fakes.continuations[0]?.reason, "answer");
  assert.equal(fakes.continuations[0]?.instruction, "eu-west-1 token=[REDACTED]");
  assert.equal(fakes.continuations[0]?.preserveUncommittedWork, true);
});

test("rejects duplicate answers, invalid states, completed workers, and progress while pending", async () => {
  const fakes = setup();
  await fakes.workflow.ask({ workerId: "worker-14", signal: { type: "worker_question", question: "Which region?" } });
  await assert.rejects(fakes.workflow.ask({ workerId: "worker-14", signal: { type: "worker_question", question: "A different question" } }), QuestionPendingError);
  const answer = await fakes.workflow.answer({ workerId: "worker-14", answer: "eu-west-1" });
  assert.equal(answer.question.status, "answered");
  await assert.rejects(fakes.workflow.answer({ workerId: "worker-14", answer: "us-east-1" }), QuestionDuplicateAnswerError);
  fakes.state.current = { ...fakes.state.current, state: "completed" };
  await assert.rejects(fakes.workflow.answer({ workerId: "worker-14", answer: "again" }), QuestionDuplicateAnswerError);
  fakes.state.current = { ...worker, state: "destroyed" };
  const fresh = setup();
  fresh.state.current = { ...worker, state: "destroyed" };
  await assert.rejects(fresh.workflow.ask({ workerId: "worker-14", signal: { type: "worker_question", question: "No" } }), QuestionInvalidStateError);
});
