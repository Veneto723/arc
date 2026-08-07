---
name: grilling
description: Stress-test a plan, design, or decision before building it. Interviews the operator in rounds, attacking the design while changing it is still cheap. Use when the user says "grill me", "stress-test this", "poke holes in this", or is about to commit to a design whose cost is mostly ahead of it.
---

# Grilling — attack the design while it is still cheap to change

`audit` reviews a **finished diff**. This attacks a **plan**, before the code exists. The two do not
overlap: by the time audit sees it, the expensive decisions are already spent.

Adapted from [mattpocock/skills](https://github.com/mattpocock/skills) (`productivity/grilling`, MIT).
The frontier mechanic is theirs. **Rule 1 is the arc addition, and it is the one that matters here.**

## Rule 1 — MEASURE FIRST. A question you could have answered yourself is a wasted round.

Before asking anything, ask yourself: *is this checkable?* If the ledger, the code, git history, or a
five-line probe can settle it, **settle it and report the number** instead of spending a question.

This is not a nicety — it is where the answers actually come from:

| looked like a judgement call | what the probe said | settled by |
|---|---|---|
| "should corrections interrupt too?" | 1.6–5.0 interrupts/day across all roles | counting the ledger |
| "is a board-wide flag fine?" | **176 of 183** such notes are DIRECTED | counting the ledger |
| "is the shrink rule working?" | 4 rounds at ~4,400 chars; two PASSED by 32 and 75 chars | measuring the thread |
| "is our skill file too big?" | 3.0× the largest in a 205k-star collection | `wc -c` on a clone |

Every one of those arrived as an opinion and left as a number. **Opinions are what you ask about;
facts are what you go and get.**

⚠ And the inverse: do not measure a **preference**. "Should the panel say open or owed" has no probe.
Asking is right there; measuring is stalling.

## Rule 2 — work the frontier, one round at a time

Map the plan as a tree: every decision branches into the decisions hanging off it. The **frontier** is
every decision whose prerequisites are already settled — the questions answerable *now* without
guessing at answers you have not heard.

Ask the frontier. Then **stop and wait.** Each answer reshapes the tree: settled decisions push the
frontier outward and unblock what depended on them. A question whose answer depends on another still
open in this round belongs to a **later** round.

Done when the frontier is empty — every branch visited, nothing silently assumed.

## Rule 3 — every question carries your recommendation

Never ask a bare question. State what you would do and why, so the operator can say "yes" in one word
and only has to engage where they disagree.

```
Q1 — <the decision, in the operator's own words>
     <one or two lines of what actually hangs on it>
  → I'd <recommendation>, because <the reason, ideally a number>
```

**Three questions a round, at most.** The source skill asks the whole frontier at once with
multi-paragraph questions; that produces a wall, and this operator has asked for shorter answers
repeatedly and rejected a question-modal twice in favour of plain conversation. If the frontier is
wider than three, ask the three that unblock the most and say how many are behind them.

## Rule 4 — facts are yours to find, decisions are theirs to make

If a frontier question needs something from the environment, **go get it** — a one-shot lookup is a
subagent's job. Do not spawn a peer for it: a fresh-born peer is a subagent with extra steps, and
accumulated context is the entire reason a peer beats one.

Do not block on it either. A running lookup is an unsettled prerequisite, so only the questions
*downstream* of it wait — ask the rest of the frontier now.

## Rule 5 — do not start building

The session ends when the operator says the understanding is shared. Not when you think it is.
An answered question is not permission; `audit`'s verdict is not commit authorization, and neither is
this. Same gate as everything else: build → suite → verdict → **stop and ask**.

⚠ **A grilling that only confirms the plan has failed.** If three rounds produce no change, either the
plan was already sound — say so plainly and stop — or you are asking questions whose answers cannot
move anything. The second is far more likely, and it is a smell: you are seeking agreement, not
attacking the design. Aim at the load-bearing assumption instead, the one where being wrong is
expensive and nobody has checked it.
