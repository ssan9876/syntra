import { Button, Field, Select, Table } from '@syntra/ui';

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

// The shared controls, with their label kept for assistive technology and
// hidden on screen: in a table the column header already names the cell, and
// a label repeated in every row is a label nobody reads. The cells used to be
// hand-written with `border-subtle` round them, which at 1.44:1 fails 1.4.11
// as the edge of something somebody has to find and type into.
const cell = 'min-w-32 [&>label]:sr-only';

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
    <div className="space-y-5 sm:col-span-2">
      {onSeed && (
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted">
          Start from
          <Button size="sm" type="button" disabled={disabled} onClick={() => onSeed('activeDirectory')}>
            Active Directory
          </Button>
          <Button size="sm" type="button" disabled={disabled} onClick={() => onSeed('openLdap')}>
            OpenLDAP
          </Button>
        </div>
      )}
      {(['user', 'group', 'orgUnit'] as const).map((objectType) => {
        const indexed = rules
          .map((rule, index) => ({ rule, index }))
          .filter((entry) => entry.rule.objectType === objectType);

        return (
          <section key={objectType} aria-label={TYPE_LABEL[objectType]}>
            <h4 className="font-medium text-ink">{TYPE_LABEL[objectType]}</h4>
            {indexed.length === 0 ? (
              <p className="mt-2 text-sm text-muted">Not synced — nothing mapped</p>
            ) : (
              <div className="mt-3"><Table tight>
                <thead>
                  <tr>
                    <th scope="col">Directory attribute</th>
                    <th scope="col">Syntra field</th>
                    <th scope="col">Transform</th>
                    <th scope="col">Correlation key</th>
                    <th scope="col">
                      <span className="sr-only">Remove</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {indexed.map(({ rule, index }, position) => (
                    <tr key={index}>
                      <td className="align-middle">
                        <Field
                          label={`${TYPE_LABEL[objectType]} directory attribute ${position + 1}`}
                          name={`mapping-${objectType}-${position + 1}-attribute`}
                          value={rule.sourceAttribute}
                          disabled={disabled}
                          onChange={(value) => replace(index, { sourceAttribute: value })}
                          className={cell}
                        />
                      </td>
                      <td className="align-middle">
                        {/* A field the server would refuse is not offered.
                            `status`, `sourceId` and the rest are Syntra's, and
                            a mapping onto them is how directory content would
                            deactivate an account past the guard. */}
                        <Select
                          label={`${TYPE_LABEL[objectType]} Syntra field ${position + 1}`}
                          value={rule.targetField}
                          disabled={disabled}
                          onChange={(value) => replace(index, { targetField: value })}
                          options={(assignableFields?.[objectType] ?? [rule.targetField]).map(
                            (field) => ({ value: field, label: field }),
                          )}
                          className={cell}
                        />
                      </td>
                      <td className="align-middle">
                        <Select
                          label={`${TYPE_LABEL[objectType]} transform ${position + 1}`}
                          value={rule.transform}
                          disabled={disabled}
                          onChange={(value) =>
                            replace(index, { transform: value as MappingRule['transform'] })
                          }
                          options={TRANSFORMS}
                          className={cell}
                        />
                      </td>
                      <td className="align-middle">
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
                      <td className="align-middle text-right">
                        <Button
                          size="sm"
                          type="button"
                          variant="ghost"
                          disabled={disabled}
                          onClick={() => onChange(rules.filter((_, i) => i !== index))}
                          aria-label={`Remove ${TYPE_LABEL[objectType].toLowerCase()} mapping ${position + 1}`}
                        >
                          Remove
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </Table></div>
            )}

            <Button
              size="sm"
              type="button"
              disabled={disabled}
              onClick={() => add(objectType)}
              className="mt-3"
            >
              Add a {objectType === 'orgUnit' ? 'unit' : objectType} mapping
            </Button>
          </section>
        );
      })}
    </div>
  );
}
