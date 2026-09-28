# Agent Farm public quickstart

This page separates checked-in behavior from host-owned or planned behavior. It is
safe to run without provider credentials unless a section explicitly says
otherwise.

## Implemented checks

Run the repository's credential-free tests:

```sh
npm test --workspace @agent-farm/core
npm test --workspace @agent-farm/cli
npm test --workspace @agent-farm/pi-extension
```

The core E2E test is included in the first command. It composes the real runtime
with deterministic Docker, Git, tmux, process, Linear HTTP, and GitHub HTTP
fakes. It proves that three workers have isolated workspaces, branches,
containers, and pull requests, and that cleanup stops resources and destroys
state. A hanging-worker test also proves that shutdown aborts the run and stops
its labelled container. No daemon, shell, network, Pi process, provider, or
ambient credential is contacted by this test path.

Build and smoke-test the developer image separately:

```sh
./docker/base-image/smoke.sh
```

The script requires a Docker-compatible CLI/context. It builds the image without
credentials and checks the non-root `dev` user, writable workspace, and `pi`,
`git`, `gh`, `tmux`, `rg`, and `curl`. `IMAGE_TAG`, `PI_VERSION`, and
`IMAGE_VERSION` may be supplied as environment variables. This is an image
smoke test, not proof that a live worker or provider integration works.

## Runtime configuration (implemented library boundary)

The runtime is created by a host with `createRuntime` from
`@agent-farm/core/runtime`; it does not read a config file, start a daemon, or
read `process.env` itself. Configuration is validated by `loadConfig` and must
contain at least one project, a private state path, a Docker name prefix, a
valid port range, and an image reference:

```ts
const config = {
  projects: [
    {
      name: "platform",
      linearTeam: "PLAT",
      githubRepo: "acme/platform",
      defaultBranch: "main",
    },
  ],
  statePath: "/var/lib/dev-farm/state.sqlite",
  dockerPrefix: "dev-farm",
  portRange: { start: 4100, end: 4199 },
  baselineImage: "ghcr.io/acme/dev-farm@sha256:<64 lowercase hex characters>",
};

const runtime = createRuntime({ config, ports });
await runtime.start();
try {
  // The host invokes orchestrator/workflow operations here.
} finally {
  await runtime.shutdown();
}
```

`ports` is an explicit host boundary for Docker, Git, tmux, the Pi process,
Linear/GitHub HTTP, credentials, and SQLite. The runtime graph is injectable and
has no implicit live adapters. `runtime.start()` reconciles persisted workers;
`shutdown()` is idempotent, aborts active Pi runs, best-effort stops their
labelled containers, and closes SQLite.

## Credential injection (implemented boundary)

Only `LINEAR_API_TOKEN` and `GITHUB_TOKEN` are accepted. A host may resolve
values from its approved secret manager and pass them through the credential
port; for a simple local process, the library helper is:

```ts
const credentials = credentialsFromEnvironment({
  LINEAR_API_TOKEN: process.env.LINEAR_API_TOKEN,
  GITHUB_TOKEN: process.env.GITHUB_TOKEN,
});
const ports = { ...hostPorts, credentials };
```

This helper copies only the allowlisted names. Values must not appear in config,
command arguments, logs, prompts, fixtures, or persisted state. The runtime
stores credential references and uses the injected provider; production hosts
remain responsible for secret-manager access, rotation, and revocation. The
normal fake test path uses fixed fixture sentinels rather than environment
credentials.

## Worker stop and destroy

The implemented cleanup service distinguishes reversible stop from destructive
destroy:

- **Stop** terminates the worker process/container resources, retains state and
  review metadata, and transitions the worker to `stopped` when cleanup
  succeeds. It is safe to retry an already-stopped worker.
- **Destroy** requires explicit confirmation, previews warnings first, stops
  resources, removes worker-owned container/network/volume resources, releases
  allocated ports, and transitions through `stopped` to `destroyed`. It does
  not delete the remote branch, commit, or pull request; those are warning-only
  metadata. Retry cleanup and inspect reported issues before declaring it done.

The CLI parser requires `--yes` for `merge` and `destroy`; the runtime CLI
adapter maps `stop` and `destroy` to runtime state/Docker resources. Higher-level
`shell`, `logs`, `pr`, `continue`, and `merge` handlers must be injected by the
host and fail explicitly when absent. There is no supported standalone daemon
command in this repository.

## Review and merge boundary

`ReviewWorkflow` can mark an open PR ready for review, persist an exact review
snapshot, record `changes_requested`, and resume the same worker for corrections.
It has no merge capability and rejects automatic merge attempts. A human must
review the complete diff, tests, permissions, and current head SHA.

`MergeWorkflow` is a separate, explicitly confirmed operation. Before merging,
it re-inspects the PR and requires an open PR, successful CI and required
checks, an approved review, and confirmed mergeability. Worker-initiated merge
is rejected. After the provider reports success, optional audited Linear
completion, baseline refresh, and worker cleanup hooks may run; the workflow
never deletes branches or PRs.

The checked-in CLI supports the command vocabulary (`list`, `status`, `attach`,
`shell`, `logs`, `preview`, `pr`, `continue`, `merge`, `stop`, and `destroy`),
JSON output, redaction, exit codes, and destructive confirmation. Its runtime
facade is an injectable adapter, not a claim that every command is wired to a
production host.

## E2E cleanup contract

Every composed or live host runner must clean up in a `finally` block:

```ts
try {
  // run the scenario
} finally {
  await runtime.shutdown();
  await rm(tempDirectory, { recursive: true, force: true });
}
```

The checked-in harness is fake-only by default. A separately maintained live
runner must explicitly inject `RuntimePorts.linearHttp` and
`RuntimePorts.githubHttp`, provide credentials without persisting them, use
isolated disposable provider resources, and assert Docker/tmux/state cleanup.
It must not enable live mode through the normal `npm test` command and must not
merge unless its own explicit merge gate authorizes the intended PR.

## Planned or host-owned behavior

There is no checked-in installer, service unit, provider-backed end-to-end
runner, or standalone command that discovers runtime ports and credentials.
Image vulnerability scanning, deployment topology, secret-manager policy, and
live Linear/GitHub test resources remain host/release responsibilities. See the
[operations runbook](runbook/dev-23-agent-farm.md) for the full lifecycle and
security contract.
