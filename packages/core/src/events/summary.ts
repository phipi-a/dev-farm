import type { WorkerEvent, WorkerStatusSummary } from "./models";

function latestEvent(events: readonly WorkerEvent[]): WorkerEvent | undefined {
  return events.reduce<WorkerEvent | undefined>((latest, event) => {
    if (latest === undefined || Date.parse(event.timestamp) >= Date.parse(latest.timestamp))
      return event;
    return latest;
  }, undefined);
}

function dataString(event: WorkerEvent, key: string): string | undefined {
  const value = event.data[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Returns the next operator action encoded by an event, when one was supplied. */
export function nextStepSummary(event: WorkerEvent | undefined): string | undefined {
  if (event === undefined) return undefined;
  const explicit = dataString(event, "nextStep");
  if (explicit !== undefined) return explicit;
  switch (event.kind) {
    case "error":
    case "credential-failure":
      return "Resolve the reported failure and retry the worker.";
    case "security":
      return "Review the security event before allowing the worker to continue.";
    case "destroy":
      return undefined;
    case "merge":
      return "Verify the merged change and update the issue.";
    case "pull-request":
    case "pr":
      return "Review the pull request and merge it when checks pass.";
    case "continue":
    case "progress":
      return "Continue worker execution.";
    default:
      return "Continue worker execution.";
  }
}

/** Reduces the latest worker fact to a concise operator-facing status. */
export function summarizeWorkerEvents(events: readonly WorkerEvent[]): WorkerStatusSummary {
  const lastEvent = latestEvent(events);
  if (lastEvent === undefined) {
    return { workerId: "", status: "idle", summary: "No worker events recorded." };
  }

  let status: WorkerStatusSummary["status"] = "running";
  if (lastEvent.kind === "error" || lastEvent.kind === "credential-failure") status = "failed";
  else if (lastEvent.kind === "security") status = "blocked";
  else if (lastEvent.kind === "destroy") status = "destroyed";
  else if (lastEvent.kind === "merge") status = "completed";

  const nextStep = nextStepSummary(lastEvent);
  return {
    workerId: lastEvent.workerId,
    ...(lastEvent.issueId === undefined ? {} : { issueId: lastEvent.issueId }),
    status,
    summary: lastEvent.message,
    ...(nextStep === undefined ? {} : { nextStep }),
    lastEvent,
  };
}

export const summarizeWorkerStatus = summarizeWorkerEvents;
export const statusSummary = summarizeWorkerEvents;
