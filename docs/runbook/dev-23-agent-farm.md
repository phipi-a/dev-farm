# DEV-23 agent-farm operations runbook

**Status: partial implementation; runtime operations planned.** This runbook is a credential-free operating contract for DEV-23. At this revision, the repository contains an implemented base-image definition and smoke validation, but no runtime, CLI, worker orchestration, or service configuration. Consequently, every `dev-farm` command and runbook-specific Pi launcher/session command below is **planned** until an implementation documents and tests that command. Do not treat the examples as evidence that a command exists.

## Status vocabulary

- **Implemented** means present and verified in the repository. The current implemented image pieces are [`docker/base-image/Dockerfile`](../../docker/base-image/Dockerfile) and [`docker/base-image/smoke.sh`](../../docker/base-image/smoke.sh); they do not provide the worker runtime or its CLI.
- **Planned** means the behavior and operator contract described here; it must not be advertised as available.
- **Operator action** means a command an operator may run against an already-installed dependency (for example, `git` or `tmux`).

| Area | Status | Evidence or boundary |
| --- | --- | --- |
| Base image definition and smoke validation | Implemented | [`Dockerfile`](../../docker/base-image/Dockerfile) defines the image; [`smoke.sh`](../../docker/base-image/smoke.sh) builds it and checks the non-root user and required tools. |
| `dev-farm` CLI, worker runtime/orchestration, and Pi launcher | Planned | No implementation exposes these operations yet. |
| Worker state, credential integration, service configuration, and backup | Planned | Requirements are described below but have no implementation. |

No secret, token, cookie, private key, or real repository URL belongs in this document, shell history, an image, or a worker checkout.

## 1. Installation and preflight

### 1.1 Prerequisites (operator action)

Use a dedicated workstation or host with:

- Git, Docker/Podman, and `tmux` installed and patched;
- network access to the approved Linear and GitHub endpoints;
- a secret manager or protected environment for short-lived credentials;
- enough disk for one image and one isolated checkout per active worker;
- a human reviewer who can review and merge pull requests.

Do not run workers as a host administrator. Reserve a non-privileged account and a directory with restrictive permissions (for example, mode `0700`).

### 1.2 Planned installation flow

The following is the planned flow, not a currently available installer:

```text
# Planned; command names are not implemented at the baseline.
git clone <approved-repository-url> <checkout-directory>
cd <checkout-directory>
dev-farm doctor
dev-farm init --state-dir <private-state-directory>
dev-farm image verify
```

`doctor` should fail closed when Docker/Podman, `tmux`, Git, required network access, or filesystem permissions are missing. `init` should create only local state and should never ask for a token on the command line. Image verification should check an immutable digest, not merely a mutable tag.

After installation, verify that no credentials were written to the checkout:

```sh
# Operator action; prints names and permissions only, never values.
find <checkout-directory> -maxdepth 2 -type f -name '*.env*' -print
stat -c '%a %n' <private-state-directory>
```

A future implementation must document its actual binary version and installation source here before this section can be marked implemented.

## 2. Project mapping

### 2.1 Mapping contract (planned)

A project mapping joins one Linear team/project to one GitHub repository. It must be explicit; workers must not infer a repository from an issue title or arbitrary user input.

Required fields:

| Field | Rule |
| --- | --- |
| Linear team key | Exact, case-sensitive key (for example, `TEAM`; use a placeholder in examples). |
| Linear project or issue scope | Approved project identifier, or an explicit team-wide policy. |
| GitHub owner/repository | Exact owner and repository; no wildcard or organization-wide default. |
| Default branch | Must be discovered from GitHub and recorded; never assume `main`/`master`. |
| Worker checkout root | Dedicated path outside the source of truth for mappings and secrets. |
| Allowed labels/statuses | Explicit allow-list used by the worker. |
| Human reviewer | Named team or role responsible for merge decisions. |

An illustrative, non-secret mapping (planned schema, not a config file) is:

```yaml
linear_team: <TEAM_KEY>
linear_project: <LINEAR_PROJECT_ID>
github_repository: <OWNER>/<REPOSITORY>
default_branch: <DEFAULT_BRANCH>
worker_root: <PRIVATE_WORKER_ROOT>
reviewer: <HUMAN_REVIEWER_OR_TEAM>
```

Never place tokens in this mapping. Store it in the private state directory only after the eventual implementation publishes and validates its schema. A mapping change requires a human review and a fresh preflight; it must not silently retarget an existing worker.

### 2.2 Planned mapping checks

Before starting work, the future CLI should verify:

