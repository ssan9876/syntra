# Run your first access review

An access review asks reviewers, usually managers, to keep or remove each
access a person holds. Syntra then removes what it can and lists the rest as
changes for you to make. Every decision is recorded.

**You need:** a console role with the Governance permissions, people with a manager
recorded, and at least one connected target or application with holdings.

## 1. Take a snapshot

A review is based on a snapshot of who holds what.

1. **Governance → Snapshots → Build snapshot**.
2. Wait for its status to read `complete`. Check **Holdings** is not 0.

## 2. Scope the review

1. **Governance → Access reviews → New campaign**.
2. Under **What it covers**:
    - **Name**: `Q4 AD groups`.
    - **Resource kinds**: tick what to review. For a first run, one kind is
      enough, for example `targetEntitlement` (groups and roles on targets).
    - **Privileged holdings only**: tick to keep it small.
    - **Point in time**: **Latest complete snapshot**.
3. **Preview scope**. Check **Holdings**, **Persons** and **Systems**.

## 3. Choose reviewers

1. **Reviewer**: `manager`.
2. **Fallback**: who reviews when there is no manager, for example `resourceOwner`.
3. **Preview reviewers**. **No reviewer** should be 0. If not, record the
   missing managers or owners, or pick another fallback.

## 4. Set the dates and create it

1. **Owner person id**: your own person id (the last part of your person
   page's address).
2. **Opens** and **Due**.
3. Leave **Allow bulk certify** off for a first review.
4. **Create review**. The campaign is a draft until you start it.

## 5. Start it

On the campaign's page, under **Actions**, **Start review**. It reports how
many items it generated and how many have no reviewer.

## 6. Reviewers decide

Each reviewer opens **Reviews** in the portal. For each item:

- **Keep**, or
- **Remove**, which asks for a reason.

**Group by person** and **Group by resource** change the order.

## 7. Follow progress

The campaign's **Progress** shows **Certified**, **Revoked**,
**Sent for remediation**, **Access already gone** and **Undecided**. Use
**Extend due date** if reviewers need longer. If the snapshot ages out before
removals run, **Re-base onto** a newer snapshot.

## 8. Remove what reviewers rejected

1. **Compute revocations**, then **Open batch**.
2. Read **Removals**. Until you dispatch, no access has been removed.
3. **Confirm and dispatch**. The batch shows what was **Dispatched**, what
   **Need a change elsewhere**, and what **Failed**.

Access granted by a business rule, a role, a directory source or a direct
assignment would come back on the next run, so the batch does not remove it.
It lists it under **Need a change elsewhere**, naming what to change.
Decisions and removals are kept in the audit log.
