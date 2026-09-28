import { strict as assert } from "node:assert";
import { test } from "node:test";

import { generateBranchName, isSafeBranchName } from "./branch-name";

test("generates a deterministic safe branch from a Linear issue", () => {
  assert.equal(
    generateBranchName("DEV-6", "Add OAuth / callback"),
    "linear/dev-6-add-oauth-callback",
  );
});

test("does not allow input separators to become ref separators", () => {
  const branch = generateBranchName("DEV/6", "../../main @{} ");
  assert.equal(branch, "linear/dev-6-main");
  assert.equal(isSafeBranchName(branch), true);
  assert.equal(isSafeBranchName("linear/../main"), false);
  assert.equal(isSafeBranchName("linear/dev@{6}"), false);
});

test("truncates only the slug and preserves the issue identity", () => {
  const branch = generateBranchName("DEV-6", "a very long issue title", { maxLength: 24 });
  assert.equal(branch, "linear/dev-6-a-very-long");
  assert.equal(branch.length <= 24, true);
});

test("rejects an identifier that cannot produce a safe ref", () => {
  assert.throws(() => generateBranchName("///", "title"), /issueIdentifier/);
});
