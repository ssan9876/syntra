import type { ObjectType } from '@syntra/connectors';
import type { DirectoryObject } from './mapping.js';

export interface ExistingObject {
  id: string;
  objectType: ObjectType;
  sourceId: string | null;
  sourceAnchor: string | null;
  correlationValue: string;
  status: string;
}

export type Correlation =
  | { kind: 'matched'; object: DirectoryObject; existing: ExistingObject }
  | { kind: 'new'; object: DirectoryObject }
  | {
      kind: 'conflict';
      object: DirectoryObject;
      existing: ExistingObject;
      reason: string;
    };

const key = (value: string) => value.trim().toLowerCase();

/**
 * Resolves each mapped object to an existing row, a conflict, or new.
 *
 * The anchor is authoritative and is tried first, so an object that moved and
 * was renamed still matches itself. A correlation-value match against a row
 * this source does not own is a conflict rather than an adoption.
 */
export function correlate(
  objects: DirectoryObject[],
  existing: ExistingObject[],
  sourceId: string,
): Correlation[] {
  const byAnchor = new Map<string, ExistingObject>();
  const byValue = new Map<string, ExistingObject>();

  for (const row of existing) {
    if (row.sourceId === sourceId && row.sourceAnchor) {
      byAnchor.set(row.sourceAnchor, row);
    }
    byValue.set(`${row.objectType}:${key(row.correlationValue)}`, row);
  }

  return objects.map((object): Correlation => {
    const anchored = byAnchor.get(object.anchor);
    if (anchored) return { kind: 'matched', object, existing: anchored };

    const value = object.correlationValue;
    const candidate =
      value === undefined
        ? undefined
        : byValue.get(`${object.objectType}:${key(value)}`);

    if (!candidate) return { kind: 'new', object };

    if (candidate.sourceId === null) {
      return {
        kind: 'conflict',
        object,
        existing: candidate,
        reason:
          'matches a locally managed object; adopt it explicitly if they are the same',
      };
    }

    return {
      kind: 'conflict',
      object,
      existing: candidate,
      reason: 'matches an object owned by another source',
    };
  });
}

/**
 * Rows this source owns that were not seen in this read, and are still active.
 * Locally managed rows and rows owned by another source are never touched.
 */
export function absentAnchors(
  objects: DirectoryObject[],
  existing: ExistingObject[],
  sourceId: string,
): ExistingObject[] {
  const seen = new Set(objects.map((o) => o.anchor));
  return existing.filter(
    (row) =>
      row.sourceId === sourceId &&
      row.sourceAnchor !== null &&
      !seen.has(row.sourceAnchor) &&
      row.status === 'active',
  );
}
