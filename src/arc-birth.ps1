# arc-birth.ps1 — the ONE shape a peer is launched in. Shipped and STATIC on purpose: the structure
# of a birth does not change, only its values, so nothing here is generated at spawn time. A launcher
# that writes a fresh script per spawn is codegen-then-exec — unreviewable, and it fails in a new way
# every time. This file is reviewed once and fed values.
#
# WHY IT EXISTS AT ALL. The launch chain is:
#     node -> spawnSync -> powershell.exe -Command -> wt -> this shell
# FIVE parsers, each re-quoting what the last one handed it. The birth prompt is prose — spaces,
# commas, colons — and NO quoting form survives all five. Two attempts to launch pwsh with the prompt
# on the command line failed, and neither was the shell's fault:
#   `-Command <bare>`      -> the outer powershell stripped the quotes; claude got the word "Take".
#   `-Command <PS-quoted>` -> NO TAB AT ALL, while staffRole still printed its success tick.
# So the prompt is NOT an argument. It is written to a file and read here. Everything that does cross
# the wire is a safe token — an account id, a role name, a UUID, a path — none of which can be
# mangled by a parser it meets on the way.

param(
  [Parameter(Mandatory = $true)][string] $Role,
  [Parameter(Mandatory = $true)][string] $PromptFile,
  [string] $Account,
  [string] $Mode,
  [string] $Resume,
  [switch] $Fork
)

$ErrorActionPreference = 'Stop'

# THIS WINDOW IS NOT ALWAYS A wt TAB, and that decides whether arc is readable in it. A quiet spawn
# (Start-Process, minimised) lands in a legacy conhost console whose output code page defaults to
# the machine's OEM one — 437, 936, whatever the box was installed as — not UTF-8. A Windows
# Terminal tab gets UTF-8 for free; a raw console does not, and nothing in the chain sets it.
#
# arc's output is UTF-8 and LEANS on it: the roster is ● live / ◑ revivable / ○ closed, unread is
# 📌, an empty chair is ⚠, and every hint has a →. Without this line they arrive as mojibake in
# exactly the window a human opens in order to read them — and ◑ vs ○ is not decoration, it is the
# difference between "revive this peer, it remembers everything" and "this chair is empty".
#
# Set on the CONSOLE (SetConsoleOutputCP under the hood), so it applies to the whole window — not
# just PowerShell's own writes, but node's and claude's too, since they share this console.
try {
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
  $OutputEncoding = [System.Text.Encoding]::UTF8
} catch { }   # a redirected/headless console can refuse; never let cosmetics kill a peer's birth

# FAIL LOUDLY, IN THE TAB. A peer that boots with no instruction is the worst failure this launcher
# has: it claims the role, so nothing else may staff it, and then answers nothing — a chair that is
# occupied and deaf. Better an obvious red line in a window than a silent impostor on the board.
if (-not (Test-Path -LiteralPath $PromptFile)) {
  Write-Host ''
  Write-Host "arc: the birth prompt file is missing:" -ForegroundColor Red
  Write-Host "       $PromptFile" -ForegroundColor Red
  Write-Host "     No peer was started. Nothing claimed the '$Role' role, which is the correct" -ForegroundColor Red
  Write-Host "     outcome — a peer with no instruction would hold the chair and never answer." -ForegroundColor Red
  Write-Host ''
  exit 1
}

$prompt = (Get-Content -Raw -LiteralPath $PromptFile).TrimEnd("`r", "`n")
# Read once, then drop it. It is a one-shot instruction, not state: a /restart re-execs arc and must
# NOT re-send the birth prompt (that is what stripConvArgs exists to prevent on the other side).
Remove-Item -LiteralPath $PromptFile -Force -ErrorAction SilentlyContinue

if ([string]::IsNullOrWhiteSpace($prompt)) {
  Write-Host ''
  Write-Host "arc: the birth prompt was empty — refusing to start a peer that cannot know its job." -ForegroundColor Red
  Write-Host ''
  exit 1
}

# Assembled as an ARRAY, never as a string. PowerShell passes each element to the process as one
# argument, so a value with a space in it stays one value — the whole class of bug this file exists
# to end.
$argv = @()
if ($Account) { $argv += '--account', $Account }
$argv += '--name', $Role
if ($Mode)    { $argv += '--permission-mode', $Mode }
if ($Resume)  { $argv += '--resume', $Resume }
if ($Fork)    { $argv += '--fork-session' }

# `arc` resolves to arc.ps1 in a PowerShell tab, which hands argv straight to node: no parsing, no
# %VAR% expansion. That is the whole reason to prefer a PowerShell tab over cmd, whose PATHEXT cannot
# even see arc.ps1 and so always reaches arc.cmd — the batch mangler.
& arc @argv $prompt
