-- Must the user choose a new password before they get a session?
--
-- Set by an administrator setting a password on somebody's behalf, and cleared
-- by any password the user chooses themselves. Independent of
-- `passwordMaxAgeDays`, which is off by default and should usually stay off: a
-- policy that has switched scheduled expiry off must not switch off a change
-- somebody demanded this morning.
ALTER TABLE "PasswordCredential"
  ADD COLUMN "mustChange" BOOLEAN NOT NULL DEFAULT false;
