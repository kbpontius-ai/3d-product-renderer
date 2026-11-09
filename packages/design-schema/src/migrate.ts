import { CURRENT_SCHEMA_VERSION, DesignDocument } from './design.js';

export class SchemaMigrationError extends Error {
  constructor(public readonly fromVersion: unknown) {
    super(`no migration path from design schema version ${String(fromVersion)}`);
    this.name = 'SchemaMigrationError';
  }
}

/**
 * Migrations run on READ; stored documents are never rewritten in place, so the inputs of an
 * approved render stay byte-stable. A migration must be pure, total, and must not change how a
 * document renders — a change in appearance is a new design version made by a user, not a migration.
 */
export const migrations: Record<number, (doc: Record<string, unknown>) => Record<string, unknown>> =
  {
    // 1 -> 2 will land here, e.g.:
    // 1: (d) => ({ ...d, schemaVersion: 2, placements: (d.placements as []).map(addNewField) }),
  };

export function migrateDesign(raw: unknown): DesignDocument {
  if (typeof raw !== 'object' || raw === null) throw new SchemaMigrationError(raw);
  let doc = raw as Record<string, unknown>;
  let version = doc['schemaVersion'];

  while (typeof version === 'number' && version < CURRENT_SCHEMA_VERSION) {
    const step = migrations[version];
    if (!step) throw new SchemaMigrationError(version);
    doc = step(doc);
    if (doc['schemaVersion'] === version) throw new SchemaMigrationError(version); // guard: no progress
    version = doc['schemaVersion'];
  }

  return DesignDocument.parse(doc); // fail loudly rather than render something wrong
}
