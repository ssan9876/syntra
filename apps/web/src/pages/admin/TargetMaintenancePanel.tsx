import { useEffect, useState } from 'react';
import { Alert, Button, Check, Field, Panel, Status } from '@syntra/ui';
import { ApiError, api } from '../../session/api.js';
import type { Target } from './target-form.js';

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const timeFromMinute = (minute: number | null) => {
  const value = minute ?? 0;
  return `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
};

const minuteFromTime = (value: string) => {
  const [hour = '0', minute = '0'] = value.split(':');
  return Number(hour) * 60 + Number(minute);
};

export function TargetMaintenancePanel({ target, onChanged }: { target: Target; onChanged(): void }) {
  const [enabled, setEnabled] = useState(target.maintenanceWindowEnabled === true);
  const [days, setDays] = useState<number[]>(target.maintenanceWindowDays ?? []);
  const [start, setStart] = useState(timeFromMinute(target.maintenanceWindowStartMinute));
  const [duration, setDuration] = useState(String(target.maintenanceWindowDurationMinutes ?? 120));
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    setEnabled(target.maintenanceWindowEnabled === true);
    setDays(target.maintenanceWindowDays ?? []);
    setStart(timeFromMinute(target.maintenanceWindowStartMinute));
    setDuration(String(target.maintenanceWindowDurationMinutes ?? 120));
  }, [target]);

  const toggleDay = (day: number, checked: boolean) =>
    setDays((current) => checked ? [...current, day].sort() : current.filter((value) => value !== day));

  async function save() {
    const parsedDuration = Number(duration);
    if (enabled && days.length === 0) {
      setProblem('Select at least one UTC day.');
      return;
    }
    if (!Number.isInteger(parsedDuration) || parsedDuration < 1 || parsedDuration > 1440) {
      setProblem('Duration must be a whole number from 1 to 1,440 minutes.');
      return;
    }
    setBusy(true);
    setProblem(null);
    setNotice(null);
    try {
      await api(`/api/admin/targets/${target.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          maintenanceWindow: {
            enabled,
            days: days.length === 0 ? [0] : days,
            startMinute: minuteFromTime(start),
            durationMinutes: parsedDuration,
          },
        }),
      });
      setNotice('Maintenance window saved.');
      onChanged();
    } catch (cause) {
      setProblem(cause instanceof ApiError ? (cause.problem.detail ?? cause.problem.title) : 'The maintenance window could not be saved.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel title="Write maintenance window" actions={<Status tone={enabled ? 'warning' : 'neutral'}>{enabled ? 'Window enforced' : 'No window'}</Status>}>
      <div className="space-y-4 p-4">
        {problem && <Alert tone="danger">{problem}</Alert>}
        {notice && <Alert tone="info" aria-live="polite">{notice}</Alert>}
        <Check checked={enabled} onChange={setEnabled} label="Restrict external writes to a UTC maintenance window" />
        <fieldset disabled={!enabled || busy} className="space-y-3 disabled:opacity-60">
          <legend className="mb-2 font-medium text-ink">Allowed UTC days</legend>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            {DAYS.map((label, day) => <Check key={label} checked={days.includes(day)} onChange={(checked) => toggleDay(day, checked)} label={label} />)}
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Starts at (UTC)" type="time" value={start} onChange={setStart} />
            <Field label="Duration (minutes)" type="number" min="1" max="1440" value={duration} onChange={setDuration} />
          </div>
        </fieldset>
        <Button variant="primary" onClick={save} loading={busy} disabled={busy}>Save maintenance window</Button>
      </div>
    </Panel>
  );
}
