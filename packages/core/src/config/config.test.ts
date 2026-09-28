import assert from "node:assert/strict";
import test from "node:test";
import {
  ConfigValidationError,
  RuntimeCredentials,
  projectForLinearTeam,
  validateProjectMapping,
  credentialsFromEnvironment,
  injectRuntimeCredentials,
  loadConfig,
  serializeConfig,
} from "./config.ts";

const validConfig = {
  projects: [
    {
      name: "platform",
      linearTeam: "PLAT",
      githubRepo: "acme/platform",
      defaultBranch: "trunk",
    },
  ],
  statePath: "/var/lib/dev-farm/state.sqlite",
  dockerPrefix: "dev-farm",
  portRange: { start: 4100, end: 4199 },
  baselineImage:
    "ghcr.io/acme/dev-farm@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
};

test("loads a typed config and supports multiple project mappings", () => {
  const config = loadConfig({
    ...validConfig,
    projects: {
      platform: validConfig.projects[0],
      docs: {
        linearTeam: "DOCS",
        githubRepo: "acme/docs",
        defaultBranch: "main",
      },
    },
  });

  assert.deepEqual(config.projects, [
    {
      name: "platform",
      linearTeam: "PLAT",
      githubRepo: "acme/platform",
      defaultBranch: "trunk",
    },
    {
      name: "docs",
      linearTeam: "DOCS",
      githubRepo: "acme/docs",
      defaultBranch: "main",
    },
  ]);
  assert.equal(config.portRange.start, 4100);
  assert.equal(config.credentials.linear, "LINEAR_API_TOKEN");
});

test("requires an explicit, unique Linear team mapping", () => {
  const config = loadConfig(validConfig);
  assert.equal(projectForLinearTeam(config.projects, "PLAT").githubRepo, "acme/platform");
  assert.throws(
    () => projectForLinearTeam(config.projects, "UNKNOWN"),
    /not mapped to exactly one project/,
  );
  assert.throws(
    () =>
      validateProjectMapping(config.projects[0], { linearTeam: "PLAT", githubRepo: "acme/other" }),
    /does not match the configured project mapping/,
  );
  assert.throws(
    () =>
      loadConfig({
        ...validConfig,
        projects: [validConfig.projects[0], { ...validConfig.projects[0], name: "other" }],
      }),
    /linear team mappings must be unique/,
  );
});

test("reports missing and invalid fields without echoing values", () => {
  const token = "super-secret-token";
  assert.throws(
    () =>
      loadConfig({
        statePath: token,
        dockerPrefix: "Bad Prefix",
        baselineImage: "registry/image latest",
        portRange: { start: 0, end: 70000 },
        projects: [
          {
            linearTeam: "",
            githubRepo: "https://user:password@example.test/private",
            defaultBranch: "",
          },
        ],
        credentials: { linear: "SECRET_ENV", github: "GITHUB_TOKEN", token },
      }),
    (error: unknown) => {
      if (!(error instanceof ConfigValidationError)) return false;
      assert(!error.message.includes(token));
      assert(!JSON.stringify(error).includes(token));
      return error.issues.length > 0;
    },
  );
});

test("rejects malformed JSON without exposing its contents", () => {
  const secret = "secret-value";
  assert.throws(
    () => loadConfig(`{"statePath":"${secret}`),
    (error: unknown) => {
      if (!(error instanceof ConfigValidationError)) return false;
      assert(!error.message.includes(secret));
      return true;
    },
  );
});

test("runtime credentials accept only the allowlist and are redacted when serialized", () => {
  const secret = "linear-secret";
  const credentials = credentialsFromEnvironment({
    LINEAR_API_TOKEN: secret,
    GITHUB_TOKEN: "github-secret",
    AWS_SECRET_ACCESS_KEY: "must-not-be-copied",
  });
  assert.equal(credentials.get("LINEAR_API_TOKEN"), secret);
  assert.deepEqual(injectRuntimeCredentials({ WORKER_ID: "worker-1" }, credentials), {
    WORKER_ID: "worker-1",
    LINEAR_API_TOKEN: secret,
    GITHUB_TOKEN: "github-secret",
  });
  assert(!JSON.stringify(credentials).includes(secret));
  assert(!String(credentials).includes(secret));
  assert.equal(JSON.stringify(loadConfig(validConfig)).includes(secret), false);

  assert.throws(
    () => new RuntimeCredentials({ AWS_SECRET_ACCESS_KEY: "not-allowed" } as never),
    /not allowlisted/,
  );
});

test("serializes config without runtime credential values", () => {
  const serialized = serializeConfig(loadConfig(validConfig));
  assert(serialized.includes("state.sqlite"));
  assert(!serialized.includes("linear-secret"));
});
