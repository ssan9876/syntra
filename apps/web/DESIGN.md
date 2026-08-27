# Syntra — design system

## The identity was reconsidered, and kept

Amber on white stays. The case for changing it would have to be that it is
wrong for the category or wrong for the room, and neither is true: the reflex
for an identity product is Okta/Entra navy, the reflex you reach by avoiding
that one is terminal green or violet, and burnt amber on pure white is neither.
It reads administrative and human rather than SOC-console severe, which matches
who actually uses this — an IT administrator working a joiner ticket, and a
nurse tapping one tile on a shared ward PC.

What was actually weak was never the palette. It was that the system stopped at
**colour and components** and never grew a **data layer**, on a product whose
entire content is tables of accounts, columns of audit hashes and counts of
governance outcomes. That gap showed up three ways, and all three are now
closed:

1. **No table primitive.** Twenty-one pages had hand-written one. They agreed
   on the shape and disagreed on the detail — fifty cells at `py-2.5` against
   thirty-three at `py-2`, two spellings of the header row, a scroll container
   on none of them. Nobody chose that; it is what a shape copied by hand from
   whichever page was open converges to. See `Table`.
2. **No way to show a figure.** The two screens that report where an access
   review stands rendered five governance outcomes as a comma-separated
   sentence. Nobody scans a sentence. See `Metric` and `Meter`.
3. **Verified numbers that were not.** The three failures below were found by
   measuring every token pair, not by looking at the screen.

### What the measurements found

The previous version of this document claimed "every pair is contrast-verified,
not eyeballed". Three of those claims did not hold, and one was true only
against the ground it happened to be measured on:

| Claim | Measured | Verdict |
|---|---|---|
| `warning` on `warning-soft` | **4.23:1** | **Failed AA.** The "Locked out" badge and the "resolved to nobody" banner — the states that most need reading. |
| `border-subtle` as a control boundary | **1.44:1** | **Failed WCAG 1.4.11** (3:1) on every input, select and secondary button. |
| `accent` as a link | 11.2:1 on white | Passed AA and **failed 1.4.1**: at that darkness it differs from 16.3:1 body text by hue alone, and hover-only underlines left nothing else to go on. |
| "muted 5.5:1" | 5.53:1 on `bg`, **4.89:1 on `surface-2`** | Passes, but only just, on the ground it actually sits on. Now recorded per-ground. |

## Theme

Light, and single. Chosen from the room, not from habit: administrators work in
fluorescent-lit offices in the morning and employees tap a tile on a shared
ward PC in daylight. A dark console would be a developer-tool reflex applied to
an administrative surface.

**Dark mode was considered and declined.** It is not a token swap here. The
palette is warm-neutral and its whole logic — amber accent, tinted panels,
white text on every saturated fill — inverts badly; the six status tones would
each need re-deriving and re-verifying against two grounds instead of one, and
every contrast figure in this document doubles. That is a real project with a
real bill, for a product nobody uses at night. Revisit it if operators ask for
it; do not add it because it is expected.

## Colour strategy

**Restrained.** Tinted neutrals, one accent under 10% of the surface. This is
the product floor and the right floor: the data is the content, and colour is
reserved for state.

Body background is **pure white** (`oklch(1 0 0)`, literally `#ffffff`). The
warmth lives in the primary and in the faint tint of the panel neutrals, never
in the page itself. A cream body under an amber primary would be the saturated
AI default.

### Tokens

| Role | OKLCH | Hex | Use |
|---|---|---|---|
| `--color-bg` | `1 0 0` | `#ffffff` | Page |
| `--color-surface` | `0.976 0.004 60` | `#f9f6f4` | Cards, panels |
| `--color-surface-2` | `0.958 0.006 60` | `#f4f0ed` | Sidebar, toolbars, table head |
| `--color-border-subtle` | `0.88 0.007 60` | `#dbd6d3` | Row rules, dividers, panel edges |
| `--color-border-control` | `0.64 0.012 60` | `#928b85` | The edge of anything you operate |
| `--color-border-strong` | `0.6 0.012 60` | `#867f79` | Control hover |
| `--color-ink` | `0.245 0.014 55` | `#261f1a` | Body text |
| `--color-muted` | `0.52 0.014 55` | `#706761` | Secondary text |
| `--color-primary` | `0.545 0.15 48` | `#b34e00` | Primary action, selection, focus |
| `--color-primary-hover` | `0.48 0.15 48` | `#9d3a00` | Hover/active |
| `--color-primary-soft` | `0.96 0.03 55` | `#ffeddf` | Selected row, soft badge |
| `--color-accent` | `0.48 0.12 240` | `#00649a` | Links, informational state |
| `--color-success` | `0.5 0.12 150` | `#21763c` | Active status, valid chain |
| `--color-warning` | `0.51 0.13 75` | `#905800` | Locked out, partial import, attention |
| `--color-danger` | `0.49 0.19 22` | `#b3102a` | Broken chain, destructive |

