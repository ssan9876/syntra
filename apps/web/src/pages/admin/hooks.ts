import { ApiError } from '../../session/api.js';

export { useApiResource, type Resource } from '../../session/use-api-resource.js';

/**
 * The field-level messages out of an RFC 9457 problem document.
 *
 * A rejected cron expression, a TLS mode that contradicts the URL scheme and
 * a missing search base all come back as `errors[]` with a path, and every one
 * of them belongs against the control that produced it. A form-wide banner
 * saying "invalid configuration" leaves the reader hunting for which of
 * fourteen fields is wrong.
 *
 * Only the last path segment is kept: the API validates the connection
 * settings as an object of their own, so the same problem arrives as `url`
 * from one endpoint and `config.url` from another, and the editor is one flat
 * form either way.
 */
export function fieldErrors(cause: unknown): Record<string, string> {
  if (!(cause instanceof ApiError)) return {};
  const errors: Record<string, string> = {};
  for (const issue of cause.problem.errors ?? []) {
    const field = issue.path?.split('.').pop();
    if (field && !errors[field]) errors[field] = issue.message;
  }
  return errors;
}
