/** Minimal synchronous SQLite seam used by the state store. */
export interface SqliteStatement {
  run(...parameters: readonly unknown[]): { readonly changes?: number; readonly lastInsertRowid?: number | bigint };
  get<T extends Record<string, unknown> = Record<string, unknown>>(
    ...parameters: readonly unknown[]
  ): T | undefined;
  all<T extends Record<string, unknown> = Record<string, unknown>>(
    ...parameters: readonly unknown[]
  ): T[];
}

export interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close?(): void;
}

export interface StateDatabaseOptions {
  /** SQLite filename. Use ":memory:" for an ephemeral store. */
  readonly path?: string;
  /** Injected connection, primarily useful for tests and host adapters. */
  readonly database?: SqliteDatabase;
}
