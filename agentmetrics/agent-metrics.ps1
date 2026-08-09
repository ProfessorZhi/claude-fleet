[CmdletBinding()]
param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$ScriptArgs
)

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$srcDir = Join-Path $ScriptDir "src"

$srcDirEscaped = $srcDir.Replace('\', '\\')
$pyScript = "import sys; sys.path.insert(0, '$srcDirEscaped'); from agent_metrics.cli import main; raise SystemExit(main())"
python -c $pyScript @ScriptArgs
$exitCode = $LASTEXITCODE
exit $exitCode
