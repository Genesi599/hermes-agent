[CmdletBinding()]
param(
    [string]$ManifestPath = (Join-Path $PSScriptRoot '..\custom-features.json'),
    [string]$BeforeBase,
    [string]$BeforeHead,
    [string]$AfterBase,
    [string]$AfterHead,
    [switch]$RunTests
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$manifest = Get-Content -Raw -LiteralPath (Resolve-Path $ManifestPath) | ConvertFrom-Json

function Invoke-Git([string[]]$Arguments) {
    $output = @(& git @Arguments 2>&1)
    if ($LASTEXITCODE -ne 0) {
        throw "git $($Arguments -join ' ') failed: $($output -join ' ')"
    }
    return $output
}

function Assert-Commit([string]$Commit, [string]$Label) {
    [void](Invoke-Git @('cat-file', '-e', "$Commit^{commit}"))
    return (@(Invoke-Git @('rev-parse', "$Commit^{commit}"))[0]).ToString().Trim()
}

function Assert-Ancestor([string]$Ancestor, [string]$Descendant, [string]$Label) {
    & git merge-base --is-ancestor $Ancestor $Descendant 2>$null
    if ($LASTEXITCODE -ne 0) {
        throw "$Label is not an ancestor of the candidate HEAD: $Ancestor -> $Descendant"
    }
}

function Get-PatchId([string]$Commit) {
    $patchOutput = @(& git show --format= --binary --no-ext-diff --no-renames $Commit | & git patch-id --stable 2>&1)
    if ($LASTEXITCODE -ne 0 -or $patchOutput.Count -eq 0) {
        throw "Could not calculate patch-id for $Commit"
    }
    $patchId = (($patchOutput[0].ToString() -split '\s+')[0]).Trim()
    if ($patchId -notmatch '^[0-9a-f]{40}$') {
        throw "Invalid patch-id for ${Commit}: $patchId"
    }
    return $patchId
}

function Get-RangePatches([string]$Base, [string]$Head) {
    # Follow the deployed tree's first-parent line. Reconciliation merges keep
    # the legacy custom branch as a second parent for history, but those old
    # commits must not be reclassified as new patches in the ported stack.
    $commits = @(Invoke-Git @('rev-list', '--reverse', '--no-merges', '--first-parent', "$Base..$Head"))
    $guardPaths = @($manifest.guard_paths | ForEach-Object { $_.ToString().Replace('\\', '/') })
    $entries = @()
    foreach ($commit in $commits) {
        $commit = $commit.ToString().Trim()
        if (-not $commit) { continue }
        $changedPaths = @(Invoke-Git @('diff-tree', '--no-commit-id', '--name-only', '-r', $commit) |
            ForEach-Object { $_.ToString().Replace('\\', '/') })
        # Official histories may contain empty retrigger commits. They have no
        # patch-id and must not invalidate the custom-feature audit.
        if ($changedPaths.Count -eq 0) {
            continue
        }
        if (
            $changedPaths.Count -gt 0 -and
            @($changedPaths | Where-Object { $_ -notin $guardPaths }).Count -eq 0
        ) {
            continue
        }
        $entries += [pscustomobject]@{
            Commit = $commit
            PatchId = Get-PatchId $commit
            Subject = (@(Invoke-Git @('show', '-s', '--format=%s', $commit))[0]).ToString()
        }
    }
    return $entries
}

function Assert-FeaturePaths {
    foreach ($feature in @($manifest.features)) {
        foreach ($relativePath in @($feature.source_paths) + @($feature.test_paths)) {
            $fullPath = Join-Path $repoRoot $relativePath
            if (-not (Test-Path -LiteralPath $fullPath)) {
                throw "Feature '$($feature.id)' path is missing: $relativePath"
            }
        }
    }
}

function Assert-FeaturePatterns {
    foreach ($feature in @($manifest.features)) {
        $requiredPatterns = if ($feature.PSObject.Properties.Name -contains 'required_patterns') {
            @($feature.required_patterns)
        }
        else {
            @()
        }
        foreach ($required in $requiredPatterns) {
            $relativePath = $required.path.ToString()
            $pattern = $required.pattern.ToString()
            $fullPath = Join-Path $repoRoot $relativePath
            if (-not (Test-Path -LiteralPath $fullPath)) {
                throw "Feature '$($feature.id)' pattern path is missing: $relativePath"
            }
            $matched = Select-String -LiteralPath $fullPath -SimpleMatch -Quiet -Pattern $pattern
            if (-not $matched) {
                throw "Feature '$($feature.id)' implementation marker is missing: $relativePath -> $pattern"
            }
        }
    }
}

function Invoke-SmokeTests {
    foreach ($test in @($manifest.smoke_tests)) {
        $cwd = Join-Path $repoRoot $test.cwd
        if (-not (Test-Path -LiteralPath $cwd)) {
            throw "Smoke test '$($test.id)' cwd is missing: $($test.cwd)"
        }
        $testArgs = [string[]]@($test.args | ForEach-Object { $_.ToString() })
        Write-Host "RUN $($test.id): $($test.command) $($testArgs -join ' ')"
        Push-Location $cwd
        try {
            & $test.command @testArgs
            if ($LASTEXITCODE -ne 0) {
                throw "Smoke test '$($test.id)' failed with exit code $LASTEXITCODE"
            }
        }
        finally {
            Pop-Location
        }
    }
}

$currentHead = (@(Invoke-Git @('rev-parse', 'HEAD'))[0]).ToString().Trim()
$candidateHead = if ($AfterHead) { Assert-Commit $AfterHead 'after-update HEAD' } else { $currentHead }
$candidateBase = if ($AfterBase) { Assert-Commit $AfterBase 'after-update base' } else { Assert-Commit $manifest.baseline_commit 'manifest baseline' }

if (($BeforeBase -and -not $BeforeHead) -or ($BeforeHead -and -not $BeforeBase)) {
    throw 'BeforeBase and BeforeHead must be provided together.'
}
if (($AfterBase -and -not $BeforeBase) -or ($BeforeBase -and -not $AfterBase)) {
    throw 'Update comparison requires BeforeBase, BeforeHead, and AfterBase together.'
}

Assert-Ancestor $candidateBase $candidateHead 'candidate base'
Assert-FeaturePaths
Assert-FeaturePatterns

$expectedPatches = @($manifest.tracked_patches)
if ($expectedPatches.Count -eq 0) {
    throw 'Manifest has no tracked patches.'
}
$expectedIds = @{}
foreach ($expected in $expectedPatches) {
    if ($expected.patch_id -notmatch '^[0-9a-f]{40}$') {
        throw "Invalid manifest patch-id: $($expected.patch_id)"
    }
    if ($expectedIds.ContainsKey($expected.patch_id)) {
        throw "Duplicate manifest patch-id: $($expected.patch_id)"
    }
    $expectedIds[$expected.patch_id] = $expected
}

$candidatePatches = @(Get-RangePatches $candidateBase $candidateHead)
$candidateIds = @{}
foreach ($entry in $candidatePatches) {
    if ($candidateIds.ContainsKey($entry.PatchId)) {
        # A reconciliation merge can retain both the old custom branch and its
        # module-by-module port as parents. Identical patch-ids mean the feature
        # survived on both histories; count that patch once for preservation.
        continue
    }
    $candidateIds[$entry.PatchId] = $entry
}

$missing = @($expectedIds.Keys | Where-Object { -not $candidateIds.ContainsKey($_) })
$extra = @($candidateIds.Keys | Where-Object { -not $expectedIds.ContainsKey($_) })
if ($missing.Count -gt 0) {
    $labels = $missing | ForEach-Object { "$($expectedIds[$_].source_commit): $($expectedIds[$_].feature)" }
    throw "Custom patches missing from candidate: $($labels -join '; ')"
}
if ($extra.Count -gt 0) {
    $labels = $extra | ForEach-Object { "$($candidateIds[$_].Commit): $($candidateIds[$_].Subject)" }
    throw "Unregistered commits found above candidate base: $($labels -join '; '). Update custom-features.json first."
}

if ($BeforeBase) {
    $oldBase = Assert-Commit $BeforeBase 'before-update base'
    $oldHead = Assert-Commit $BeforeHead 'before-update HEAD'
    Assert-Ancestor $oldBase $oldHead 'before-update base'
    Assert-Ancestor $manifest.baseline_commit $oldHead 'manifest baseline'
    $rangeDiff = @(& git range-diff --no-color "$oldBase..$oldHead" "$candidateBase..$candidateHead" 2>&1)
    if ($LASTEXITCODE -ne 0) {
        throw "git range-diff failed: $($rangeDiff -join ' ')"
    }
    if ($rangeDiff -match '\[gone\]') {
        throw 'git range-diff reports a gone custom patch.'
    }
    Write-Host "PASS range-diff: $oldBase..$oldHead -> $candidateBase..$candidateHead"
}

Write-Host "PASS custom feature manifest: $($manifest.features.Count) features, $($expectedPatches.Count) patches, candidate $candidateHead"
if ($RunTests) {
    Invoke-SmokeTests
    Write-Host 'PASS smoke tests'
}
