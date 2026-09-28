# DEV-39 runtime E2E harness

The checked-in E2E harness is deterministic and credential-free by default:

```sh
npm test --workspace @agent-farm/core
```

`packages/core/src/e2e/runtime-harness.ts` constructs the real runtime composition
root (`createRuntime`) and injects test adapters for Docker, Git, tmux, Pi
processes, Linear HTTP, and GitHub HTTP. The adapters never invoke a daemon,
network, shell, provider, or environment credential lookup. Provider adapters
receive fixed fixture sentinel strings only because the production transports
require a credential provider; these are not secrets and are not read from
`process.env`.

The composed test proves three isolated workers reach review, each gets a
separate workspace/branch/container/PR, and cleanup stops Docker resources and
destroys state. A second test leaves Pi hanging, calls runtime shutdown, and
proves the run is aborted, the worker is marked failed, and its labelled
Docker resource is stopped.

## Optional real-provider contract

Real Linear/GitHub execution is **not** part of `npm test`, CI, or the checked-in
harness. A host may build an explicit integration runner around
`createRuntime`, but it must satisfy this exact contract:

1. Opt in outside this repository's normal test command (for example, a
   separately maintained `DEV_FARM_E2E_LIVE=1` runner). There is no implicit
   live mode and `runDogfoodScenario({ enableLiveProviders: true })` remains a
   deliberate rejection in the credential-free harness.
2. Inject `RuntimePorts.linearHttp` and `RuntimePorts.githubHttp`; the runtime
   does not call global `fetch` and does not read provider environment variables.
3. Inject `RuntimePorts.credentials` with the host's secret store. The
   production credential names are exactly `LINEAR_API_TOKEN` and
   `GITHUB_TOKEN`; values must never be placed in test fixtures, command
   arguments, logs, prompts, or persisted state.
4. Supply the remaining host boundaries (`docker`, `git`, `tmux`, `process`,
   and `database`) and an isolated temporary SQLite path. The host owns
   Docker/tmux/Pi lifecycle and must call `runtime.shutdown()` in `finally`.
5. Use a disposable Linear issue and GitHub repository/branch namespace. The
   runner must assert cleanup and safe failure, and must not merge unless its
   own explicit merge gate confirms the intended PR and repository.

The live boundary is therefore the injected `RuntimePorts` implementation and
credential provider. No live test is accepted as evidence for the normal,
credential-free CI path.
