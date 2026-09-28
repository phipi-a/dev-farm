import { randomUUID } from "node:crypto";
import { redactEvent, redactSecrets } from "./redaction";
import type {
  AuditRecord,
  EventClock,
  EventFilter,
  EventListener,
  EventPersistence,
  EventRecorderOptions,
  EventSink,
  LiveEventQueryPort as LiveEventQueryContract,
  Unsubscribe,
  WorkerEvent,
  WorkerEventInput,
} from "./models";

const SYSTEM_CLOCK: EventClock = { now: () => new Date() };

function asTimestamp(value: string | Date): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function matches(event: WorkerEvent, filter: EventFilter): boolean {
  const timestamp = Date.parse(event.timestamp);
  const since = filter.since === undefined ? undefined : Date.parse(asTimestamp(filter.since));
  const until = filter.until === undefined ? undefined : Date.parse(asTimestamp(filter.until));
  return (
    (filter.workerId === undefined || event.workerId === filter.workerId) &&
    (filter.issueId === undefined || event.issueId === filter.issueId) &&
    (filter.kinds === undefined || filter.kinds.includes(event.kind)) &&
    (since === undefined || timestamp >= since) &&
    (until === undefined || timestamp <= until)
  );
}

/** In-memory bounded persistence suitable for a process-local event log or a fake. */
export class BoundedEventStore implements EventPersistence {
  private readonly events: WorkerEvent[] = [];
  private readonly listeners = new Set<{ filter: EventFilter; listener: EventListener }>();

  public constructor(public readonly maxEvents = 1_000) {
    if (!Number.isInteger(maxEvents) || maxEvents < 1)
      throw new RangeError("maxEvents must be a positive integer");
  }

  public append(event: WorkerEvent): void {
    const safeEvent = redactEvent(event);
    this.events.push(safeEvent);
    while (this.events.length > this.maxEvents) this.events.shift();
    for (const subscription of [...this.listeners]) {
      if (matches(safeEvent, subscription.filter)) subscription.listener(safeEvent);
    }
  }

  public query(filter: EventFilter = {}): readonly WorkerEvent[] {
    const selected = this.events.filter((event) => matches(event, filter));
    const limit = filter.limit;
    return (
      limit === undefined
        ? selected
        : selected.slice(Math.max(0, selected.length - Math.max(0, limit)))
    ).map((event) => ({
      ...event,
      data: redactSecrets(event.data),
    }));
  }

  public tail(limit = 50, filter: Omit<EventFilter, "limit"> = {}): readonly WorkerEvent[] {
    return this.query({ ...filter, limit });
  }

  public subscribe(filter: EventFilter, listener: EventListener): Unsubscribe {
    const subscription = { filter, listener };
    this.listeners.add(subscription);
    return () => this.listeners.delete(subscription);
  }

  public live(filter: EventFilter = {}): LiveEventQueryContract {
    return new LiveEventQuery(this, filter);
  }

  public clear(): void {
    this.events.length = 0;
  }
}

/** Named alias for callers that prefer the terminology used by retention policies. */
export class EventLog extends BoundedEventStore {}
export class InMemoryEventStore extends BoundedEventStore {}

export class LiveEventQuery implements LiveEventQueryContract {
  public constructor(
    private readonly store: BoundedEventStore,
    public readonly filter: EventFilter,
  ) {}

  public subscribe(listener: EventListener): Unsubscribe {
    return this.store.subscribe(this.filter, listener);
  }

  public snapshot(): readonly WorkerEvent[] {
    return this.store.query(this.filter);
  }
}

export class EventRecorder {
  private readonly persistence: EventPersistence;
  private readonly sink?: EventSink;
  private readonly clock: EventClock;
  private readonly idFactory: () => string;
  private readonly secrets: readonly string[];

  public constructor(options: EventRecorderOptions = {}) {
    this.persistence = options.persistence ?? new BoundedEventStore();
    this.sink = options.sink;
    this.clock = options.clock ?? SYSTEM_CLOCK;
    this.idFactory = options.idFactory ?? randomUUID;
    this.secrets = options.secrets ?? [];
  }

  public record(input: WorkerEventInput): WorkerEvent {
    const event: WorkerEvent = redactEvent(
      {
        id: input.id ?? this.idFactory(),
        timestamp: asTimestamp(input.timestamp ?? this.clock.now()),
        workerId: input.workerId,
        ...(input.issueId === undefined ? {} : { issueId: input.issueId }),
        kind: input.kind,
        message: input.message,
        data: input.data ?? {},
      },
      { secrets: this.secrets },
    );
    this.persistence.append(event);
    this.writeToSink(event);
    return event;
  }

  public append(input: WorkerEventInput): WorkerEvent {
    return this.record(input);
  }

  private writeToSink(event: WorkerEvent): void {
    if (this.sink?.write !== undefined) this.sink.write(event);
    else if (this.sink?.append !== undefined) this.sink.append(event);
    else if (this.sink?.emit !== undefined) this.sink.emit(event);
    else this.sink?.publish?.(event);
  }

  public query(filter: EventFilter = {}): readonly WorkerEvent[] {
    return this.persistence.query(filter);
  }
}

export interface AuditRecordOptions {
  readonly action?: string;
  readonly outcome?: AuditRecord["outcome"];
}

export function toAuditRecord(event: WorkerEvent, options: AuditRecordOptions = {}): AuditRecord {
  return {
    id: randomUUID(),
    eventId: event.id,
    timestamp: event.timestamp,
    workerId: event.workerId,
    ...(event.issueId === undefined ? {} : { issueId: event.issueId }),
    kind: event.kind,
    action: options.action ?? event.kind,
    outcome:
      options.outcome ??
      (event.kind === "error" || event.kind === "credential-failure" ? "failed" : "observed"),
    details: redactSecrets({ message: event.message, ...event.data }),
  };
}

/** Small deterministic sink fake for unit and contract tests. */
export class FakeEventSink implements EventSink {
  public readonly events: WorkerEvent[] = [];

  public write(event: WorkerEvent): void {
    this.events.push(event);
  }

  public append(event: WorkerEvent): void {
    this.write(event);
  }

  public emit(event: WorkerEvent): void {
    this.write(event);
  }

  public publish(event: WorkerEvent): void {
    this.write(event);
  }
}

/** Mutable clock fake keeps recorder timestamps deterministic in tests. */
export class FakeClock implements EventClock {
  public constructor(private current: Date = new Date(0)) {}

  public now(): Date {
    return new Date(this.current);
  }

  public set(value: Date | string): void {
    this.current = new Date(value);
  }

  public advance(milliseconds: number): void {
    this.current = new Date(this.current.getTime() + milliseconds);
  }
}