**Three border tokens, not two,** and the split is a requirement rather than a
taste. WCAG 1.4.11 asks 3:1 of the boundary of a control somebody has to find
and operate. It asks nothing of a rule drawn between two table rows, which is
decoration — the row is legible without it. One token cannot serve both without
either failing the control or coarsening the table into a grid of boxes.

### Verified contrast

Measured from the OKLCH values through sRGB to WCAG relative luminance, not
eyeballed and not carried over. **Text pairs (AA needs 4.5:1):**

| Pair | Ratio |
|---|---|
| `ink` on `bg` / `surface` / `surface-2` | 16.27 / 15.17 / 14.38 |
| `muted` on `bg` / `surface` / `surface-2` | 5.53 / 5.16 / **4.89** |
| `accent` on `bg` / `surface` | 6.37 / 5.94 |
| white on `primary` / `primary-hover` | 5.26 / 6.93 |
| white on `success` / `warning` / `danger` | 5.67 / 5.86 / 6.93 |
| `primary` on `primary-soft` | 4.62 |
| `success` on `success-soft` | 5.03 |
| `warning` on `warning-soft` | 5.21 |
| `danger` on `danger-soft` | 6.03 |

**Non-text pairs (1.4.11 needs 3:1):**

| Pair | Ratio |
|---|---|
| `border-control` on `bg` / `surface` | 3.37 / 3.14 |
| `border-strong` on `bg` / `surface` | 3.96 / 3.69 |
| `border-subtle` on `bg` | 1.44 — **decorative rules only, never a control** |

White text on every saturated fill, per Helmholtz-Kohlrausch. `accent` sits
2.6:1 away from `ink`, which is what lets a link read as a link before its
underline is earned.

## Typography

One family, `system-ui` first, so an on-premises install never reaches for a
font CDN. A second stack, `--font-mono`, is **declared rather than inherited**:
fourteen places already asked for `font-mono` — audit hashes, chain sequence
numbers, distinguished names, setup links, claim JSON — and every one was
falling through to Tailwind's default. Those figures are content in this
product, so the stack that renders them is a decision. System faces only.

The scale is fixed rem. Product UI is read at consistent DPI, and a fluid
heading that shrinks inside a panel looks worse rather than better.

| Token | Size | Use |
|---|---|---|
| `--text-xs` | 0.75rem | Sidebar group labels |
| `--text-sm` | 0.8125rem | Hints, captions, table headers |
| `--text-base` | 0.875rem | Body, table cells |
| `--text-md` | 1rem | Panel titles |
| `--text-lg` | 1.25rem | Auth-card headings |
| `--text-xl` | 1.5rem | Console page titles, metric figures |
| `--text-2xl` | 1.875rem | The portal greeting |

The bottom of the scale is deliberately compressed (≈1.08 between steps) and
the top is not (1.2–1.25). A dense table needs three legible sizes inside a
quarter of a rem; a page title needs to win from across a desk. Calling the
whole thing "a 1.2 ratio", as this document used to, was tidier than it was
true.

**A panel title is `--text-md`.** It was `font-semibold` at body size, so a
panel heading and a bolded word in a sentence were typographically the same
event, and the entire hierarchy of a console page rested on weight alone.

`font-variant-numeric: tabular-nums` on every table, metric and status figure,
so columns of dates and counts align.

## Motion

150–200ms, ease-out. State only: focus, hover, row selection, panel entry, a
meter filling. No page-load choreography — the user arrives mid-task. All of it
disabled under `prefers-reduced-motion`.

## Depth

