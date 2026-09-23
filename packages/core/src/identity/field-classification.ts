export const PERSON_FIELD_CLASSIFICATION = {
  givenName: 'internal',
  familyName: 'internal',
  businessEmail: 'internal',
  externalId: 'confidential',
  personalEmail: 'sensitive',
} as const;

export type PersonFieldClassification =
  (typeof PERSON_FIELD_CLASSIFICATION)[keyof typeof PERSON_FIELD_CLASSIFICATION];

/**
 * Omits sensitive fields rather than replacing them with null: null means the
 * HR record has no value, while omission means this caller is not authorized
 * to learn whether a value exists.
 */
export function projectPersonFields<T extends Record<string, unknown>>(
  person: T,
  canReadSensitive: boolean,
): T | Omit<T, 'personalEmail'> {
  if (canReadSensitive) return person;
  const { personalEmail: _personalEmail, ...visible } = person;
  return visible;
}
