# Syntra — product context

## What it is

Open-source Identity and Access Management. One place to hold an
organization's people, decide what they may reach, and give them a single
front door to every application they use. Self-hosted, multi-tenant,
Apache-2.0.

## Register

product — design serves the task. This is authenticated tooling, not a
marketing surface. The interface should disappear into the work.

## Platform

web

## Who uses it, where

**The administrator.** IT staff at a 400-person hospital, school district, or
mid-size firm. Fluorescent-lit office, 8:40am, working a queue of
joiner/mover/leaver tickets before the day's escalations start. Three other
tabs open. Needs to find a person, see which accounts they hold, and act —
without ceremony. Often on older or shared hardware.

**The employee.** A nurse on a shared ward PC, or a teacher between lessons.
Opens the portal, taps the tile for the rostering system, gets in. Sees it
for four seconds a day and should never have to think about it.

Both are in bright rooms in the daytime. Light theme is the default because
the room is lit, not because light is safe.

## What matters

- **Density without noise.** Administrators read tables of people all day.
  Compact rows, tabular figures, no decoration competing with data.
- **State legibility.** Active vs inactive, primary vs secondary contract,
  granted vs denied. A person's status must be readable at a glance and never
  hidden to keep a list tidy.
- **Nothing silently dropped.** A partial CSV import, a rejected row, a broken
  audit chain: the interface reports it prominently. An identity system that
  quietly loses a person is worse than one that refuses the file.
- **Speed over choreography.** Users are mid-task. No page-load sequences.

## What it is not

Not a security operations console. Not a developer tool. The people using it
are often HR-adjacent rather than engineers, and the tone should be plain and
administrative rather than technical or playful.
