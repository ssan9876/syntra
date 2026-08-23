<#
    The clock, tested without a directory.

    `Get-DueDate` and the first-sight floor decide whether an account is
    destroyed, and both are pure date arithmetic over one string attribute --
    so they are testable on any machine, and the parts that are not (the LDAP
    reads, the delete) are the parts a lab run exercises anyway.

    The functions are lifted out of syntra-reap.ps1 by parsing it, rather than
    copied here, so a test cannot pass against a version of the logic that is
    no longer shipped.

    Run:  powershell -NoProfile -File .\syntra-reap.Tests.ps1
#>
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:StampAttribute = 'adminDescription'
$STAMP_PREFIX = 'syntra-reap-after='

$source = Join-Path $PSScriptRoot 'syntra-reap.ps1'
$ast = [System.Management.Automation.Language.Parser]::ParseFile($source, [ref] $null, [ref] $null)
foreach ($wanted in @('Get-DueDate', 'Resolve-FirstSightDue')) {
    $fn = $ast.FindAll({ param($n)
            $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $wanted
        }, $true)
    if ($fn.Count -ne 1) { throw "expected one $wanted in $source, found $($fn.Count)" }
    . ([scriptblock]::Create($fn[0].Extent.Text))
}

$today = (Get-Date).Date
$failures = 0

function Check {
    param([string] $Name, $Expected, $Actual)
    $ok = if ($null -eq $Expected -and $null -eq $Actual) { $true }
          elseif ($null -eq $Expected -or $null -eq $Actual) { $false }
          else { $Expected -eq $Actual }
    if ($ok) {
        Write-Host "  pass  $Name"
    } else {
        Write-Host "  FAIL  $Name -- expected '$Expected', got '$Actual'"
        $script:failures++
    }
}

Write-Host "Get-DueDate"
Check 'no attribute at all'        $null (Get-DueDate -Existing $null)
Check 'empty attribute'            $null (Get-DueDate -Existing '')
Check 'unrelated content only'     $null (Get-DueDate -Existing "left in 2019`nsee ticket 4471")

Check 'a stamp on its own' `
    ([datetime] '2026-09-22') (Get-DueDate -Existing 'syntra-reap-after=2026-09-22')

Check 'a stamp among other notes' `
    ([datetime] '2026-09-22') (Get-DueDate -Existing "created by Syntra`nsyntra-reap-after=2026-09-22`nsee ticket 4471")

Check 'leading and trailing space' `
    ([datetime] '2026-09-22') (Get-DueDate -Existing "  syntra-reap-after= 2026-09-22  ")

# A corrupted clock must never read as an absent one: re-stamping would
# restart the retention period every run and the account would live forever
# without anybody noticing it was supposed to die.
Check 'unparseable stamp is held, not reset' `
    ([datetime]::MaxValue) (Get-DueDate -Existing 'syntra-reap-after=not-a-date')
Check 'empty stamp is held, not reset' `
    ([datetime]::MaxValue) (Get-DueDate -Existing 'syntra-reap-after=')
Check 'US-format stamp is held, not reset' `
    ([datetime]::MaxValue) (Get-DueDate -Existing 'syntra-reap-after=09/22/2026')

Write-Host "first sight"
Check 'freshly archived gets the full retention period' `
    ($today.AddDays(30)) (Resolve-FirstSightDue -WhenChanged $today -RetentionDays 30 -Today $today)

Check 'archived 10 days ago gets the remaining 20' `
    ($today.AddDays(20)) (Resolve-FirstSightDue -WhenChanged $today.AddDays(-10) -RetentionDays 30 -Today $today)

# The floor. An account whose whenChanged is long past would otherwise be
# stamped with a due date already behind us and deleted on the same run that
# first noticed it -- no log entry anybody could have read in time, no chance
# to spot a wrong OU before it emptied.
Check 'archived 90 days ago still gets one cycle' `
    ($today.AddDays(1)) (Resolve-FirstSightDue -WhenChanged $today.AddDays(-90) -RetentionDays 30 -Today $today)

Check 'archived exactly at the boundary still gets one cycle' `
    ($today.AddDays(1)) (Resolve-FirstSightDue -WhenChanged $today.AddDays(-30) -RetentionDays 30 -Today $today)

Check 'a future whenChanged does not shorten anything' `
    ($today.AddDays(35)) (Resolve-FirstSightDue -WhenChanged $today.AddDays(5) -RetentionDays 30 -Today $today)

Write-Host ""
if ($failures -gt 0) { Write-Host "$failures failure(s)"; exit 1 }
Write-Host "all pass"
exit 0
