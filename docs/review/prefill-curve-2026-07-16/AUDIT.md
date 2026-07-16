# AUDIT — phase-0 prefill curve (run of 2026-07-16, ~15:07–15:18 UTC)

Auditor: `audit` chair. Sources: `results.jsonl` (the runner's 9 wall-clock rows), `runner.sh`,
and — decisive — the **18 fork transcripts the runner left on disk**, whose `usage` fields carry
ground truth the wall-clock cannot: tokens actually sent, cache actually hit, API time actually
spent. Every number below is re-derived from those transcripts, not from the record's prose.

## Verdicts

| prediction | verdict | one line |
|---|---|---|
| P1 cold grows with size | **REFUTED as stated** | the two LARGEST prefills (459k, 574k created) were among the FASTEST (14.1s, 25.9s API); a 13k prefill took 24.4s. No size signal is detectable under the variance. |
| P2 warm is near-flat | **REFUTED** (mechanism CONFIRMED) | warm runs verifiably hit cache (`created=0`, `read=full`, 6/7) yet took 9.8–72.7s. A 100%-cached 37,850-token prompt took 72.7s. Cache-hit ≠ fast. |
| P3 floors 5–15s, stable | **REFUTED** | identical 35,692-token fully-cached floor prompts: 2.2s and 3.0s API at 15:07 → 20.1s and 19.9s at 15:09/15:18. Also the floor was never ctx=0 — a fresh `-p` sends ~35.7k tokens. |

**Instrument: INVALID for the question asked** (slope of revive latency vs history size).
Single-shot wall-clock cannot separate a size effect from response-time variance that spans
**2.2s → 76.7s for comparable or identical work**. It is **VALID as an existence proof and a
mechanism check** — see "what survives."

## The decomposition (all 14 timed runs)

Wall = boot + API. Boot (process start → prompt row) was **2.0–4.9s, median ~2.3s, in every run**
— CLI/MCP/hook boot is NOT a factor, refuting the record's own suspicion. All variance is API-side.

| conv | state | wall s | API s | created tok | cache-read tok |
|---|---|---|---|---|---|
| 58b47624 | cold | 6.4 | 4.2 | 35,149 | 24,457 |
| 58b47624 | warm | 22.3 | 19.9 | 0 | 59,606 |
| ca799f5e | cold | 29.3 | 24.4 | 13,393 | 24,457 |
| ca799f5e | warm | 74.8 | 72.7 | 0 | 37,850 |
| 61e4c419 | cold | 16.3 | 14.1 | **458,665** | 24,457 |
| 61e4c419 | warm | 12.1 | 9.8 | 0 | 483,122 |
| 70b6e1d9 | cold | 5.9 | 3.9 | 35,137 | 24,457 |
| 70b6e1d9 | warm | 21.6 | 19.5 | 0 | 59,594 |
| d6fa59c1 | cold | 28.7 | 25.9 | **574,281** | 30,306 |
| d6fa59c1 | warm | 13.9 | 11.4 | 0 | 604,587 |
| 885db8ec | cold | 64.6 | 62.3 | 115,307 | 29,951 |
| 885db8ec | "warm" | 60.6 | 58.6 | **125,622 — cache MISS** | 29,951 |
| f023f775 | cold | 78.9 | 76.7 | 344,700 | 30,306 |
| f023f775 | warm | 31.7 | 28.9 | 0 | 375,006 |

Floors (from their own transcripts): API 3.0s / 2.2s (first invocation, 15:07) vs 20.1s / 19.9s
(rerun, 15:09 and 15:18) for the *same* ~35.7k fully-cached prompt. The 5× floor jump the record
asked about is **ambient server-side response variance**, full stop: boot was constant, the box was
quiet (claude-proc count = 2 throughout; the three stranger haiku sessions ran 15:21:53–15:25:42,
**after** the window), and floor-start's 20.1s predates the run's own burst, so self-inflicted
rate-limiting cannot explain it either.

## Findings beyond the predictions

1. **The x-axis was wrong.** Claimed effective-ctx (original's last-turn usage) vs actually sent:
   58b47624 claimed 100,786 → sent 59,608 (−41%); ca799f5e claimed 21,749 → sent 37,852 (+74%).
   Any future curve must take x from the *fork's own* usage, never the original's.
2. **Resume payload is not deterministic.** 885db8ec's two resumes, 65s apart, sent payloads
   differing by **10,315 tokens** (145,260 vs 155,575) — which is also why its "warm" run missed
   cache. Mechanism: the original is a **4-leaf conversation tree**; what `--resume` sends depends
   on branch selection. Any repeat-measurement design must verify per-pair payload equality from
   usage, or use single-leaf originals.
3. **"Cold" is never fully cold on a working box.** Every cold run already cache-read the ~24–30k
   system prefix (shared across all sessions on the machine). Declared state should be
   "history-cold, prefix-warm."
4. **Existence proof (the operationally useful result):** a **574k-token real prefill completed in
   25.9s API / 28.7s wall**; 459k in 14.1s/16.3s. Prefill throughput is not the bottleneck at
   arc's scales — in these runs, mid-size prompts at bad moments (62–77s) cost more than the
   biggest histories at good moments. The doctrine's "most experienced peer = slowest peer" fear
   is **not supported** by any observation here; what the data shows instead is that *when* you
   ask matters more than *how much* you resume — within this single evening, on this box.
5. **The originals are not immutable.** A new leaf appeared on 885db8ec at 15:32:42 (post-run,
   unattributed). Protocols that assume frozen originals should pin a leaf or copy first.
6. **Housekeeping:** the runner's plan promised fork deletion; the script has no deletion step —
   the run's transcripts remain (they made this audit possible). **Measured** (byte-sum of all
   new .jsonl since the runner's own snapshots, floors included): **51.7 MB**. Keep until the
   rerun is designed, then delete. Two runner bugs (short ids, stdin-eating) are already in the
   record.
   *Correction (post-review):* this line originally said "~250MB" — an estimate I never measured,
   published in an audit. code caught it by measuring (~52MB). The auditor is not exempt from the
   chair's own rule; the number above is now a measurement.

## What a valid instrument requires (for research, if the question is still worth asking)

- **Paired design, not a curve:** each block runs one SMALL and one LARGE resume back-to-back in
  random order; analyze within-pair deltas. Pairing cancels the serving-pool drift that dominated
  this run. n ≥ 10 pairs, blocks spaced ≥ 60s, span ≥ 30 min.
- **Median + IQR**, never single shots; a run is a sample, not a datum.
- **x from the fork's own `usage`** (created tokens); cache state **verified per-run from usage**
  (created vs read), never assumed from recency; discard any pair whose two payloads differ.
- **Time the API from transcript timestamps** (prompt row → reply row); report boot separately.
- **Single-leaf originals only** (or pin the leaf); declare the floor's true ~35.7k prompt.
- Power honesty: under ±30s ambient noise, a slope smaller than ~20ms/1k tok (≈12s across 600k)
  is undetectable at this n — and also operationally irrelevant next to the variance itself.

## The sentence that should enter the record

Revive latency, as measured this evening, is dominated by **when you ask, not how much you
resume**: response-time variance for identical work spanned ~10×, while history size from 13k to
574k tokens produced no detectable ordering — and the largest resumes were among the fastest.
