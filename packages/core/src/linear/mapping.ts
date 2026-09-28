import type {
  LinearIssueStatusName,
  LinearWorkflowIntent,
} from "./types";

/**
 * Maps application workflow intent to the exact status name expected by a
 * Linear transport. Changes requested returns the active work state so a
 * follow-up implementation can be picked up again.
 */
export const LINEAR_STATUS_BY_INTENT: Readonly<
  Record<LinearWorkflowIntent, LinearIssueStatusName>
> = {
  todo: "Todo",
  "in-progress": "In Progress",
  "in-review": "In Review",
  done: "Done",
  "changes-requested": "In Progress",
};

export function statusForIntent(
  intent: LinearWorkflowIntent,
): LinearIssueStatusName {
  return LINEAR_STATUS_BY_INTENT[intent];
}

/** Returns true when applying the intent would change the issue's status. */
export function statusNeedsUpdate(
  currentStatus: string,
  intent: LinearWorkflowIntent,
): boolean {
  return currentStatus !== statusForIntent(intent);
}
