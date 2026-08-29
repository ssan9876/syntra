import { useState } from 'react';
import { Alert, Button, Field } from '@syntra/ui';
import { useApiResource } from './hooks.js';
import { parseDocument } from './target-form.js';

/**
 * Configuring a REST API target.
 *
 * The shape of this form is the whole design decision. A connector document
 * is a hundred lines of JSON, and a screen that opened with an empty textarea
 * and a link to the documentation would be a screen that needs a manual to
 * use — which means it is the wrong screen. So the first control is a PICKER:
 * an administrator connecting Entra ID chooses Entra ID, and the document is
 * filled in for them, already correct.
 *
 * The textarea is still there, below, because a declarative connector whose
 * documents cannot be edited is a fixed integration wearing a general-purpose
 * name. It is just not the thing you meet first.
 */
export function HttpConnectorFields({
  isNew,
  documentKey,
  documentJson,
  credential,
  onPick,
  onDocumentChange,
  onCredentialChange,
}: {
  isNew: boolean;
  documentKey: string;
  documentJson: string;
  credential: string;
  onPick(key: string, document: Record<string, unknown>): void;
  onDocumentChange(value: string): void;
  onCredentialChange(value: string): void;
}) {
  const { data } = useApiResource<{
    documents: { key: string; name: string; document: Record<string, unknown> }[];
  }>('/api/admin/targets/connector-documents');
  const [showJson, setShowJson] = useState(false);

  const documents = data?.documents ?? [];
  const parsed = parseDocument(documentJson);
  const unreadable = documentJson.trim() !== '' && parsed === null;

  return (
    <div className="sm:col-span-2 space-y-4">
      <div>
        <span className="font-medium text-ink">System</span>
        <div className="mt-2 flex flex-wrap gap-2">
          {documents.map((entry) => (
            <Button
              key={entry.key}
              type="button"
              variant={documentKey === entry.key ? 'primary' : 'secondary'}
              onClick={() => onPick(entry.key, entry.document)}
            >
              {entry.name}
            </Button>
          ))}
        </div>
      </div>

      <Field
        label="Client secret"
        type="password"
        autoComplete="new-password"
        value={credential}
        onChange={onCredentialChange}
      />

      <div>
        <Button type="button" variant="ghost" onClick={() => setShowJson(!showJson)}>
          {showJson ? 'Hide the connector document' : 'Edit the connector document'}
        </Button>
        {showJson && (
          <>
            <textarea
              aria-label="Connector document"
              value={documentJson}
              onChange={(event) => onDocumentChange(event.target.value)}
              spellCheck={false}
              rows={20}
              className="mt-2 w-full rounded-control border border-border-control bg-bg p-3 font-mono text-sm text-ink"
            />
            {unreadable && <Alert tone="danger">That is not valid JSON.</Alert>}
          </>
        )}
      </div>
    </div>
  );
}