Two shadows, both nearly invisible, both warm rather than grey — a
neutral-black shadow over these grounds reads as dirt. `--shadow-raised` is for
something sitting on the page; `--shadow-overlay` for something floating above
it. Nothing else gets one: depth is a way of saying "this is temporary", and a
permanently raised panel says nothing.

## Shell

Two shapes, one header.

**The console is a workspace.** A rail anchored to the left edge of the
viewport on `--color-surface-2` — the token this system assigns to "sidebar,
toolbars, table head". Content is capped at `max-w-6xl` and LEFT-ALIGNED
against the rail; centring it opened a gap that grew with the monitor, so on a
wide screen the page looked as though it had come loose.

Navigation is grouped into the product's own modules — Directory, Access,
Connected systems, Requests, Governance, System — in the order somebody meets
them: the directory first because that is where a ticket starts, governance
last because it is periodic rather than daily. Twenty-three links in one flat
list is a list of routes, not a navigation. A group whose every item is hidden
by permission takes its heading with it.

**The portal is a page.** Centred, narrow, tile-first, with a slim row of links
above the tiles at the weight of a caption. Its reader opens it, taps the tile
for the rostering system and leaves; the navigation is there when it is wanted
and silent when it is not. The tiles carry `border-control`, not
`border-subtle`: the whole tile is the button, so its edge is a control
boundary, and at 1.44:1 they read as floating text rather than as things to
press.

## Data

### Tables

`Table` from `@syntra/ui`, always. It provides the horizontal scroll container —
without one the PAGE scrolled sideways, carrying the navigation off screen to
show one more column — and the `.data-table` class carries the row height,
header treatment and hover.

Padding lives in the component layer rather than on each cell, so there is **one
row height in the product**. Those selectors are one class deep, so a utility on
a cell still wins where a page genuinely needs it; a table read as a reference
rather than worked through row by row uses `tight`.

Every column gets a `<th>`, including the one holding the row's controls. The
users table had five headers over six cells, so a screen reader announced every
control in the last column as belonging to "Status". Where the header would be
noise on screen it is `sr-only` — the column still needs a name.

### Row controls

`RowActions`. Right-aligned, wrapping, evenly spaced, and a real element rather
than `mr-2` on each child — which leaves a trailing margin on the last control,
so the column never lines up with its own header, and makes a row with five
controls a different height from one with two.

A destructive control goes in the `destructive` slot and arrives behind a rule.
It is the one thing there nobody arrived intending to click, and a gap is not
enough to say so.

### Figures

`Metric`, `MetricRow` and `Meter`. **A number that matters is never delivered as
prose.** Two screens reported where an access review stood as "12 certified, 3
revoked, 1 require a change somewhere else, 0 moot, 4 undecided" — five
governance outcomes with nothing to tell them apart, on the screen somebody
opens specifically to find out where the review stands.

A percentage always names its own denominator, and gets a `Meter` beside it: the
bar carries the comparison down a list, the figure carries the value, and
neither replaces the sentence that says what coverage is counted from. A figure
whose definition is assumed is a figure a reader cannot use.

`quietWhenZero` for an outcome that did not happen. A campaign with no blocked
items should not have a red zero on it.

## Destructive actions

`danger` is a filled red button and belongs to the step that actually destroys
something. A destructive action offered on every row of a table uses
`danger-quiet` — the danger colour on the page background — because a column of
filled red buttons is the loudest thing on the screen for an action nobody
arrived intending to take, and after four rows it stops reading as a warning at
all.

## Containers

`Empty` and the other in-panel states carry no border of their own. A dashed box
drawn inside a panel's border is a card inside a card: two containers describing
one absence, with the padding counted twice.

## Component rules

- Every interactive element ships default, hover, focus-visible, active,
  disabled. Focus is a 2px primary ring at 2px offset, never removed.
- **Colour is never the only channel.** Links are underlined by default, not on
  hover. A status carries a word, not just a tone. A meter is always beside its
  figure.
- Loading is a skeleton shaped like the content, never a centred spinner.
- Empty states name the next action rather than saying "nothing here".
- Inactive users stay visible and labelled. Hiding a deactivation to keep a list
  tidy makes the directory unauditable.
- Errors are stated in plain language with the failing detail attached — a
  rejected CSV line, a broken audit sequence number.
- A control's boundary uses `border-control`. If you are reaching for
  `border-subtle` on something clickable, it is the wrong token.
