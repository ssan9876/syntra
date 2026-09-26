import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Alert,
  Button,
  Empty,
  Panel,
  SkeletonRows,
  StateBadge,
  Status,
  Table,
  Textarea,
  useToast,
} from '@syntra/ui';
import { ApiError, api } from '../../session/api.js';

export interface DuplicateReview {
  id: string;
  changeId: string;
  matchedValue: string;
  change: { id: string; externalId: string | null; after: Record<string, unknown>; status: string };
  candidatePerson: { id: string; givenName: string; familyName: string; businessEmail: string | null; externalId: string | null };
  run: { id: string; sourceId: string; startedAt: string };
  affectedChanges: { id: string; changeType: string; recordType: string; status: string }[];
}

const text = (value: unknown) => typeof value === 'string' ? value : '—';

export function DuplicateReviewsTab({ reviews, loading, error, reload }: {
  reviews: DuplicateReview[];
  loading: boolean;
  error: string | null;
  reload(): void;
}) {
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const toast = useToast();
  const groups = [...new Map(reviews.map((review) => [review.changeId, reviews.filter((item) => item.changeId === review.changeId)])).values()];

  async function resolve(review: DuplicateReview, resolution: 'keep_separate' | 'link_existing' | 'skip_source_record') {
    const note = (notes[review.changeId] ?? '').trim();
    if (note.length < 10) {
      setProblem('Record at least 10 characters explaining the decision.');
      return;
    }
    setBusy(review.changeId);
    setProblem(null);
    try {
      await api(`/api/admin/person-duplicate-reviews/${review.id}/resolve`, {
        method: 'POST',
        body: JSON.stringify({ resolution, note }),
      });
      toast({
        title:
          resolution === 'link_existing'
            ? 'Linked to the existing person'
            : resolution === 'keep_separate'
              ? 'Kept as separate people'
              : 'Incoming HR record skipped',
      });
      reload();
    } catch (cause) {
      setProblem(cause instanceof ApiError ? (cause.problem.detail ?? cause.problem.title) : 'The review could not be resolved.');
    } finally {
      setBusy(null);
    }
  }

  if (error) return <Alert tone="danger">{error}</Alert>;
  if (!loading && groups.length === 0) return <Panel><div className="p-6"><Empty title="No duplicate reviews waiting" /></div></Panel>;

  return (
    <div className="space-y-4">
      {problem && <Alert tone="danger" aria-live="assertive">{problem}</Alert>}
      {loading && groups.length === 0 && <Panel><SkeletonRows rows={3} cols={4} /></Panel>}
      {groups.map((matches) => {
        const review = matches[0]!;
        const incoming = review.change.after;
        return (
          <Panel key={review.changeId} title={`${text(incoming.givenName)} ${text(incoming.familyName)}`} actions={<StateBadge state="blocked">Review required</StateBadge>}>
            <div className="space-y-4 p-4">
              <Table tight>
                <thead><tr><th scope="col">Record</th><th scope="col">Name</th><th scope="col">Business email</th><th scope="col">Identifier</th><th scope="col"><span className="sr-only">Link decision</span></th></tr></thead>
                <tbody>
                  <tr><th scope="row">Incoming HR record</th><td>{text(incoming.givenName)} {text(incoming.familyName)}</td><td>{text(incoming.businessEmail)}</td><td>{review.change.externalId ?? '—'}</td><td /></tr>
                  {matches.map((match) => <tr key={match.id}><th scope="row"><Link className="link" to={`/admin/people/${match.candidatePerson.id}`}>Existing person</Link></th><td>{match.candidatePerson.givenName} {match.candidatePerson.familyName}</td><td>{match.candidatePerson.businessEmail ?? '—'}</td><td>{match.candidatePerson.externalId ?? '—'}</td><td><Button size="sm" onClick={() => resolve(match, 'link_existing')} disabled={busy !== null}>Link to this person</Button></td></tr>)}
                </tbody>
              </Table>
              <div>
                <h3 className="mb-2 font-medium text-ink">Affected import changes</h3>
                <ul className="flex flex-wrap gap-2">
                  {review.affectedChanges.map((change) => <li key={change.id}><Status tone="neutral">{change.changeType}</Status></li>)}
                </ul>
              </div>
              <Textarea label="Decision note" rows={2} value={notes[review.changeId] ?? ''} onChange={(value) => setNotes((current) => ({ ...current, [review.changeId]: value }))} maxLength={1000} />
              <div className="flex flex-wrap gap-2">
                <Button variant="primary" onClick={() => resolve(review, 'keep_separate')} loading={busy === review.changeId} disabled={busy !== null}>Keep as separate people</Button>
                <Button onClick={() => resolve(review, 'skip_source_record')} disabled={busy !== null}>Skip incoming HR record</Button>
              </div>
            </div>
          </Panel>
        );
      })}
    </div>
  );
}
