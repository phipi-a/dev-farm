# ADR-0001: Agent-farm lifecycle, isolation, and GitHub authority

- **Status:** Accepted
- **Date:** 2026-09-28
- **Scope:** Architecture and lifecycle contracts for DEV-1

## Context

The agent farm needs to turn a work request into an isolated implementation workspace, expose the work for review, support follow-up changes, and clean up the workspace after completion. The repository currently contains no implementation, so this ADR defines the contracts that future components must preserve without prescribing an implementation language, hosting model, or deployment topology.

Linear is the intake and planning surface for a request. GitHub is the source of truth for repository content, branches, commits, pull requests (PRs), review decisions, checks, and merge state. A Linear status may be synchronized from GitHub, but it must not override GitHub facts.

The farm must not merge code autonomously. A review result can make a change eligible for merge; only an explicitly authorized human merge action may perform the merge.

## Decision

Build the farm around an orchestrator that coordinates adapters and isolated workspaces. Keep provider-specific behavior at adapter boundaries, and make lifecycle transitions auditable and idempotent.

### Components and responsibilities

The following are logical components. They may be combined in an implementation, but their responsibilities and trust boundaries remain distinct.

| Component | Responsibility | Authority or boundary |
| --- | --- | --- |
| **Request/intake adapter** | Reads a Linear work request and records its stable identifier, repository, and requested scope. | Reads planning metadata; does not decide repository state. |
| **Orchestrator** | Owns lifecycle transitions, correlation IDs, retries, and sequencing. It issues commands but does not invent GitHub state. | The only component allowed to advance farm lifecycle state. |
| **GitHub adapter** | Reads and writes branches, commits, PRs, reviews, checks, and merge operations through GitHub. | GitHub is authoritative for all repository and PR facts. |
| **Workspace manager** | Creates, leases, inspects, and destroys one isolated workspace per active attempt. | Can affect only the assigned workspace and its explicitly scoped credentials. |
| **Agent runner** | Executes approved work in its assigned workspace and reports commits, logs, and failures. | No direct access to another workspace; no merge authority. |
| **Review coordinator** | Publishes a PR for review, collects review/check outcomes, and requests another pass when needed. | Can request review; cannot merge. |
| **Lifecycle record/audit store** | Persists transitions, actor, timestamps, correlation IDs, and provider references. | Records observed facts and commands; it is not a second source of truth for GitHub state. |
| **Cleanup controller** | Performs idempotent teardown after terminal states and records cleanup failures for retry. | May destroy only the workspace and credentials owned by the attempt. |

The orchestrator must tolerate retries. Every externally visible command should carry an attempt ID and correlation ID, and operations should be safe to repeat or reconcile by reading current GitHub/workspace state first.

### System data flow

1. A request is identified in Linear and normalized into an attempt. The intake adapter stores the Linear identifier as a reference, not as repository truth.
2. The orchestrator asks the workspace manager for a new isolated workspace and asks the GitHub adapter for the source revision and branch/PR context.
3. The agent runner receives only the attempt's workspace, task context, and least-privilege credentials. It produces commits on the attempt branch and reports their identifiers.
4. The GitHub adapter publishes or updates the PR. GitHub then owns branch contents, review decisions, required checks, and merge state.
5. The review coordinator observes GitHub events or reconciles GitHub state. It reports `changes requested`, `approved`, or `checks failed` to the orchestrator.
6. The orchestrator either returns the attempt to the agent for more work, waits for an explicitly authorized human merge, or starts cleanup after a terminal outcome.
7. Lifecycle/audit records retain the causal trail and provider IDs. They can explain what happened but cannot claim that an unobserved GitHub action occurred.

#### Authoritative state rules

- **GitHub authoritative:** branch tip, commit ancestry, PR existence, PR state, review state, required checks, and merge commit.
- **Linear advisory/synchronized:** planning status, title, description, and links to the PR or attempt. Synchronization must not mutate GitHub state or represent a merge that GitHub does not report.
- **Farm authoritative:** attempt identity, workspace lease, lifecycle transition history, and cleanup intent. The farm must reconcile these records with GitHub and the workspace manager after restart.

## Lifecycle state machine

An attempt has one lifecycle state. Transitions are accepted only when their preconditions hold and are recorded with the actor (`system`, `agent`, `reviewer`, or `human`) and provider evidence.

```text
Requested
   | start accepted
   v
Provisioning -- provision failure --> Failed
   | workspace + source revision ready
   v
Active -- agent/attempt failure --> Failed
   | PR published or updated
   v
ReviewRequested -- changes requested or checks fail --> ChangesRequested
   | continue
   v
Active
   | approval + required checks pass
   v
AwaitingHumanMerge -- human declines/cancels --> Cancelled
   | explicit human merge action
   v
Merged

Failed, Cancelled, and Merged -- cleanup --> Destroyed
```

The diagram shows the normal path; these invariants apply to every path:

- `Provisioning` does not expose an attempt as ready until the workspace and source revision are verified.
- `Active` owns the only writable agent workspace for the attempt.
- `ReviewRequested` and `ChangesRequested` require a GitHub PR reference.
- `AwaitingHumanMerge` is a holding state, not permission to merge. Approval and passing checks are necessary but never sufficient for an automated merge command.
- `Merged` is entered only after GitHub reports a successful merge. A local command or Linear update cannot create this state.
- `Destroyed` is terminal for the workspace lease. Cleanup is idempotent and may be retried without changing GitHub history.
- `Failed` and `Cancelled` are terminal business outcomes, but cleanup remains required.

## Operational sequences

The sequences below describe the contract, not a specific API or job system. At each step, a retry must first reconcile current state with GitHub and the workspace manager.

### Start

