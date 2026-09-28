/** A Linear issue identifier such as `DEV-4` or a UUID. */
export type LinearIssueIdentifier = string;

/** The workflow statuses understood by the integration seam. */
export type LinearIssueStatusName =
  | "Todo"
  | "In Progress"
  | "In Review"
  | "Done";

/** Workflow events that can be requested by the rest of the application. */
export type LinearWorkflowIntent =
  | "todo"
  | "in-progress"
  | "in-review"
  | "done"
  | "changes-requested";

export interface LinearStatus {
  readonly id: string;
  readonly name: string;
  readonly type?: string;
}

export interface LinearComment {
  readonly id: string;
  readonly issueIdentifier: LinearIssueIdentifier;
  readonly body: string;
  readonly authorName?: string;
  readonly createdAt?: string;
  readonly updatedAt?: string;
}

export interface LinearIssue {
  readonly id: string;
  readonly identifier: LinearIssueIdentifier;
  readonly title: string;
  readonly description?: string;
  readonly status: LinearStatus;
  readonly teamId?: string;
  readonly url?: string;
}

/** A status transition requested for one issue.
 *
 * Applying this intent is idempotent: a client must not send a status mutation
 * when the issue already has the mapped target status.
 */
export interface LinearUpdateIntent {
  readonly identifier: LinearIssueIdentifier;
  readonly status: LinearWorkflowIntent;
}

export interface LinearCommentInput {
  readonly identifier: LinearIssueIdentifier;
  readonly body: string;
}

export interface LinearIssueUpdateInput {
  readonly identifier: LinearIssueIdentifier;
  readonly issueId: string;
  readonly status: LinearIssueStatusName;
}

export interface LinearIssueNotFoundErrorDetails {
  readonly identifier: LinearIssueIdentifier;
}
