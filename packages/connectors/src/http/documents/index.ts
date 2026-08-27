import type { HttpConnectorDocument } from '../document.js';
import { entraIdDocument } from './entra-id.js';
import { googleWorkspaceDocument } from './google-workspace.js';

/**
 * Documents that ship with the product, as starting points.
 *
 * Deliberately a STARTING POINT and not a fixed integration. An administrator
 * picks one, and it is copied into the target's own configuration and edited
 * there — see `httpTargetConfigSchema`, which embeds the document rather than
 * referencing it. A shared document would change behaviour for every target
 * using it the moment somebody edited it for one of them, including between a
 * preview and the apply that was supposed to enact that preview.
 *
 * Two, not twenty. Each of these is a claim that the product talks to that
 * system correctly, and a claim nobody tests against the real API is a claim
 * that will be wrong within a release.
 */
export const BUILTIN_CONNECTOR_DOCUMENTS: Record<string, HttpConnectorDocument> = {
  'entra-id': entraIdDocument,
  'google-workspace': googleWorkspaceDocument,
};

export { entraIdDocument, googleWorkspaceDocument };
