import test from "node:test";

import { PortAllocationError, PortAllocator } from "../ports/port-allocator";
import { assert } from "./harness";

test("ports contract: parallel allocations are distinct and deterministic", async () => {
  const options = { range: { start: 5100, end: 5107 } } as const;
  const allocator = new PortAllocator(options);
  const allocations = await Promise.all(
    Array.from({ length: 8 }, (_, index) =>
      Promise.resolve().then(() => allocator.allocate(`worker-${index}`)),
    ),
  );

  assert.equal(new Set(allocations.map(({ port }) => port)).size, 8);
  const fresh = new PortAllocator(options);
  for (const allocation of allocations) {
    assert.equal(fresh.allocate(allocation.workerId).port, allocation.port);
    assert.equal(allocator.preferredPort(allocation.workerId), fresh.preferredPort(allocation.workerId));
  }
});

test("ports contract: repeated allocation is idempotent and release is reusable", () => {
  const allocator = new PortAllocator({ range: { start: 5200, end: 5201 } });
  const first = allocator.allocate("worker");

  assert.deepEqual(allocator.allocate("worker"), first);
  assert.deepEqual(allocator.release("worker"), first);
  assert.equal(allocator.get("worker"), undefined);
  assert.equal(allocator.allocate("replacement").port, first.port);
});

test("ports contract: exhaustion and invalid persisted state fail safely", () => {
  const allocator = new PortAllocator({ range: { start: 5300, end: 5300 } });
  allocator.allocate("worker");
  assert.throws(() => allocator.allocate("other"), PortAllocationError);
  assert.throws(
    () => new PortAllocator({
      range: { start: 5300, end: 5301 },
      state: { allocations: [
        { workerId: "one", port: 5300 },
        { workerId: "two", port: 5300 },
      ] },
    }),
    PortAllocationError,
  );
});

test("ports contract: snapshots contain only allocation state", () => {
  const allocator = new PortAllocator({
    range: { start: 5400, end: 5400 },
    preview: { host: "preview.example.test", path: "/worker" },
  });
  allocator.allocate("worker");

  const snapshot = allocator.snapshot();
  assert.deepEqual(Object.keys(snapshot), ["allocations"]);
  assert.equal(JSON.stringify(snapshot).includes("preview.example.test"), false);
  assert.match(allocator.get("worker")?.previewUrl ?? "", /^http:\/\/preview\.example\.test:5400/);
});
