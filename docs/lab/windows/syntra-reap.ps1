<#
.SYNOPSIS
    Permanently deletes accounts that have sat in the archive OU past their
    retention period.

.DESCRIPTION
    The other half of Syntra's `archive_account`. Provision disables an
    account, strips the entitlements it manages, and moves the object into an
    archive OU outside the sync search base; the directory sync then reads it
    as absent and proposes deactivating the Syntra user. Nothing after that
    ever removes the object. This does.

    IT RUNS ON THE DOMAIN CONTROLLER, NOT IN SYNTRA, and that is deliberate.
    Syntra has no delete operation of any kind -- the AD connector rejects one
    before it binds -- because an unrecoverable write driven by a timer, from
    a service holding credentials for every tenant's directory, is a bad
    trade. Here the blast radius is one domain, the operator is the domain's
    own scheduler, and the AD Recycle Bin covers a mistake for the length of
    the deleted-object lifetime. Syntra decides who is finished. The domain
    decides when to forget them.

.NOTES
    DRY RUN BY DEFAULT. Deletion requires -Apply. Run it without -Apply first
    and read the log.
#>
[CmdletBinding()]
param(
    # Where archive_account moves objects. Must match the target system's
    # `archiveContainer` exactly, and must sit OUTSIDE the sync search base.
    [Parameter(Mandatory = $true)]
    [string] $ArchiveOu,

    # Days an account must sit in the archive before it may be deleted.
    [ValidateRange(1, 3650)]
    [int] $RetentionDays = 30,

    # A ceiling on one run, mirroring Provision's own guard thresholds. A
    # mistake upstream -- a bad contract import, a mis-set archiveAfterDays --
    # arrives here as a flood of newly archived accounts. The cap turns that
    # into a small loss and a loud log instead of an empty directory. Raise it
    # deliberately, never "just for this run".
    [ValidateRange(1, 1000)]
    [int] $MaxDeletesPerRun = 25,

    # Where the clock is kept. Base-schema, not an Exchange extension
    # attribute, and NOT `info` -- Syntra writes its provenance note there and
    # a run that overwrote it would destroy the marker identifying accounts it
    # created.
    [string] $StampAttribute = 'adminDescription',

    [string] $LogPath = 'C:\ProgramData\Syntra\reap.log',

    # Without this, nothing is deleted and nothing is stamped.
    [switch] $Apply
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Import-Module ActiveDirectory -ErrorAction Stop

$STAMP_PREFIX = 'syntra-reap-after='
$mode = if ($Apply) { 'APPLY' } else { 'DRY RUN' }

New-Item -ItemType Directory -Force -Path (Split-Path -Parent $LogPath) | Out-Null

function Write-Log {
    param([string] $Level, [string] $Message)
    $line = '{0} [{1}] {2}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Level, $Message
    Add-Content -Path $LogPath -Value $line -Encoding utf8
    Write-Host $line
}

# The stamp is one line among whatever else the attribute holds, so a value
# written by hand survives a run and a run survives a value written by hand.
function Get-DueDate {
    param($Existing)
    if (-not $Existing) { return $null }
    foreach ($line in ([string] $Existing -split "`n")) {
        $trimmed = $line.Trim()
        if ($trimmed.StartsWith($STAMP_PREFIX)) {
            $raw = $trimmed.Substring($STAMP_PREFIX.Length).Trim()
            $parsed = [datetime]::MinValue
            if ([datetime]::TryParseExact($raw, 'yyyy-MM-dd', [cultureinfo]::InvariantCulture,
                    [System.Globalization.DateTimeStyles]::None, [ref] $parsed)) {
                return $parsed
            }
            # A stamp that will not parse is a corrupted clock, not an absent
            # one. Returning null would re-stamp it and restart the retention
            # period silently; MaxValue holds the account forever and makes
            # somebody look.
            return [datetime]::MaxValue
        }
    }
    return $null
}

# When an account has no stamp yet, this decides the date it gets.
#
# `whenChanged` is the archive time for a freshly moved object -- modifyDN
# sets it -- so the clock starts where the account actually arrived rather
# than where this script first happened to look. But it is only an estimate:
# any later modification bumps it, so an account that has been here for months
# can read as recent.
#
# THE FLOOR IS WHAT MAKES THAT SAFE. No account is ever deleted on the run
# that first stamps it, however old `whenChanged` says it is. There is always
# one full cycle where the due date is visible in the log and in the attribute
# before anything is destroyed -- which is the difference between a wrong OU
# costing a log entry and a wrong OU costing the accounts in it.
function Resolve-FirstSightDue {
    param([datetime] $WhenChanged, [int] $RetentionDays, [datetime] $Today)
    $estimate = $WhenChanged.Date.AddDays($RetentionDays)
    $floor = $Today.AddDays(1)
    if ($estimate -lt $floor) { return $floor }
    return $estimate
}

function Set-DueDate {
    param($User, [datetime] $Due)
    $kept = @()
    $current = $User.$StampAttribute
    if ($current) {
        $kept = @(([string] $current -split "`n") |
            Where-Object { -not $_.Trim().StartsWith($STAMP_PREFIX) -and $_.Trim() -ne '' })
    }
    $value = (@($kept) + ('{0}{1}' -f $STAMP_PREFIX, $Due.ToString('yyyy-MM-dd'))) -join "`n"
    Set-ADUser -Identity $User.DistinguishedName -Replace @{ $StampAttribute = $value }
}

Write-Log 'INFO' "=== $mode | ou=$ArchiveOu retention=${RetentionDays}d cap=$MaxDeletesPerRun ==="

try {
    Get-ADOrganizationalUnit -Identity $ArchiveOu | Out-Null
} catch {
    Write-Log 'FATAL' "archive OU not found: $ArchiveOu"
    exit 2
}

$today = (Get-Date).Date
$users = @(Get-ADUser -Filter * -SearchBase $ArchiveOu -SearchScope Subtree -Properties `
        $StampAttribute, whenChanged, Enabled, ProtectedFromAccidentalDeletion)

Write-Log 'INFO' "found $($users.Count) account(s) in the archive"

$stamped = 0; $deleted = 0; $skipped = 0; $held = 0

foreach ($u in $users) {

    # AN ENABLED ACCOUNT IN THE ARCHIVE IS NOT A LEAVER. Somebody re-enabled
    # it, or moved it here by hand, or a rejoin is half-finished. Whatever it
    # is, it is a live account and this script does not delete live accounts.
    if ($u.Enabled) {
        Write-Log 'HOLD' "$($u.SamAccountName): enabled -- not a leaver, skipping"
        $held++; continue
    }

    if ($u.ProtectedFromAccidentalDeletion) {
        Write-Log 'HOLD' "$($u.SamAccountName): protected from accidental deletion, skipping"
        $held++; continue
    }

    $due = Get-DueDate -Existing $u.$StampAttribute

    if ($null -eq $due) {
        $due = Resolve-FirstSightDue -WhenChanged ([datetime] $u.whenChanged) `
            -RetentionDays $RetentionDays -Today $today

        if ($Apply) {
            Set-DueDate -User $u -Due $due
            Write-Log 'STAMP' "$($u.SamAccountName): due $($due.ToString('yyyy-MM-dd'))"
        } else {
            Write-Log 'STAMP' "$($u.SamAccountName): would stamp due $($due.ToString('yyyy-MM-dd'))"
        }
        $stamped++; continue
    }

    if ($due -gt $today) {
        $skipped++; continue
    }

    if ($deleted -ge $MaxDeletesPerRun) {
        Write-Log 'CAP' "$($u.SamAccountName): due, but the per-run cap of $MaxDeletesPerRun is reached"
        $skipped++; continue
    }

    if ($Apply) {
        # -Recursive: a user object normally has no children, but one that
        # does refuses a plain delete, and a leaver half-removed is worse than
        # one not removed at all.
        Remove-ADObject -Identity $u.DistinguishedName -Recursive -Confirm:$false
        Write-Log 'DELETE' "$($u.SamAccountName) ($($u.DistinguishedName)) -- due $($due.ToString('yyyy-MM-dd'))"
    } else {
        Write-Log 'DELETE' "would delete $($u.SamAccountName) ($($u.DistinguishedName)) -- due $($due.ToString('yyyy-MM-dd'))"
    }
    $deleted++
}

Write-Log 'INFO' "=== $mode done: stamped=$stamped deleted=$deleted held=$held waiting=$skipped ==="
exit 0
