import { Panel } from '@syntra/ui';

export type ObjectType = 'user' | 'group' | 'orgUnit';

export interface MappingRule {
  objectType: ObjectType;
  sourceAttribute: string;
  targetField: string;
  transform: 'none' | 'trim' | 'lowercase';
  isCorrelation: boolean;
}

export type AssignableFields = Record<ObjectType, string[]>;

const TYPE_LABEL: Record<ObjectType, string> = {
  user: 'Users',
  group: 'Groups',
  orgUnit: 'Organizational units',
};

const TRANSFORMS: { value: MappingRule['transform']; label: string }[] = [
  { value: 'none', label: 'As it comes' },
  { value: 'trim', label: 'Trim spaces' },
  { value: 'lowercase', label: 'Lowercase' },
];

const control =
  'h-8 w-full rounded-control border border-border-subtle bg-bg px-2 text-ink ' +
  'transition-colors duration-150 hover:border-border-strong ' +
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary';

/**
 * The rule the server enforces, stated where the choice is made.
 *
 * `setMappings` refuses a rule set without exactly one user correlation key,
 * and before this the only way to learn that was a 400 after saving. Rendering
 * the correlation column as a radio group per object type makes "exactly one"
 * a property of the control rather than a rule to discover: picking a second
 * one releases the first.
 */
