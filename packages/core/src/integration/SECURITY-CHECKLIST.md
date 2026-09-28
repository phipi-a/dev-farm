# DEV-24 security checklist

The automated checks use an in-memory Docker boundary and synthetic values; they never
require Docker, host credentials, or a host home directory.

Run from the repository root:

```sh
npm test --workspace @agent-farm/core
```

The machine-readable checklist is `security-checklist.json`. Automated checks cover:

- Docker socket and host-home mount rejection before container creation.
- Non-root identity, capability, restricted-network, and resource-policy rejection.
- Exact resource propagation and distinct worker/container/workspace identities during parallel starts.
- Redaction of credential-like values from validation diagnostics.

Manual host/container checks remain **unverified** by these tests. On a disposable host,
inspect a real worker and verify mounts, effective UID, capabilities, memory/CPU/PID limits,
and network mode. The production adapter must resolve bind-mount and workspace paths with
`realpath` before policy validation; lexical policy tests cannot prove symlink containment.
