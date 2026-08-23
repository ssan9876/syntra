# Syntra — design system

## Theme

Light. Chosen from the room, not from habit: administrators work in
fluorescent-lit offices in the morning and employees tap a tile on a shared
ward PC in daylight. A dark console would be a developer-tool reflex applied
to an administrative surface.

## Color strategy

**Restrained.** Tinted neutrals, one accent under 10% of the surface. This is
the product floor and the right floor: the data is the content, and colour is
reserved for state.

### Why amber

The category reflex for identity products is Okta/Entra navy. The
second-order reflex — the one you land on by avoiding the first — is a dark
terminal green or a violet. Burnt amber on pure white is neither, and it
reads administrative and human rather than SOC-console severe, which matches
who actually uses this.

Body background is **pure white** (`oklch(1 0 0)`, literally `#ffffff`). The
warmth lives in the primary and in the faint tint of the panel neutrals, never
in the page itself. A cream body under an amber primary would be the
saturated AI default.

### Tokens

| Role | OKLCH | Hex | Use |
|---|---|---|---|
| `--bg` | `1 0 0` | `#ffffff` | Page |
| `--surface` | `0.976 0.004 60` | `#f9f6f4` | Cards, panels |
| `--surface-2` | `0.958 0.006 60` | `#f4f0ed` | Sidebar, toolbars, table head |
| `--border` | `0.880 0.007 60` | `#dcd8d4` | Rules, dividers, inputs |
| `--ink` | `0.245 0.014 55` | `#261f1a` | Body text |
| `--muted` | `0.520 0.014 55` | `#706761` | Secondary text |
| `--primary` | `0.545 0.150 48` | `#b34e00` | Primary action, selection, focus |
| `--primary-hover` | `0.480 0.150 48` | `#9d3a00` | Hover/active |
| `--primary-soft` | `0.960 0.030 55` | `#ffeddf` | Selected row, soft badge |
| `--accent` | `0.340 0.085 225` | deep slate-teal | Links, informational state |
| `--success` | `0.500 0.120 150` | `#21763c` | Active status, valid chain |
| `--warning` | `0.560 0.130 75` | `#a06700` | Partial import, attention |
| `--danger` | `0.490 0.190 22` | `#b3102a` | Broken chain, destructive |

Every pair is contrast-verified, not eyeballed: body 16.3:1, muted 5.5:1,
white-on-primary 5.3:1, primary-vs-accent 2.1:1. White text on every
saturated fill, per Helmholtz-Kohlrausch.

## Typography

One family, `system-ui` first so an on-premises install never reaches for a
font CDN. Fixed rem scale at a 1.2 ratio — product UI is viewed at consistent
DPI, and a fluid heading that shrinks inside a panel looks worse, not better.

`font-variant-numeric: tabular-nums` on every table cell and status figure, so
columns of dates and counts align.

## Motion

150–200ms, ease-out. State only: focus, hover, row selection, panel entry.
No page-load choreography — the user arrives mid-task. All of it disabled
under `prefers-reduced-motion`.

## Shell

Two shapes, one header.

**The console is a workspace.** A rail anchored to the left edge of the
viewport on `--surface-2` — the token this system already assigned to
"sidebar, toolbars, table head", and which the tables had always used while
the sidebar sat on the page background with nothing separating it from the
content. Content is capped at `max-w-6xl` and LEFT-ALIGNED against the rail;
centring it opened a gap that grew with the monitor, so on a wide screen the
page looked as though it had come loose.

Navigation is grouped into the product's own modules — Directory, Access,
Connected systems, Requests, Governance, System — in the order somebody meets
them: the directory first because that is where a ticket starts, governance
last because it is periodic rather than daily. Twenty-three links in one flat
list is a list of routes, not a navigation. A group whose every item is hidden
by permission takes its heading with it.

**The portal is a page.** Centred, narrow, tile-first, with a slim row of
links above the tiles at the weight of a caption. Its reader opens it, taps
the tile for the rostering system and leaves; the navigation is there when it
is wanted and silent when it is not. It exists because the catalog, requests,
access, approvals, managed resources and reviews were reachable only by typing
the URL.

## Destructive actions

`danger` is a filled red button and belongs to the step that actually
destroys something. A destructive action offered on every row of a table uses
`danger-quiet` — the danger colour on the page background — because a column
of filled red buttons is the loudest thing on the screen for an action nobody
arrived intending to take, and after four rows it stops reading as a warning
at all.

## Containers

`Empty` and the other in-panel states carry no border of their own. A dashed
box drawn inside a panel's border is a card inside a card: two containers
describing one absence, with the padding counted twice.

## Component rules

- Every interactive element ships default, hover, focus-visible, active,
  disabled. Focus is a 2px primary ring at 2px offset, never removed.
- Loading is a skeleton shaped like the content, never a centred spinner.
- Empty states name the next action rather than saying "nothing here".
- Inactive users stay visible and labelled. Hiding a deactivation to keep a
  list tidy makes the directory unauditable.
- Errors are stated in plain language with the failing detail attached — a
  rejected CSV line, a broken audit sequence number.
