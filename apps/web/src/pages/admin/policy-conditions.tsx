import { useMemo } from 'react';

/**
 * The two "where from" conditions, as controls rather than as text fields.
 *
 * A comma-separated box holding `ios,android` is a box that has to be
 * explained, and a control that needs explaining has already failed. Both of
 * these are closed sets, so both are pickers: the device kinds are six
 * buttons, and countries are chosen by name from a list and shown as chips.
 */

export const DEVICE_OPTIONS = [
  { value: 'windows', label: 'Windows' },
  { value: 'macos', label: 'Mac' },
  { value: 'linux', label: 'Linux' },
  { value: 'ios', label: 'iPhone & iPad' },
  { value: 'android', label: 'Android' },
  // Named for what it is from the reader's side. "Other" would leave somebody
  // guessing whether a device with no user agent lands here; it does not —
  // that request is unevaluable, and this covers only agents that were sent
  // and not recognised.
  { value: 'other', label: 'Anything else' },
] as const;

export function DevicePicker({
  value,
  onChange,
}: {
  value: string[];
  onChange(next: string[]): void;
}) {
  const toggle = (v: string) =>
    onChange(value.includes(v) ? value.filter((x) => x !== v) : [...value, v]);

  return (
    <fieldset>
      <legend className="mb-1.5 font-medium text-ink">Devices</legend>
      <div className="flex flex-wrap gap-2">
        {DEVICE_OPTIONS.map((option) => {
          const on = value.includes(option.value);
          return (
            <button
              key={option.value}
              type="button"
              aria-pressed={on}
              onClick={() => toggle(option.value)}
              className={`h-9 rounded-control border px-3 text-sm ${
                on
                  ? 'border-primary bg-primary text-on-primary'
                  : 'border-border-control bg-bg text-ink'
              }`}
            >
              {option.label}
            </button>
          );
        })}
      </div>
      {/*
        Not a hint explaining the control — the buttons say what they do. This
        is the state of the control, in the same place the reader is looking,
        and it is the difference between a rule that matches everybody and one
        that matches nobody.
      */}
      <p className="mt-1.5 text-sm text-muted">
        {value.length === 0 ? 'Any device' : `${value.length} of 6 selected`}
      </p>
    </fieldset>
  );
}

/**
 * ISO 3166-1 alpha-2, as a code list rather than a name list.
 *
 * The NAMES come from `Intl.DisplayNames`, so they arrive in the reader's own
 * language and stay current without this file being edited every time a
 * country renames itself. Only the codes are pinned here, because those are
 * what a rule stores and what a proxy sends.
 */
const COUNTRY_CODES =
  'AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW'.split(
    ' ',
  );

export function countryName(code: string): string {
  try {
    const names = new Intl.DisplayNames(undefined, { type: 'region' });
    return names.of(code) ?? code;
  } catch {
    // An environment without region display names. The code alone is still a
    // true label, and a rule the reader cannot name is better than a page
    // that will not render.
    return code;
  }
}

export function CountryPicker({
  value,
  onChange,
}: {
  value: string[];
  onChange(next: string[]): void;
}) {
  const options = useMemo(
    () =>
      COUNTRY_CODES.map((code) => ({ code, name: countryName(code) })).sort((a, b) =>
        a.name.localeCompare(b.name),
      ),
    [],
  );

  return (
    <div>
      <label htmlFor="policy-country" className="mb-1.5 block font-medium text-ink">
        Countries
      </label>
      <select
        id="policy-country"
        value=""
        onChange={(e) => {
          const code = e.target.value;
          if (code && !value.includes(code)) onChange([...value, code]);
        }}
        className="h-9 w-full rounded-control border border-border-control bg-bg px-3 text-ink"
      >
        <option value="">Any country</option>
        {options.map((option) => (
          <option key={option.code} value={option.code}>
            {option.name}
          </option>
        ))}
      </select>
      {value.length > 0 && (
        <ul className="mt-2 flex flex-wrap gap-2">
          {value.map((code) => (
            <li key={code}>
              <button
                type="button"
                onClick={() => onChange(value.filter((c) => c !== code))}
                className="h-8 rounded-control border border-border-control px-2.5 text-sm text-ink"
                aria-label={`Remove ${countryName(code)}`}
              >
                {countryName(code)} ×
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
