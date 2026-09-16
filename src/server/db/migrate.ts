import { DatabaseSync } from 'node:sqlite';
import { createTableStatements, type Schema } from 'repolayer';

export interface ColumnAddition {
  table: string;
  schema: Schema;
  /** SQL default for NOT NULL columns, which SQLite requires when adding one to existing rows. */
  defaults?: Record<string, string>;
}

/**
 * Adds columns that newer schemas declare but an existing database lacks. repolayer's
 * ensureTable() never alters a table and there is no migration tool here, so this covers
 * the one change this app makes over time: new columns. The column definition comes from
 * repolayer's own DDL, so verifyTable() agrees with the result.
 */
export function addMissingColumns(file: string, additions: ColumnAddition[]): string[] {
  const db = new DatabaseSync(file);
  const added: string[] = [];
  try {
    for (const { table, schema, defaults = {} } of additions) {
      const existing = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
      if (existing.length === 0) continue; // ensureTable() creates it with every column.
      const present = new Set(existing.map((column) => column.name));
      const ddl = createTableStatements(schema, table, 'sqlite')[0] ?? '';
      const clauses = ddl
        .split('\n')
        .slice(1, -1)
        .map((line) => line.trim().replace(/,$/, ''));

      for (const clause of clauses) {
        const column = clause.split(/\s+/)[0];
        if (!column || present.has(column)) continue;
        let definition = clause;
        if (/NOT NULL/i.test(clause)) {
          const fallback = defaults[column];
          if (fallback === undefined) throw new Error(`Column ${table}.${column} is NOT NULL and needs a default to be added`);
          definition = `${clause} DEFAULT ${fallback}`;
        }
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
        added.push(`${table}.${column}`);
      }
    }
  } finally {
    db.close();
  }
  return added;
}
