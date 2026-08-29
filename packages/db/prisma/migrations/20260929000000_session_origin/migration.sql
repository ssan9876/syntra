-- Where a session came from, so a person can recognise one they did not start.
--
-- Both nullable: sessions that predate this migration have neither, and a
-- backfill would have to invent values. Null renders as "unknown", which is
-- the truth. Neither column is ever read to make a decision -- a session is
-- not refused for having moved -- so nothing downstream has to cope with the
-- nulls being wrong, only with them being absent.
ALTER TABLE "Session" ADD COLUMN "ip" TEXT;
ALTER TABLE "Session" ADD COLUMN "userAgent" TEXT;

-- The inventory query is "live sessions for this user".
CREATE INDEX "Session_userId_revokedAt_idx" ON "Session"("userId", "revokedAt");
