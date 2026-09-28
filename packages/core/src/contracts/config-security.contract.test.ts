import test from "node:test";

import {
  ConfigValidationError,
  RuntimeCredentials,
  credentialsFromEnvironment,
  serializeConfig,
  validateConfig,
} from "../config/config";
import {
  redactSecrets,
  validateWorkerIsolation,
} from "../security/isolation-policy";
import { assert } from "./harness";

const validConfig = {
  projects: [{
    name: "dev-farm",
    linearTeam: "DEV",
    githubRepo: "acme/widget",
    defaultBranch: "main",
  }],
  statePath: "/var/lib/dev-farm/state.json",
  dockerPrefix: "devfarm",
  portRange: { start: 5000, end: 5100 },
  baselineImage: "node:22",
};

test("config contract: validation errors never echo malformed secret values", () => {
  const secret = "super-secret-token-value";
  assert.throws(
    () => validateConfig({
      ...validConfig,
      credentials: { linear: secret, github: "GITHUB_TOKEN" },
    }),
    (error: unknown) => {
      assert.ok(error instanceof ConfigValidationError);
      assert.equal(error.message.includes(secret), false);
      assert.equal(JSON.stringify(error).includes(secret), false);
      return true;
    },
  );
});

test("config contract: runtime credentials are allowlisted and opaque", () => {
  const credentials = credentialsFromEnvironment({
    LINEAR_API_TOKEN: "linear-secret",
    GITHUB_TOKEN: "github-secret",
    AWS_SECRET_ACCESS_KEY: "must-not-cross-boundary",
  });
  const injected = credentials.injectInto({ PATH: "/usr/bin" });

  assert.deepEqual(injected, {
    PATH: "/usr/bin",
    LINEAR_API_TOKEN: "linear-secret",
    GITHUB_TOKEN: "github-secret",
  });
  assert.equal(credentials.toString(), "[REDACTED CREDENTIALS]");
  assert.equal(JSON.stringify(credentials), '"[REDACTED CREDENTIALS]"');
  assert.equal(JSON.stringify(injected).includes("must-not-cross-boundary"), false);
});

test("config contract: serialized config contains schema values but no runtime credential values", () => {
  const config = validateConfig(validConfig);
  const serialized = serializeConfig(config);

  assert.equal(serialized.includes("LINEAR_API_TOKEN"), true);
  assert.equal(serialized.includes("linear-secret"), false);
});

test("security contract: safe requests pass and unsafe capabilities/mounts fail", () => {
  const policy = {
    allowedCapabilities: ["NET_BIND_SERVICE"],
    credentials: { allowedNames: ["GITHUB_TOKEN"], allowedKinds: ["env"] },
    network: { allowedModes: ["none"], allowedHosts: [] },
  } as const;
  const safe = validateWorkerIsolation({
    user: 1000,
    workspace: { hostPath: "/workspaces/dev-25", path: "/workspace" },
    network: { mode: "none" },
    capabilities: ["net_bind_service"],
    credentials: [{ name: "GITHUB_TOKEN", kind: "env", value: "secret" }],
    logFields: { token: "secret", issue: "DEV-25" },
  }, policy);
  assert.equal(safe.valid, true);
  assert.deepEqual(safe.logFields, { token: "[REDACTED]", issue: "DEV-25" });

  const unsafe = validateWorkerIsolation({
    user: 0,
    privileged: true,
    mounts: [{ source: "/var/run/docker.sock", destination: "/docker.sock" }],
    network: { hostNetwork: true },
  });
  assert.equal(unsafe.valid, false);
  assert.ok(unsafe.failures.some(({ code }) => code === "privileged"));
  assert.ok(unsafe.failures.some(({ code }) => code === "forbidden-mount"));
  assert.ok(unsafe.failures.some(({ code }) => code === "root"));
  assert.ok(unsafe.failures.some(({ code }) => code === "network"));
});

test("security contract: nested and circular diagnostic fields are redacted", () => {
  const fields: { token: string; nested: { password: string }; self?: unknown } = {
    token: "token-value",
    nested: { password: "password-value" },
  };
  fields.self = fields;
  const redacted = redactSecrets(fields);

  assert.deepEqual(redacted, {
    token: "[REDACTED]",
    nested: { password: "[REDACTED]" },
    self: "[CIRCULAR]",
  });
});
