import assert from "node:assert/strict";

export { assert };

export async function rejectsWith<T extends Error>(
  operation: Promise<unknown>,
  errorType: new (...args: never[]) => T,
  message?: RegExp,
): Promise<T> {
  try {
    await operation;
  } catch (error) {
    assert.ok(error instanceof errorType);
    if (message !== undefined) assert.match(error.message, message);
    return error;
  }
  assert.fail(`expected ${errorType.name} to be thrown`);
}

export function eventually<T>(
  operation: () => Promise<T>,
  timeoutMs = 250,
): Promise<T> {
  return Promise.race([
    operation(),
    new Promise<T>((_, reject) => {
      const timer = setTimeout(() => reject(new Error(`operation exceeded ${timeoutMs}ms`)), timeoutMs);
      timer.unref();
    }),
  ]);
}
