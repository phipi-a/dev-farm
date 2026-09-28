/** Event categories emitted while a worker executes an issue. */
export const EVENT_KINDS = {
  Progress: "progress",
  Error: "error",
  Security: "security",
  Git: "git",
  PullRequest: "pull-request",
  PR: "pr",
  Linear: "linear",
  Docker: "docker",
  Merge: "merge",
  Destroy: "destroy",
  Continue: "continue",
  CredentialFailure: "credential-failure",
} as const;

/** Compatibility aliases make the category set convenient at call sites. */
export const WorkerEventKind = EVENT_KINDS;
export const EventKind = EVENT_KINDS;
export type WorkerEventKind = (typeof EVENT_KINDS)[keyof typeof EVENT_KINDS];

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };
export type EventData = Readonly<Record<string, unknown>>;

export interface ProgressEventData extends EventData {
  readonly phase?: string;
  readonly percent?: number;
  readonly nextStep?: string;
}
export interface ErrorEventData extends EventData {
  readonly code?: string;
  readonly retryable?: boolean;
  readonly nextStep?: string;
}
export interface SecurityEventData extends EventData {
  readonly control?: string;
  readonly decision?: "allowed" | "blocked";
  readonly nextStep?: string;
}
export interface ProviderEventData extends EventData {
  readonly operation?: string;
  readonly providerId?: string;
  readonly nextStep?: string;
}
export interface LifecycleEventData extends EventData {
  readonly reason?: string;
  readonly nextStep?: string;
}

export type EventDataForKind<K extends WorkerEventKind> = K extends "progress"
  ? ProgressEventData
  : K extends "error"
    ? ErrorEventData
    : K extends "security"
      ? SecurityEventData
      : K extends "git" | "pull-request" | "pr" | "linear" | "docker"
        ? ProviderEventData
        : LifecycleEventData;

export interface WorkerEventInput {
  readonly workerId: string;
  readonly issueId?: string;
  readonly kind: WorkerEventKind;
  readonly message: string;
  readonly data?: EventData;
  readonly timestamp?: string | Date;
  readonly id?: string;
}

/** A redacted, append-only fact emitted by a worker. */
export interface WorkerEvent {
  readonly id: string;
  readonly timestamp: string;
  readonly workerId: string;
  readonly issueId?: string;
  readonly kind: WorkerEventKind;
  readonly message: string;
  readonly data: EventData;
}

/** Discriminated view for consumers that handle one event category at a time. */
export type TypedWorkerEvent<K extends WorkerEventKind> = Omit<WorkerEvent, "kind" | "data"> & {
  readonly kind: K;
  readonly data: EventDataForKind<K>;
};

export type EventOutcome = "started" | "succeeded" | "failed" | "observed";

/** Stable audit projection of a worker event for external audit consumers. */
export interface AuditRecord {
  readonly id: string;
  readonly eventId: string;
  readonly timestamp: string;
  readonly workerId: string;
  readonly issueId?: string;
  readonly kind: WorkerEventKind;
  readonly action: string;
  readonly outcome: EventOutcome;
  readonly details: EventData;
}

export type WorkerAuditRecord = AuditRecord;

export interface EventFilter {
  readonly workerId?: string;
  readonly issueId?: string;
  readonly kinds?: readonly WorkerEventKind[];
  readonly since?: string | Date;
  readonly until?: string | Date;
  readonly limit?: number;
}

export interface EventClock {
  now(): Date;
}

export interface EventPersistence {
  append(event: WorkerEvent): void;
  query(filter?: EventFilter): readonly WorkerEvent[];
}

export interface EventSink {
  /** Sinks must receive an already-redacted event. */
  write?(event: WorkerEvent): void;
  append?(event: WorkerEvent): void;
  emit?(event: WorkerEvent): void;
  publish?(event: WorkerEvent): void;
}

export type EventListener = (event: WorkerEvent) => void;
export type Unsubscribe = () => void;

export interface EventRecorderOptions {
  readonly persistence?: EventPersistence;
  readonly sink?: EventSink;
  readonly clock?: EventClock;
  readonly idFactory?: () => string;
  /** Explicit values are also redacted when found inside otherwise safe strings. */
  readonly secrets?: readonly string[];
}

export interface WorkerStatusSummary {
  readonly workerId: string;
  readonly issueId?: string;
  readonly status: "idle" | "running" | "blocked" | "failed" | "completed" | "destroyed";
  readonly summary: string;
  readonly nextStep?: string;
  readonly lastEvent?: WorkerEvent;
}

export interface LiveEventQueryPort {
  readonly filter: EventFilter;
  subscribe(listener: EventListener): Unsubscribe;
  snapshot(): readonly WorkerEvent[];
}
