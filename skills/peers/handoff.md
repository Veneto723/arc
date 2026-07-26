# Handing work off — peer, subagent, or yourself

Read this when you are about to hand work to someone else and the choice is not obvious.
The RULE is in SKILL.md; this is the reasoning behind it, plus the shape of a good request.

## A peer vs. a subagent — pick by whether context is worth keeping

| | **subagent** (Claude Code's own Task tool) | **peer** (`arc note <role> --kind request`) |
|---|---|---|
| who does it | a fresh one-shot you spawn | a **live session** already working here |
| context | **none** — reads what it needs, from scratch | **has it, and keeps accumulating** |
| after | returns its answer, then **perishes** | **still there** for the follow-up |
| good for | a bounded question; a parallel sweep | an ongoing thread someone owns |

**Reach for a subagent** when the work is self-contained and nobody needs to remember it
afterwards. It's in-session, on your own quota, and it can run another model. arc adds nothing
here — just ask for one.

**Reach for a peer** when the context is the point. If `arc role` shows a session whose job this
is, note them: they already know the history, so the third ask costs what the first did. A
subagent would re-derive that history every single time, and confidently get it slightly wrong.

**Delegating to an empty chair opens a window with its own quota**, alive until closed. Worth it
for a thread someone should own; absurd for *"what does this flag do?"* — that's a subagent. If
nobody owns the area, it's yours: just do the work.

> There used to be an `arc delegate` that fired a headless one-shot. It was removed — worse than
> a subagent (heavier, no context, dies anyway) and worse than a peer (no memory). If you were
> reaching for it: pick a row above. To run work on GPT, `/arc-switch` to a codex account.

## Write it as a bounded packet, not a shout

A good request states the objective, hands over the evidence you already have, says what is
ALREADY SETTLED so they don't re-derive it, and asks specific questions. That shape is proven —
it's what real peers on real boards actually write:

> `settle-gate inquiry -> docs/inquiry/settle-gate/GOAL.md (full brief, device-evidence,`
> `established constraints, 5 open questions). ONE-LINE: the agent is handed TRANSIENT screens`
> `and treats them as the destination -> confident wrong answers. Settled already (do not`
> `re-derive): …`

(That real note opens with the word *"DELEGATION:"* — written before the vocabulary settled. It
was posted with `arc note`, to a live peer. Read it as a **request**; the shape is what matters.)

A long packet belongs in a file — put it in `docs/` and let the note carry the one-line summary
plus the path. The note is a pointer, not the document.

**You will be woken when they answer.** A request is tracked until it's replied to: arc offers to
arm `arc join <your-role>` before you go idle, and that wake hands you the answer. So ask, then
get on with something else — the reply will find you.

## The field guide — a gotcha that outlives you, shared between peers

`.arc/fieldguide.md` is a board-level lessons file: one line per hard-won trap that cost a peer a
turn and is **not** already in the code, CLAUDE.md, or git. It is delivered to you automatically
when you claim a role, and any peer can add to it:

```
arc fieldguide "arc join must be run_in_background or it is not a wakeable listener"
arc fieldguide                 # print every lesson
```

It is not a scratchpad and not doctrine — keep it disciplined: one line, delete a lesson that goes
stale, and don't add what CLAUDE.md or a charter already says. Like the charters it travels with
the board (export/import), never git. Use it only for the lesson the *next* peer would otherwise
re-pay.
