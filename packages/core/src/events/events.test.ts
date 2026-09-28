import assert from "node:assert/strict";
import test from "node:test";
import {
  BoundedEventStore,
  EventKind,
  EventRecorder,
  FakeClock,
  FakeEventSink,
  redactSecrets,
  summarizeWorkerEvents,
} from "./index";

const input = (overrides: Partial<Parameters<EventRecorder["record"]>[0]> = {}) => ({
  workerId: "worker-1",
  issueId: "LIN-27",
  kind: EventKind.Progress,
  message: "working",
  ...overrides,
});

test("recorder correlates events, uses an injectable clock, and redacts before persistence and sink", () => {
  const clock = new FakeClock(new Date("2025-01-01T00:00:00.000Z"));
  const store = new BoundedEventStore(10);
  const sink = new FakeEventSink();
  const recorder = new EventRecorder({
    persistence: store,
    sink,
    clock,
    idFactory: () => "event-1",
    secrets: ["value-token"],
  });

  const event = recorder.record(
    input({
      kind: EventKind.Security,
      message: "token value-token was rejected",
      data: { nested: [{ password: "full-password" }, { safe: "value-token" }] },
    }),
  );

  assert.equal(event.timestamp, "2025-01-01T00:00:00.000Z");
  assert.equal(event.workerId, "worker-1");
  assert.equal(event.issueId, "LIN-27");
  assert.equal(event.message, "token [REDACTED] was rejected");
  assert.deepEqual(event.data, { nested: [{ password: "[REDACTED]" }, { safe: "[REDACTED]" }] });
  assert.deepEqual(sink.events[0], event);
  assert.deepEqual(store.query(), [event]);
});

test("retention, filtered tail, and live queries remain bounded", () => {
  const store = new BoundedEventStore(2);
  const live: string[] = [];
  const unsubscribe = store
    .live({ workerId: "worker-1" })
    .subscribe((event) => live.push(event.id));
  const recorder = new EventRecorder({
    persistence: store,
    idFactory: (() => {
      let id = 0;
      return () => `event-${++id}`;
    })(),
  });
  recorder.record(input({ kind: EventKind.Git }));
  recorder.record(input({ kind: EventKind.Docker }));
  recorder.record(input({ workerId: "worker-2", kind: EventKind.Error }));
  unsubscribe();

  assert.deepEqual(
    store.tail(2).map((event) => event.id),
    ["event-2", "event-3"],
  );
  assert.deepEqual(
    store.query({ workerId: "worker-1" }).map((event) => event.id),
    ["event-2"],
  );
  assert.deepEqual(live, ["event-1", "event-2"]);
});

test("recursive redaction handles arrays, strings, and circular objects", () => {
  const value: { token: string; children: unknown[] } = { token: "credential", children: [] };
  value.children.push(value, { safe: "credential" });
  assert.deepEqual(redactSecrets(value, { secrets: ["credential"] }), {
    token: "[REDACTED]",
    children: ["[CIRCULAR]", { safe: "[REDACTED]" }],
  });
});

test("status summary provides failure and operator next-step guidance", () => {
  const recorder = new EventRecorder({
    idFactory: () => "event-1",
    clock: new FakeClock(new Date(0)),
  });
  const event = recorder.record(
    input({ kind: EventKind.CredentialFailure, message: "GitHub credential rejected" }),
  );
  const summary = summarizeWorkerEvents([event]);
  assert.equal(summary.status, "failed");
  assert.equal(summary.nextStep, "Resolve the reported failure and retry the worker.");
});
