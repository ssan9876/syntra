# Syntra

Instructions for Claude Code sessions in this repository.

## Writing messages

Rules for any text a person reads in the console, an API error, an incident,
a run's error or a log line. Code comments are not covered.

### Say three things, in this order

1. **What happened**, as a plain statement.
2. **Where**: the target, run, person, source or field it happened to, by name.
3. **What to do**, only if there is a clear next step.

One or two short sentences. Stop there.

| Instead of | Write |
|---|---|
| A scheduled run does not start while a run is awaiting review, so that the plan somebody was asked to approve is not superseded every night. Review the outstanding run and this clears on the next schedule. | Skipped: run from 15:57 is waiting for review. Apply or cancel it. |
| Somebody was meant to be told something and was not. | Email to anna@contoso.com was not delivered. |
| Nothing was applied by these runs. Accounts are as they were. | 2 runs failed. No changes were made. |
| The person register may be out of date. | Sync from "HR feed" failed. |
| Whatever depends on it fails at its next use. | Credential "Entra client secret" expired on 2 Oct. |

### Do

- Name the object: `Target "ssander.xyz entra"`, `run 0e514d5c`, `Jane Doe`.
- Use the field name the person typed into: `Business email`, not `businessEmail`,
  in the console; the JSON path in API `errors[].path`.
- Use numbers and dates, not "some" or "recently".
- Use the button's own label in the instruction: "Apply or cancel it."
- Keep titles to a few words: `Email domain not verified`, `Run skipped`.

### Don't

- Explain why the system is designed the way it is. That belongs in docs.
- Say "somebody", "a person", "this is the system working", "on purpose",
  "deliberately", "so that", "rather than".
- Hedge ("may", "might", "could possibly") when the fact is known.
- Repeat the title in the detail.
- Write paragraphs in help text, empty states or confirmations. An empty
  table says `No domains yet`, not why there are none.

### Log lines

`<what> failed|skipped|...: <cause>` with the ids in the structured fields
(`tenantId`, `targetSystemId`, `runId`, `jobId`, `personId`), so any line can be
found by grepping for an id.