export function MappingEditor({
  rules,
  onChange,
  assignableFields,
  onSeed,
  disabled = false,
}: {
  rules: MappingRule[];
  onChange(rules: MappingRule[]): void;
  assignableFields: AssignableFields | null;
  onSeed?(flavour: 'activeDirectory' | 'openLdap'): void;
  disabled?: boolean;
}) {
  const replace = (index: number, patch: Partial<MappingRule>) =>
    onChange(rules.map((rule, i) => (i === index ? { ...rule, ...patch } : rule)));

  const setCorrelation = (index: number) => {
    const objectType = rules[index]!.objectType;
    onChange(
      rules.map((rule, i) =>
        rule.objectType === objectType
          ? { ...rule, isCorrelation: i === index }
          : rule,
      ),
    );
  };

  const add = (objectType: ObjectType) =>
    onChange([
      ...rules,
      {
        objectType,
        sourceAttribute: '',
        targetField: assignableFields?.[objectType][0] ?? '',
        transform: 'trim',
        // Never by default: the first mapping of a type is the correlation
        // key only because nothing else is, and that is decided below.
        isCorrelation: !rules.some(
          (rule) => rule.objectType === objectType && rule.isCorrelation,
        ),
      },
    ]);

  return (
    <Panel
      title="Attribute mappings"
      description="Which directory attribute becomes which field in Syntra. A mapped field is owned by the source and rewritten on every run."
      actions={
        onSeed && (
          <span className="flex items-center gap-2 text-sm text-muted">
            Start from
            <button
              type="button"
              disabled={disabled}
              onClick={() => onSeed('activeDirectory')}
              className="rounded-control border border-border-subtle px-2 py-1 font-medium text-ink transition-colors hover:bg-surface-2 disabled:opacity-55"
            >
              Active Directory
            </button>
            <button
              type="button"
              disabled={disabled}
              onClick={() => onSeed('openLdap')}
              className="rounded-control border border-border-subtle px-2 py-1 font-medium text-ink transition-colors hover:bg-surface-2 disabled:opacity-55"
            >
              OpenLDAP
            </button>
          </span>
        )
      }
      bodyClassName="divide-y divide-border-subtle"
    >
      {(['user', 'group', 'orgUnit'] as const).map((objectType) => {
        const indexed = rules
          .map((rule, index) => ({ rule, index }))
          .filter((entry) => entry.rule.objectType === objectType);

        return (
          <section key={objectType} className="px-4 py-4">
            <h3 className="font-medium text-ink">{TYPE_LABEL[objectType]}</h3>
            {objectType === 'user' && (
              <p className="mt-1 text-sm text-muted">
                Exactly one user mapping is the correlation key: the attribute a
                directory record is matched against an existing account by, when
                its anchor is not already known.
              </p>
            )}

            {indexed.length === 0 ? (
              <p className="mt-2 text-sm text-muted">
                Nothing mapped, so nothing of this kind is synced.
              </p>
            ) : (
              <table className="mt-3 w-full text-left">
                <thead>
                  <tr className="text-sm text-muted">
                    <th scope="col" className="pb-1.5 pr-3 font-medium">
                      Directory attribute
                    </th>
                    <th scope="col" className="pb-1.5 pr-3 font-medium">
                      Syntra field
                    </th>
                    <th scope="col" className="pb-1.5 pr-3 font-medium">
                      Transform
                    </th>
                    <th scope="col" className="pb-1.5 pr-3 font-medium">
                      Correlation key
                    </th>
                    <th scope="col" className="pb-1.5">
                      <span className="sr-only">Remove</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {indexed.map(({ rule, index }) => (
                    <tr key={index}>
                      <td className="py-1 pr-3 align-middle">
                        <input
                          aria-label={`${TYPE_LABEL[objectType]} directory attribute ${
                            indexed.findIndex((e) => e.index === index) + 1
                          }`}
                          value={rule.sourceAttribute}
                          disabled={disabled}
                          onChange={(e) =>
                            replace(index, { sourceAttribute: e.target.value })
                          }
                          className={control}
                        />
                      </td>
                      <td className="py-1 pr-3 align-middle">
                        <select
                          aria-label={`${TYPE_LABEL[objectType]} Syntra field ${
                            indexed.findIndex((e) => e.index === index) + 1
                          }`}
                          value={rule.targetField}
                          disabled={disabled}
                          onChange={(e) =>
                            replace(index, { targetField: e.target.value })
                          }
                          className={control}
                        >
                          {/* A field the server would refuse is not offered.
                              `status`, `sourceId` and the rest are Syntra's,
                              and a mapping onto them is how directory content
                              would deactivate an account past the guard. */}
                          {(assignableFields?.[objectType] ?? [rule.targetField]).map(
                            (field) => (
                              <option key={field} value={field}>
                                {field}
                              </option>
                            ),
                          )}
                        </select>
                      </td>
                      <td className="py-1 pr-3 align-middle">
                        <select
                          aria-label={`${TYPE_LABEL[objectType]} transform ${
                            indexed.findIndex((e) => e.index === index) + 1
                          }`}
                          value={rule.transform}
                          disabled={disabled}
                          onChange={(e) =>
                            replace(index, {
                              transform: e.target
                                .value as MappingRule['transform'],
                            })
                          }
                          className={control}
                        >
                          {TRANSFORMS.map((t) => (
                            <option key={t.value} value={t.value}>
                              {t.label}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="py-1 pr-3 align-middle">
                        <input
                          type="radio"
                          name={`correlation-${objectType}`}
                          checked={rule.isCorrelation}
                          disabled={disabled}
                          onChange={() => setCorrelation(index)}
                          aria-label={`Correlate ${objectType} records on ${
                            rule.sourceAttribute || 'this attribute'
                          }`}
                          className="size-4 accent-primary"
                        />
                      </td>
                      <td className="py-1 align-middle text-right">
                        <button
                          type="button"
                          disabled={disabled}
                          onClick={() =>
                            onChange(rules.filter((_, i) => i !== index))
                          }
                          className="rounded-control px-2 py-1 text-sm text-muted transition-colors hover:bg-surface-2 hover:text-danger disabled:opacity-55"
                        >
                          Remove
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            <button
              type="button"
              disabled={disabled}
              onClick={() => add(objectType)}
              className="mt-3 rounded-control border border-border-subtle px-2.5 py-1 text-sm font-medium text-ink transition-colors hover:bg-surface-2 disabled:opacity-55"
            >
              Add a {objectType === 'orgUnit' ? 'unit' : objectType} mapping
            </button>
          </section>
        );
      })}
    </Panel>
  );
}
