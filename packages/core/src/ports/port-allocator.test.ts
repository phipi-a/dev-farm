import assert from "node:assert/strict";
import test from "node:test";
import {
  PortAllocationError,
  PortAllocator,
  buildPreviewUrl,
} from "./port-allocator.ts";

test("allocates distinct deterministic ports for concurrent attempts", async () => {
  const allocator = new PortAllocator({ range: { start: 4100, end: 4103 } });
  const allocations = await Promise.all(
    ["worker-a", "worker-b", "worker-c", "worker-d"].map((workerId) =>
      Promise.resolve().then(() => allocator.allocate(workerId)),
    ),
  );

  assert.equal(new Set(allocations.map(({ port }) => port)).size, allocations.length);
  const freshAllocator = new PortAllocator({ range: { start: 4100, end: 4103 } });
  for (const allocation of allocations) {
    assert.equal(allocation.port, allocator.get(allocation.workerId)?.port);
    assert.equal(allocator.preferredPort(allocation.workerId), freshAllocator.preferredPort(allocation.workerId));
  }
  assert.throws(() => allocator.allocate("worker-over-capacity"), PortAllocationError);
});

test("release makes a reservation reusable", () => {
  const allocator = new PortAllocator({ range: { start: 4200, end: 4200 } });
  const first = allocator.allocate("first");
  assert.deepEqual(allocator.release("first"), first);
  assert.equal(allocator.get("first"), undefined);
  assert.equal(allocator.allocate("second").port, first.port);
  assert.equal(allocator.release("missing"), undefined);
});

test("snapshot restores reservations without probing real ports", () => {
  const original = new PortAllocator({
    range: { start: 4300, end: 4302 },
    preview: { host: "localhost", path: "/preview" },
  });
  original.allocate("worker-a");
  original.allocate("worker-b");
  const state = original.snapshot();

  const restored = new PortAllocator({
    range: { start: 4300, end: 4302 },
    preview: { host: "localhost", path: "/preview" },
    state,
  });
  assert.deepEqual(restored.snapshot(), state);
  assert.deepEqual(restored.get("worker-a"), original.get("worker-a"));
  assert.deepEqual(restored.get("worker-b"), original.get("worker-b"));
});

test("rejects invalid ranges and invalid persisted collisions", () => {
  assert.throws(() => new PortAllocator({ range: { start: 0, end: 4000 } }), PortAllocationError);
  assert.throws(() => new PortAllocator({ range: { start: 4001, end: 4000 } }), PortAllocationError);
  assert.throws(() => new PortAllocator({ range: { start: 1, end: 65536 } }), PortAllocationError);
  assert.throws(
    () => new PortAllocator({
      range: { start: 4400, end: 4401 },
      state: { allocations: [{ workerId: "a", port: 4400 }, { workerId: "b", port: 4400 }] },
    }),
    PortAllocationError,
  );
});

test("preview URLs are optional and do not require a listener", () => {
  const withoutPreview = new PortAllocator({ range: { start: 4500, end: 4500 } });
  assert.equal(withoutPreview.allocate("worker").previewUrl, undefined);
  assert.equal(withoutPreview.previewUrl("worker"), undefined);
  assert.equal(buildPreviewUrl(4500, { host: "localhost" }), "http://localhost:4500");
  assert.equal(buildPreviewUrl(4500, { host: "::1", protocol: "https" }, "preview"), "https://[::1]:4500/preview");
});
