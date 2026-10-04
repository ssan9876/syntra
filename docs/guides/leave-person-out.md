# Leave one person out of a target

Business rules only add: any enabled rule that matches gives the person an
account. To keep one named person out of one target, for example an
application's own bootstrap administrator, leave them out of that target.

**You need:** `provision.manage`.

## From the target

1. **Target systems →** the target.
2. In **Left out**, **Add**.
3. **Person**: pick them. **Why**: one line, for example
   `Bootstrap administrator of this application`.
4. **Leave out**.

## From the person

1. **Users → People →** the person, then **Explain access** under **Access**.
2. On that target's account, **Leave out of** *target name*.
3. **Why**, then **Leave out**.

The account now shows **Left out**, with who, when and why.

## What changes on the next run

- No account is created for them on that target, whatever the rules say.
- An account they already have is left exactly as it is: no update, disable,
  rename, group change or password sync. It is not deleted.
- A run applied afterwards skips their actions with
  `Not attempted: <name> is left out of this target.`
- Their Syntra sign-in still follows their employment.
- Safety thresholds are unchanged.

## Undo it

On the target, **Remove** next to the person, with a reason. Or on
**Access explained**, **Include again**. The rules apply to them again on the
next run, with the usual preview.

Each change is in **Activity** as `provision.target.exclusion.add` or
`provision.target.exclusion.remove`. Full behaviour:
[Leaving one person out of a target](../configure.md#leaving-one-person-out-of-a-target).
