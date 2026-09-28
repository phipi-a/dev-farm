import { createRequire } from "node:module";
import type { SqliteDatabase } from "./database";

interface NativeSqliteModule {
  readonly DatabaseSync: new (path: string) => SqliteDatabase;
}

/** Open the runtime's built-in SQLite implementation without a package dependency. */
export function openSqliteDatabase(path: string): SqliteDatabase {
  if (typeof path !== "string" || path.trim().length === 0 || path.includes("\u0000")) {
    throw new Error("state database path must be a non-empty string without NUL");
  }

  try {
    // node:sqlite is available in supported Node releases. createRequire keeps this
    // module type-safe on older @types/node versions used by downstream consumers.
    const require = createRequire(import.meta.url);
    const sqlite = require("node:sqlite") as NativeSqliteModule;
    return new sqlite.DatabaseSync(path);
  } catch (error) {
    throw new Error(
      "SQLite support requires a Node runtime with node:sqlite; inject a database adapter instead",
      { cause: error },
    );
  }
}
