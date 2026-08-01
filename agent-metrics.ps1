[CmdletBinding()]
param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$ScriptArgs
)

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$srcDir = Join-Path $ScriptDir "src"

$pyScript = "import sys; sys.path.insert(0, r'$srcDir'); from agent_metrics.cli import main; main()"
python -c $pyScript @ScriptArgs
$exitCode = $LASTEXITCODE
exit $exitCode
