import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ActionState, RunState, runState } from './run-states.js';

/**
 * One reading of a run's status everywhere. These pin the agreed language so
 * a page cannot quietly drift back to its own table: a failed run is blocked,
 * work in progress is running, a plan waiting on a reviewer is pending, and a
 * deliberate stop is inactive rather than red.
 */
describe('run states', () => {
  it.each([
    ['failed', 'blocked'],
    ['blocked', 'blocked'],
    ['running', 'running'],
    ['applying', 'running'],
    ['previewed', 'pending'],
    ['queued', 'pending'],
    ['partially_applied', 'attention'],
    ['applied', 'healthy'],
    ['complete', 'healthy'],
    ['cancelled', 'inactive'],
    ['superseded', 'inactive'],
  ])('reads %s as %s', (status, state) => {
    expect(runState(status)).toBe(state);
  });

  it('keeps the domain word and pairs it with the state tone', () => {
    render(<RunState status="failed" />);
    const badge = screen.getByText('Failed');
    expect(badge.className).toMatch(/danger/);
    // The glyph is the second channel; colour is never the only one.
    expect(badge.querySelector('svg')).not.toBeNull();
  });

  it('shows an unknown status as itself, and never as healthy', () => {
    render(<RunState status="half_baked" />);
    const badge = screen.getByText('Half baked');
    expect(badge.className).not.toMatch(/success/);
  });

  it('reads an action awaiting its read-back as pending, not done', () => {
    render(<ActionState status="dispatched" />);
    expect(screen.getByText('Dispatched').className).toMatch(/accent/);
  });
});
