# arc — roadmap

Parked work: worth doing, not urgent. Picked up when there is slack, not scheduled.

**Convention:** one heading per item. State the gap, the evidence (a committed doc, not prose), what is still undecided, and **who owns the next move**. An item with no owner and no open question does not belong here — it belongs in a commit.

---

## 1. Listener re-arm fires a false-positive "task complete" · **SMALL** · lever 1 BUILT 2026-07-27 · owner: the human (does it still happen?)

**The gap (operator-observed, 2026-07-21):** a re-armed `arc join <role>` that DECLINES (a genuine listener is already alive — `arc-await.js`) exits 0, and the harness reports that as `Background command … completed (exit code 0)` — indistinguishable from a real note-wake. `arc join` returns 0 on FIVE outcomes (note landed, already-armed decline, superseded, orphaned, board-moved) and only the first delivered anything.

**Root cause — found 2026-07-27, and it was NOT the probe disagreement this item assumed.** Both sites already call the *same* `waitingFor(session, {genuine:true})`, so there was no verdict to unify. The real defect was one line: `markWaiting` wrote the listener marker with a plain `fs.writeFileSync` — the **only** piece of arc state not written atomically. `writeFileSync` TRUNCATES before writing, so a reader in another process (the Stop hook's arming decision, the statusline badge) could catch the marker empty or half-written; `waitingFor`'s `JSON.parse` then throws into its `return null`, which reads as *"no listener armed"*. The hook nags while a listener is in fact live → the model complies → the fresh `arc join` reads the now-complete marker, finds a genuine listener, and declines. **Same bug class as the charter read in `arc-duty`** (a momentarily-unreadable file misread as ABSENT), fixed the same way.

**Built (lever 1):** `markWaiting` now uses `arc-board`'s `atomicWriteJson` (temp + rename), so a reader sees the whole old marker or the whole new one, never a torn one. Regression-tested (rewrite stays valid JSON; no `.tmp` litter).

**Still open — the residue, which is lever 2 territory:** even with the torn read gone, `arc join` still exits 0 on all five outcomes, and arc cannot change what the harness prints. If a redundant re-arm is *never launched* now, the ambiguity stops mattering; if it still fires, the remaining cause is discipline (arm ONCE — the nag is the signal, not a command).

**Owner of the next move:** the human — run normally for a while and say whether the spurious "completed (exit 0)" re-arms have stopped. If they have, delete this item; if not, it is lever 2 (discipline) and not more code.

---

## Parked elsewhere — pointers, not entries

These are live threads owned by other chairs or blocked on a call. They are **not** roadmap items; recorded here only so this file is not mistaken for the whole picture.

- **Board export/import (portability across machines).** The one live piece of the dissolved movable-todo idea: boards/claims are machine-local by design, so nothing board-derived survives a machine change until the board itself travels. `code`-sized as an extension (~220 lines, board #230); earns an item only when the human asks for it.
- **MAF adoption (C1 — compaction blindness).** `audit` and `code` are negotiating it; research is duty-free on it as of 2026-07-17. Evidence: [`review/maf-scan-2026-07-17.md`](review/maf-scan-2026-07-17.md) (`bc7789a`), verified by `audit` (board #181). Verdict so far: **observe, not build** — arc cannot compact a conversation it does not own.
- **Paired prefill rerun.** Protocol + subject-freeze handshake settled on the board (research authors, `audit` freezes and verdicts). **Unfunded** — nothing runs until the human calls the quota. Spec: [`review/prefill-curve-2026-07-16/AUDIT.md`](review/prefill-curve-2026-07-16/AUDIT.md).
- **Revive determinism (N-revive against a frozen conversation).** Rides the paired rerun's subject-freeze for free. Open at n=1: `--resume` took the chronological tip once; that rules out "obviously random", not "deterministic".
- **Standing-expert protocol.** **BLOCKED** and gated on the above: [`review/standing-expert-protocol-2026-07-16.md`](review/standing-expert-protocol-2026-07-16.md).