1. the Linear team/project exists and is visible to the configured Linear identity;
2. the GitHub repository exists and is the exact mapped repository;
3. the default branch and branch-protection policy are readable;
4. the issue is in the mapped team/project and is not archived or cancelled;
5. the requested worker count and checkout paths are within local limits.

Planned examples:

```text
# Planned; no such CLI exists at the baseline.
dev-farm project list
dev-farm project check --linear <TEAM_KEY> --github <OWNER>/<REPOSITORY>
dev-farm issue start <TEAM_KEY>-<NUMBER>
```

## 3. Least-privilege Linear and GitHub credentials

### 3.1 Secret handling rules (implemented policy for operators)

- Obtain credentials from the organization-approved secret manager; do not paste them into this runbook or a ticket.
- Prefer short-lived, repository/team-scoped credentials. Assign one identity per environment or worker pool.
- Inject secrets at process start through the secret manager or protected environment. Do not bake them into an image or mount a host-wide credential directory.
- Do not pass secrets as command-line arguments: process listings, shell history, and tmux scrollback can expose them.
- Redact tokens, authorization headers, clone URLs containing credentials, and full API responses in logs and bug reports.
- Rotate and revoke a credential immediately after suspected exposure; then delete affected worker state and recreate it from a clean image.

### 3.2 Linear access (planned minimum)

Use a dedicated Linear identity restricted to the mapped team/project. The minimum intended operations are:

- read the mapped team, project, issue, labels, workflow states, and comments;
- update only the mapped issue's allowed state/assignee/labels;
- add an operational comment when a worker starts, pauses, fails, or requests review.

Do **not** grant workspace administration, user management, billing, team creation, integration management, or unrestricted workspace write access. If the selected Linear credential type cannot express these restrictions, record that limitation and use the narrowest team-scoped alternative; never compensate with a broad workspace token by default.

The future implementation must document the exact Linear credential type, scopes, and API operations it uses. Until then, a Linear token cannot be considered validated.

### 3.3 GitHub access (planned minimum)

Use a GitHub fine-grained token or GitHub App installation restricted to the mapped repository:

- **Metadata: read** (required by GitHub repository APIs);
- **Contents: read/write** (clone and push a worker branch);
- **Pull requests: read/write** (open and update a PR, if the worker is allowed to do so);
- **Checks/statuses: read** only when the worker must observe CI.

Issues, Actions, Discussions, workflow write, administration, organization management, repository deletion, and bypass of branch protection should remain unavailable unless a separately reviewed requirement proves otherwise. Do not give the worker merge permission. A reviewer uses a separate human identity, subject to branch protection and required checks.

The exact token/App permissions and API calls must be recorded by the eventual implementation. “It can clone” is not sufficient evidence of least privilege.

### 3.4 Safe preflight (planned)

A future preflight may check authentication without printing a secret:

```sh
# Planned interface; values are injected by a secret manager, not shell history.
test -n "${LINEAR_API_TOKEN:-}" && test -n "${GITHUB_TOKEN:-}"
dev-farm auth check --redact
```

A successful check proves only authentication, not that the identity is least privilege. Test an allowed read/write and an intentionally denied administrative operation with a disposable issue/branch, then revoke the test credential.

## 4. Image setup

### 4.1 Image requirements (partially implemented)

The repository includes an image definition at [`docker/base-image/Dockerfile`](../../docker/base-image/Dockerfile) and a smoke check at [`docker/base-image/smoke.sh`](../../docker/base-image/smoke.sh). The Dockerfile defines a pinned base image, a non-root `dev` user, Pi and repository tooling, and a healthcheck; the smoke script builds the image and checks the user, workspace, and required tools. These are implemented image-build pieces, not a worker runtime or orchestrator.

The worker image should be built from a pinned base digest and contain only the tools required by the mapped project. It should:

- run as a non-root UID/GID;
- contain no credentials, SSH keys, host socket, or personal configuration;
- pin package versions or record a reproducible lockfile;
- have a read-only base filesystem where practical, with explicit writable workspace and temporary paths;
- set a predictable locale, timezone, and non-interactive package mode;
- expose no service ports unless a reviewed task requires one;
- use an allow-listed outbound network policy for Linear, GitHub, package registries, and required CI endpoints;
- emit logs that exclude environment values and secrets.

The checked-in Dockerfile and smoke script implement the image definition and build-smoke path. Do not mark the full image setup implemented until a built image digest, vulnerability scan, and runtime security test are recorded. This image functionality does not implement worker provisioning, runtime orchestration, or a `dev-farm image` CLI.

### 4.2 Planned image lifecycle

```text
# Planned; the Dockerfile exists, but no dev-farm image or worker CLI exists.
dev-farm image build --source <approved-image-source>
dev-farm image scan --digest <IMAGE_DIGEST>
dev-farm image verify --digest <IMAGE_DIGEST>
dev-farm worker start --image-digest <IMAGE_DIGEST> <TEAM_KEY>-<NUMBER>
```

