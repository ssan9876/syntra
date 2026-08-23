<#
.SYNOPSIS
    One-time setup for the archive OU and the retention sweep.

.DESCRIPTION
    Creates the archive OU outside the sync search base, turns on the AD
    Recycle Bin, installs syntra-reap.ps1, and registers it as a daily
    scheduled task in DRY RUN mode.

    It installs the sweep switched off on purpose. The task writes a log from
    day one so the due dates are visible and wrong ones are obvious, and
    nothing is destroyed until somebody reads that log and re-runs this with
    -Apply. A retention sweep is the last place to find out you had the OU
    wrong.

.EXAMPLE
    .\install-reap.ps1 -Domain example.local
    # ... read C:\ProgramData\Syntra\reap.log for a few days, then:
    .\install-reap.ps1 -Domain example.local -Apply
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string] $Domain,

    # A SIBLING OF THE SYNC SEARCH BASE, NEVER A CHILD OF IT. The whole chain
    # depends on this: Provision moves the object here, the object leaves the
    # sync's search base, the next run reads it as absent and proposes
    # deactivating the Syntra user. Put this inside OU=Company and the sync
    # keeps seeing the account, keeps it active, and the archive achieves
    # nothing.
    [string] $ArchiveOuName = 'Deactivated',

    [ValidateRange(1, 3650)]
    [int] $RetentionDays = 30,

    [ValidateRange(1, 1000)]
    [int] $MaxDeletesPerRun = 25,

    [string] $InstallDir = 'C:\ProgramData\Syntra',

    [string] $TaskName = 'Syntra archive retention sweep',

    [string] $RunAt = '03:20',

    # Switch the installed task from dry run to real deletion.
    [switch] $Apply
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Import-Module ActiveDirectory -ErrorAction Stop

$domainDn = (Get-ADDomain -Identity $Domain).DistinguishedName
$archiveOu = "OU=$ArchiveOuName,$domainDn"

Write-Host "domain     : $domainDn"
Write-Host "archive OU : $archiveOu"

# --- the archive OU ------------------------------------------------------

$existing = Get-ADOrganizationalUnit -Filter "Name -eq '$ArchiveOuName'" -SearchBase $domainDn `
    -SearchScope OneLevel -ErrorAction SilentlyContinue
if ($existing) {
    Write-Host "OU exists, leaving it alone"
} else {
    # ProtectedFromAccidentalDeletion on the CONTAINER, not on the accounts in
    # it. The sweep refuses to delete a protected object, so protecting the
    # accounts would disable the very thing being installed -- but an OU
    # deleted by a slipped click takes every leaver's record with it.
    New-ADOrganizationalUnit -Name $ArchiveOuName -Path $domainDn `
        -ProtectedFromAccidentalDeletion $true
    Write-Host "OU created"
}

# --- the recycle bin -----------------------------------------------------

# This is what makes deletion an acceptable risk rather than an irreversible
# one, and it is why the sweep lives on the DC instead of in Syntra. It cannot
# be turned off again once enabled, and it needs a 2008 R2 forest functional
# level or better.
$rb = Get-ADOptionalFeature -Filter "Name -like 'Recycle Bin Feature'"
if ($rb.EnabledScopes.Count -gt 0) {
    Write-Host "Recycle Bin already enabled"
} else {
    $forest = (Get-ADForest).RootDomain
    Enable-ADOptionalFeature -Identity $rb -Scope ForestOrConfigurationSet `
        -Target $forest -Confirm:$false
    Write-Host "Recycle Bin enabled (irreversible, as designed)"
}

# --- the script ----------------------------------------------------------

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
$source = Join-Path $PSScriptRoot 'syntra-reap.ps1'
$target = Join-Path $InstallDir 'syntra-reap.ps1'
Copy-Item -Path $source -Destination $target -Force
Write-Host "installed  : $target"

# --- the scheduled task --------------------------------------------------

# Not `$args`: that is an automatic variable, and assigning to it works right
# up until something in scope reads the real one.
$taskArgs = @(
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', "`"$target`"",
    '-ArchiveOu', "`"$archiveOu`"",
    '-RetentionDays', $RetentionDays,
    '-MaxDeletesPerRun', $MaxDeletesPerRun,
    '-LogPath', "`"$(Join-Path $InstallDir 'reap.log')`""
)
if ($Apply) { $taskArgs += '-Apply' }

$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ($taskArgs -join ' ')
$trigger = New-ScheduledTaskTrigger -Daily -At $RunAt
# SYSTEM on a DC is a member of the domain's own administrators and needs no
# stored password -- which is the point. A retention sweep that deletes
# accounts should not be gated on a credential in a file that expires.
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable `
    -DontStopOnIdleEnd -ExecutionTimeLimit (New-TimeSpan -Hours 1)

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
    -Principal $principal -Settings $settings -Force | Out-Null

$mode = if ($Apply) { 'APPLY -- it will delete' } else { 'DRY RUN -- it will not delete' }
Write-Host ""
Write-Host "task       : $TaskName, daily at $RunAt"
Write-Host "mode       : $mode"
Write-Host "retention  : $RetentionDays days, at most $MaxDeletesPerRun deletions per run"
Write-Host "log        : $(Join-Path $InstallDir 'reap.log')"
Write-Host ""
Write-Host "Set the target system's archiveContainer to exactly:"
Write-Host "  $archiveOu"
