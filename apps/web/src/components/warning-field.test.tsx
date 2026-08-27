import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Check, Field } from '@syntra/ui';

/**
 * What replaced `hint`.
 *
 * `hint` was permanent help text: a sentence under every control, shown to
 * everybody, forever, whether or not it applied. Eighty-nine of them meant a
 * form was mostly prose about itself. `warning` is the same information
 * demoted to what it always was — a STATE. It appears when the condition it
 * describes is true and is silent otherwise, so a reader learns that text
 * under a control means something is up.
 *
 * The accessibility half matters as much as the visual one. `hint` was wired
 * to `aria-describedby`; dropping it without a replacement would have taken
 * real information away from screen-reader users in the name of removing
 * prose, which is not the trade that was asked for.
 */

describe('Field warning', () => {
  it('says nothing when there is nothing to say', () => {
    const { container } = render(<Field label="Name" value="" onChange={() => {}} />);
    expect(container.querySelector('p')).toBeNull();
  });

  it('shows the consequence when the condition holds', () => {
    render(
      <Field label="External id" value="E1" onChange={() => {}} warning="Changing this creates a second person on the next import." />,
    );
    expect(screen.getByText(/creates a second person/)).toBeInTheDocument();
  });

  it('describes the control to a screen reader', () => {
    render(<Field label="External id" value="E1" onChange={() => {}} warning="Careful." />);
    const input = screen.getByLabelText('External id');
    const described = input.getAttribute('aria-describedby');
    expect(described).toBeTruthy();
    expect(document.getElementById(described!)).toHaveTextContent('Careful.');
  });

  it('lets a real error take precedence over a warning', () => {
    // An error is about what the reader just did; a warning is about what
    // will happen next. Showing both makes the reader work out which one
    // blocks them.
    render(
      <Field label="External id" value="" onChange={() => {}} warning="Careful." error="Required." />,
    );
    expect(screen.getByText('Required.')).toBeInTheDocument();
    expect(screen.queryByText('Careful.')).not.toBeInTheDocument();
  });

  it('reads as a warning rather than as a caption', () => {
    // `text-muted` is what `hint` used it, and it is why hints were ignored:
    // quieter than the label they sat under. A warning earns the warning tone.
    render(<Field label="X" value="" onChange={() => {}} warning="Careful." />);
    expect(screen.getByText('Careful.').className).toMatch(/text-warning/);
  });
});

describe('Check warning', () => {
  it('is silent by default', () => {
    const { container } = render(<Check checked={false} onChange={() => {}} label="Auto-apply" />);
    expect(container.textContent).toBe('Auto-apply');
  });

  it('shows what will override the control when it actually will', () => {
    // The auto-apply case: the box says runs apply automatically, and a guard
    // upstream can refuse regardless. That was a permanent sentence under the
    // box; it is now shown only while the guard is actually holding.
    render(
      <Check checked onChange={() => {}} label="Apply scheduled runs automatically" warning="Blocked by the population guard — this will not run." />,
    );
    expect(screen.getByText(/will not run/).className).toMatch(/text-warning/);
  });

  it('ties the warning to the checkbox for a screen reader', () => {
    render(<Check checked onChange={() => {}} label="Auto-apply" warning="Held." />);
    const box = screen.getByRole('checkbox');
    const described = box.getAttribute('aria-describedby');
    expect(described).toBeTruthy();
    expect(document.getElementById(described!)).toHaveTextContent('Held.');
  });
});
