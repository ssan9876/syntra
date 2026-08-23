-- A tenant reachable by more than one name.
--
-- `primaryDomain` is unique and is the WebAuthn relying party, so there can
-- only ever be one of it. That made the product answer on exactly one hostname
-- plus the slug fallback, which is not enough for an ordinary deployment: an
-- instance is reached by IP while it is being set up, and by a DNS name once
-- somebody points one at it, and both have to work during the change.
--
-- Not unique, and deliberately. A UNIQUE constraint on an array column
-- constrains the whole array rather than its elements, so it would forbid two
-- tenants having the same LIST while happily allowing them to share a single
-- name — the opposite of the wanted rule. Overlap is checked in the service,
-- where the message can say which tenant already answers on that name.
ALTER TABLE "Tenant"
  ADD COLUMN "additionalDomains" TEXT[] NOT NULL DEFAULT '{}';