1. Intake receives a Linear request and creates an attempt ID and correlation ID.
2. The orchestrator validates that the repository and requested scope are present; it records `Requested`.
3. The workspace manager provisions an isolated workspace and scoped credentials; the orchestrator records `Provisioning`.
4. The GitHub adapter resolves the source revision and creates or reserves the attempt branch without rewriting unrelated branches.
5. The agent runner receives the task and workspace. After readiness checks, the orchestrator records `Active`.
6. No merge permission is issued as part of start.

If provisioning or source resolution fails, record `Failed`, preserve diagnostics, and proceed to cleanup.

### Review

1. The agent reports its commit(s); the GitHub adapter verifies the commits and opens or updates the attempt PR.
2. The orchestrator records `ReviewRequested` with the PR number, head SHA, and base branch observed from GitHub.
3. Reviewers and required GitHub checks evaluate the PR independently of the farm's local record.
4. The review coordinator reconciles GitHub's current review/check state:
   - requested changes or failing required checks transition to `ChangesRequested` (or back to `Active` when work is immediately resumed);
   - approval and passing required checks transition to `AwaitingHumanMerge`.
5. A stale head SHA invalidates the prior review observation; the PR must be reconciled again after new commits.

### Continue

1. A `ChangesRequested` attempt is resumed only from the same isolated workspace or a newly provisioned replacement tied to the same attempt, never from another active attempt's workspace.
2. The orchestrator supplies the PR feedback and current GitHub head SHA to the agent.
3. The agent changes only the attempt branch, reports new commit IDs, and does not merge.
4. The GitHub adapter updates the PR; the orchestrator returns to `ReviewRequested` after the update is visible.
5. If the workspace is unavailable, the orchestrator provisions a replacement from the current GitHub head and records the replacement lease in the audit trail.

### Merge

1. The orchestrator reconciles the PR directly from GitHub and confirms the current head SHA, base branch, required checks, and review state.
2. The system presents the eligible PR to an explicitly authorized human. Eligibility is informational; it is not an authorization token.
3. The human performs the merge through the approved GitHub control path. The farm does not call a merge endpoint, press a merge button, or auto-merge on the human's behalf.
4. The GitHub adapter observes the resulting merged state and merge commit. Only then does the orchestrator record `Merged`.
5. If the PR is closed without merge, the attempt is recorded as `Cancelled` (or an equivalent explicitly approved terminal outcome) and proceeds to cleanup. The implementation must not silently relabel this as `Merged`.

### Destroy

1. On `Merged`, `Cancelled`, or `Failed`, the cleanup controller revokes attempt-scoped credentials and terminates the workspace lease.
2. It removes temporary artifacts owned by the attempt and records success or a retryable failure. It must not delete branches, PRs, commits, or other resources outside the attempt's explicit ownership.
3. Cleanup retries reconcile ownership before deletion. A cleanup failure keeps the business outcome terminal while leaving a visible operational alert.
4. The lifecycle record is retained according to the eventual retention policy; destroying a workspace does not destroy audit evidence or GitHub history.

## Isolation boundaries and security invariants

- **Workspace boundary:** one attempt gets one workspace lease. Filesystem paths, containers/VMs, caches, and process namespaces must not be shared across active attempts unless an explicitly reviewed design proves safe isolation.
- **Credential boundary:** credentials are scoped to the smallest required GitHub operations and repository. Agent credentials cannot merge, administer repositories, or read another attempt's secrets.
- **Network boundary:** the runner may reach only approved services required by the task. The architecture does not assume unrestricted access to internal networks.
- **Data boundary:** task context and review feedback are scoped to the attempt. Logs must avoid secrets and identify the attempt/correlation ID.
- **Control boundary:** agents, review coordinators, and Linear synchronization cannot merge. The human-controlled GitHub path is the sole merge authority.
- **Repository boundary:** an attempt may write only its own branch. It must not force-push or alter protected/base branches unless a separately approved policy grants that operation.
- **Failure boundary:** a crashed runner or lost orchestrator must be recoverable by reconciliation, not by assuming that an unrecorded action completed.

## Consequences

### Positive

- GitHub's observable state prevents stale local state from being treated as fact.
- Explicit states and idempotent operations make retries and orchestrator restarts recoverable.
- Workspace and credential boundaries limit cross-attempt impact.
- Human-controlled merging preserves review accountability and makes the no-auto-merge policy testable.
- The architecture can be implemented incrementally without committing to a particular runtime or deployment platform.

### Costs and trade-offs

- Reconciliation is required after failures and may make a transition asynchronous.
- The farm must maintain audit records and provider references in addition to Linear links.
- Cleanup needs retries and alerting because terminal business state and resource teardown can complete at different times.
- A human merge step is intentionally slower than automation and remains an operational dependency.

## Assumptions and explicitly deferred decisions

These are assumptions for this ADR, not silent product decisions:

- Linear remains the intake/planning system, while GitHub remains repository and merge authority.
- GitHub branch protection, required checks, reviewer policy, credential mechanism, workspace technology, event transport, retention period, and failure-alerting destination are not selected here.
- The exact Linear statuses and synchronization direction are deferred; any implementation must preserve the authority rules above.
- Whether a closed-unmerged PR maps to `Cancelled` or another terminal business label requires product agreement before implementation.
- Any future change to merge authority, repository scope, or cross-attempt resource sharing requires a new ADR or an explicit amendment.

## Rejected alternatives

- **Linear as repository authority:** rejected because it cannot authoritatively represent branch tips, review freshness, checks, or merge commits.
- **Farm database as merge authority:** rejected because a local record can become stale or diverge from GitHub.
- **Automatic merge after approval:** rejected by policy; approval/check eligibility must stop at `AwaitingHumanMerge`.
- **Shared mutable workspaces:** rejected because they weaken attribution, isolation, and cleanup ownership.