Never use `latest` for a production worker. On image update, drain workers, retain the old digest for recovery, and record the digest with each worker snapshot.

## 5. Pi and CLI usage

### 5.1 Planned CLI lifecycle

The planned CLI should make transitions explicit and idempotent. Illustrative usage:

```text
# Planned; unavailable until implemented.
dev-farm issue inspect <TEAM_KEY>-<NUMBER>
dev-farm worker start <TEAM_KEY>-<NUMBER> --image-digest <IMAGE_DIGEST>
dev-farm worker status <TEAM_KEY>-<NUMBER>
dev-farm worker logs <TEAM_KEY>-<NUMBER> --redact
dev-farm worker pause <TEAM_KEY>-<NUMBER>
dev-farm worker stop <TEAM_KEY>-<NUMBER>
```

A start must report the mapping, image digest, checkout path, branch, and credential identity without reporting credential values. A worker may push a branch or open/update a pull request only within the mapped repository. It must not merge.

### 5.2 Planned Pi session

Pi is the interactive worker/agent session, not a credential store and not a reviewer. The planned launcher should pass the issue identifier and a minimal task context, and should keep the session inside the isolated checkout:

```text
# Planned; exact Pi flags and prompt contract are not implemented.
dev-farm pi start <TEAM_KEY>-<NUMBER> --worker <WORKER_ID>
pi --session <WORKER_ID> --cwd <WORKER_CHECKOUT>
```

The launcher must prevent prompt input from overriding repository mapping, credential policy, review requirements, or destructive-operation confirmation. Human operators should inspect the Pi transcript and resulting diff; a transcript is not a code review.

## 6. tmux attach and detach

### 6.1 Planned session naming

Use a deterministic, escaped name such as `dev-farm-<TEAM_KEY>-<NUMBER>-<WORKER_ID>`. Do not put tokens or full issue titles in session names. A future CLI should create the session with a restricted environment and record its name in worker state.

```sh
# Operator action against tmux; the session must already exist.
tmux ls
tmux attach-session -t 'dev-farm-<TEAM_KEY>-<NUMBER>-<WORKER_ID>'
# Detach without stopping the worker: Ctrl-b, then d.
```

Planned convenience command:

```text
dev-farm worker attach <TEAM_KEY>-<NUMBER> --worker <WORKER_ID>
```

If attach fails, do not start a second worker until `worker status` confirms whether the first process is alive. tmux scrollback can contain sensitive output; use redacted logs and clear the session when exposure is suspected.

## 7. Worker states and operator actions

The following state model is planned. A state transition must be persisted before its side effect where possible, and retries must be safe.

| State | Meaning | Operator action |
| --- | --- | --- |
| `queued` | Accepted but not provisioned. | Check capacity and mapping. |
| `provisioning` | Checkout, image, and session are being prepared. | Wait; inspect logs if it exceeds the startup timeout. |
| `running` | Pi may edit only its isolated checkout. | Observe status/logs; do not edit the checkout concurrently. |
| `awaiting-review` | Branch/PR is ready for human review. | Review diff, tests, permissions, and Linear update. |
| `paused` | Work intentionally suspended with state retained. | Resume only after checking branch and credentials. |
| `recovering` | Restart or restore is in progress. | Confirm snapshot and image digest before resume. |
| `stopped` | Process ended; checkout and metadata retained. | Restart, archive, or destroy explicitly. |
| `failed` | A fatal error requires intervention. | Preserve logs/snapshot, diagnose, then retry from a clean boundary. |
| `destroyed` | Worker resources were explicitly deleted. | Do not attempt in-place recovery; use branch/snapshot if retained. |

No worker may transition directly to `merged`; merge is a human-controlled GitHub action after review. An implementation must expose the current state, last transition, reason, process/session identifier, branch, and image digest.

## 8. Recovery

1. **Lost terminal/tmux only:** list sessions and inspect worker status. Attach to the existing session; do not duplicate it.
2. **Pi process exited:** preserve redacted logs and the checkout diff. Mark `failed`, inspect the last operation, and restart only from a known checkpoint.
3. **Host restart:** reconstruct state from the private state directory and worker snapshot. Verify image digest, mapping, branch, and credential validity before resuming.
4. **Corrupt or exposed state:** stop the worker, revoke exposed credentials, retain only necessary redacted diagnostics, delete the worker checkout, and recreate from the approved image. Never “repair” an untrusted checkout in place.
5. **Linear/GitHub outage:** leave the worker paused or stopped; do not replay writes blindly. On recovery, reconcile remote issue/PR state before retrying.
6. **Conflicting branch/PR:** stop automation and ask the human reviewer to choose the source of truth. Do not force-push or close a PR automatically.

