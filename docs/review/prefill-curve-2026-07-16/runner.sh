#!/bin/sh
# Phase 0: the prefill curve. Does a revived peer pay time proportional to its history?
# Instrument: claude --resume <id> --fork-session -p  — identical prefill to a real revive,
# zero mutation of the original, self-terminating (nothing to reap). Cold run, then warm
# run back-to-back (tests the prompt-cache bimodality hypothesis directly).
# All runs forced to one model so the curve is internally consistent.
OUT="$HOME/arc-prefill-curve.jsonl"
: > "$OUT"
PROJ="$HOME/.claude/projects"

# id|projdir|cwd|ctx  — interleaved order (small/large alternating) so time drift can't masquerade as slope
SET="58b47624-e6e0-473d-b837-14d014c7767b|E--whaletech-whalephone|E:/whaletech/whalephone|100786
ca799f5e-2827-41a5-bd16-73269de6bc13|E--aegis|E:/aegis|21749
61e4c419-0b3c-4622-b2ab-e85bd757a666|E--arc|E:/arc|548142
70b6e1d9-9605-40d8-8041-f2b1de6af250|E--|E:/|52984
d6fa59c1-d24c-4409-bd45-ceb5e0d9c010|E--whaletech-whalephone|E:/whaletech/whalephone|854459
885db8ec-96f4-4c1a-8d01-797bc72e1ae0|E--|E:/|187722
f023f775-fbcc-4e63-bb46-5d3bae4bc633|E--whaletech-whalephone|E:/whaletech/whalephone|406779"

load() { tasklist //FI "IMAGENAME eq claude.exe" //NH 2>/dev/null | grep -c claude.exe; }

# snapshot every project dir we will touch, so new fork transcripts are identifiable + deletable
for d in E--whaletech-whalephone E--aegis E--arc E--; do
  ls "$PROJ/$d" 2>/dev/null | sort > "$HOME/.prefill-before-$d.txt"
done

run_one() {  # $1=id $2=cwd  -> echoes "ms|ok"
  cd "$2" || { echo "-1|cwd-missing"; return; }
  s=$(date +%s%N)
  out=$(env -u ARC_SESSION -u ARC_RUNTIME -u ARC_RUNTIME_ACCOUNT -u CLAUDECODE \
        -u CLAUDE_CODE_CHILD_SESSION -u CLAUDE_CODE_SESSION_ID -u CLAUDE_CODE_BRIDGE_SESSION_ID \
        -u CLAUDE_CODE_ENTRYPOINT -u CLAUDE_CODE_EXECPATH -u CLAUDE_EFFORT \
        claude --resume "$1" --fork-session --model sonnet -p "Reply with exactly: READY" </dev/null 2>&1)
  e=$(date +%s%N)
  ms=$(( (e-s)/1000000 ))
  case "$out" in *READY*) ok=1;; *) ok=0;; esac
  echo "$ms|$ok|$(echo "$out" | head -c 120 | tr -d '\n\"')"
}

# floor: a fresh conversation, ~zero history (run first and last as a drift check)
floor() {
  cd "$HOME" || return
  s=$(date +%s%N)
  out=$(env -u ARC_SESSION -u ARC_RUNTIME -u ARC_RUNTIME_ACCOUNT -u CLAUDECODE \
        -u CLAUDE_CODE_CHILD_SESSION -u CLAUDE_CODE_SESSION_ID -u CLAUDE_CODE_BRIDGE_SESSION_ID \
        -u CLAUDE_CODE_ENTRYPOINT -u CLAUDE_CODE_EXECPATH -u CLAUDE_EFFORT \
        claude --model sonnet -p "Reply with exactly: READY" </dev/null 2>&1)
  e=$(date +%s%N)
  case "$out" in *READY*) ok=1;; *) ok=0;; esac
  echo "{\"id\":\"floor-$1\",\"ctx\":0,\"cold_ms\":$(( (e-s)/1000000 )),\"cold_ok\":$ok,\"load\":$(load)}" >> "$OUT"
}

floor start
echo "$SET" | while IFS='|' read -r id proj cwd ctx; do
  [ -z "$id" ] && continue
  L=$(load)
  cold=$(run_one "$id" "$cwd"); cms=${cold%%|*}; r1=${cold#*|}; cok=${r1%%|*}
  warm=$(run_one "$id" "$cwd"); wms=${warm%%|*}; r2=${warm#*|}; wok=${r2%%|*}
  echo "{\"id\":\"$id\",\"ctx\":$ctx,\"cold_ms\":$cms,\"cold_ok\":$cok,\"warm_ms\":$wms,\"warm_ok\":$wok,\"load\":$L,\"cold_tail\":\"${cold##*|}\"}" >> "$OUT"
done
floor end

echo "DONE — results in $OUT"