Planned recovery commands:

```text
# Planned; unavailable at the baseline.
dev-farm worker snapshot <WORKER_ID> --redact
dev-farm worker recover <WORKER_ID> --from <SNAPSHOT_ID>
dev-farm worker reconcile <TEAM_KEY>-<NUMBER>
```

## 9. Backup and restore

Back up only operational metadata needed to recover a worker: mapping version, issue ID, branch name, commit SHA, image digest, state history, and redacted logs. Do not back up tokens, environment dumps, full tmux scrollback, or unreviewed secrets.

Planned requirements:

- encrypt backups at rest and in transit;
- restrict backup access separately from worker access;
- version and integrity-check snapshots;
- retain at least one known-good snapshot before image or mapping changes;
- test a restore periodically on an isolated host;
- define retention and deletion dates before production use.

The Git remote and PR are not a complete backup: they do not preserve local uncommitted work. Conversely, a local snapshot is not a reviewed source of truth. Planned examples:

```text
# Planned; unavailable at the baseline.
dev-farm backup create --worker <WORKER_ID> --redact
dev-farm backup verify <SNAPSHOT_ID>
dev-farm backup restore <SNAPSHOT_ID> --target <EMPTY_WORKER_ROOT>
```

## 10. Stop and destroy

**Stop** is reversible: terminate Pi and the container/session, retain the checkout, branch metadata, and redacted diagnostics. Confirm no child process remains.

**Destroy** is destructive: stop first, capture an approved snapshot if needed, remove the container/session and private checkout, remove local credentials or mounts, and mark the worker `destroyed`. The remote branch and PR must not be deleted by default. Require an explicit worker ID and confirmation token; never implement destroy from a prompt embedded in an issue.

```text
# Planned; unavailable at the baseline.
dev-farm worker stop <WORKER_ID>
dev-farm worker destroy <WORKER_ID> --confirm <WORKER_ID>
```

Before destroy, a human must confirm one of: the PR/branch is the source of truth, a snapshot is retained, or all uncommitted work is intentionally discarded. After destroy, verify that the worker no longer appears in process lists, tmux, container lists, or the private state index.

## 11. Manual review and merge checklist

Automation may prepare a branch/PR; it must not approve or merge it. A human reviewer must:

- [ ] Confirm the PR targets the mapped repository and intended default branch.
- [ ] Read the complete diff, including generated files and dependency changes.
- [ ] Check that no credential, secret, personal data, or host path is committed.
- [ ] Run the repository's documented tests and inspect failures rather than trusting a green summary.
- [ ] Check CI, branch protection, dependency/security alerts, and changed workflow permissions.
- [ ] Verify the Linear issue scope, acceptance criteria, and status/comment are accurate.
- [ ] Confirm the worker did not modify files outside the assigned checkout or broaden access.
- [ ] Resolve review comments and re-check the final commit SHA.
- [ ] Merge using the repository's protected human workflow; do not bypass required checks.
- [ ] After merge, update/close the Linear issue manually or through a narrowly authorized, audited integration.

If any check fails, leave the issue in `awaiting-review` or `paused`, record the reason without secrets, and do not merge.

## 12. Known limitations and documentation gaps

- **Runtime/orchestration behavior remains planned:** this revision has no `dev-farm` CLI, Pi launcher, worker state store, credential integration, backup implementation, service configuration, or tmux orchestration. The base-image definition and smoke script are implemented separately; all operational commands in this runbook remain planned.
- The exact CLI name, flags, state persistence format, log redaction behavior, and exit codes are not specified by an implementation.
- Linear credential granularity depends on the credential type and workspace policy; exact API scopes and mutation allow-lists remain to be verified.
- GitHub permissions for CI/status reads and PR creation must be tested against the selected App/token model; branch-protection behavior is repository-specific.
- Network allow-listing, image supply-chain scanning, resource quotas, and host isolation need an implementation-level threat model and tests.
- Backup encryption, retention, restore drills, and deletion guarantees are policy requirements only until a backup system exists.
- No concurrency/locking contract exists yet for duplicate workers targeting one issue or branch.
- Merge conflicts, partial remote writes, API rate limits, and offline operation need explicit retry and reconciliation tests.
- A future implementation must replace each planned command with a versioned reference and link its automated tests here before this runbook can be called implemented.

## Local reference check

This document links to the implemented image files in `docker/base-image/`; its other command references are planned and are not executable references. Before release, run a Markdown heading/link check and verify every planned command against the actual CLI help output and integration tests.
