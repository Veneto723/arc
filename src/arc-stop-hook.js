#!/usr/bin/env node
// arc-stop-hook: the board's SECOND delivery point — the END of a turn.
//
// UserPromptSubmit delivers notes at turn START, which means a note that arrives while
// you are working sits on the board until a HUMAN types something. For an answer you
// ASKED FOR that is backwards: you posed the question, so the reply should come back to
// you — not wait for a nudge.
//
// Stop fires as the agent is about to go idle. `{decision:'block', reason}` keeps the
// turn alive and feeds `reason` to the model, so an arrived note is handed over with
// NOBODY TYPING A CHARACTER. Two cases, in order:
//
//   1. Unread notes  → block once and hand them over. injection() advances the read
//      cursor over exactly what it delivered, so the same note can never block twice —
//      delivery is idempotent, and that is what makes this loop-safe.
//
//   2. No notes, but a request I asked a PEER is STILL UNANSWERED → this is the last
//      moment we can do anything. Nothing outside can wake an idle session: arc runs
//      claude on the real TTY (stdio:'inherit'), so it holds no handle to type into, and
//      Claude Code exposes no timer hook and no external prompt injection. The ONLY wake
//      channel is a background command the session itself started, which re-invokes the
//      agent WHEN IT EXITS. So we block once and ask the agent to arm `arc await <role>`
//      before it stops. That exits the moment the reply lands → the session wakes itself.
//
// STANCE (arc:mode) does NOT gate any of this, on purpose. Every case here is conditioned on
// something YOU ALREADY STARTED — an unread note addressed to you, a request you sent. That is
// FOLLOW-THROUGH, not initiative. The stance gates the ASK, upstream:
// under PASSIVE you'd only have asked because the user told you to, so muting the wake would
// eat an answer the user explicitly wanted. (Contrast `arc watch`, which volunteers you for work
// nobody has asked for yet — speculative, so the skill gates THAT on ACTIVE.)
// And we only ever OFFER: the block goes to the model, which is already carrying its stance
// directive, so a passive agent can just decline. Whether the user ordered the ask is a judgment
// only the model can make — a hook can't see it.
//
// Safety (a Stop hook that misfires wedges a session, so all three are load-bearing):
//   • stop_hook_active → return immediately. We NEVER chain a block onto our own block.
//   • We only ever block when there is genuinely something to say (a note, or an
//     un-armed unanswered request) — never speculatively.
//   • Any throw exits 0 silently. A coordination nicety must never trap a session.
// Claude Code independently caps consecutive Stop blocks at 8, which is the backstop.
'use strict';

function out(value) { process.stdout.write(JSON.stringify(value)); }

function run(raw) {
  let hook = {};
  try { hook = JSON.parse(raw || '{}'); } catch {}

  // A block already fired this turn — the model is mid-continuation. Never chain.
  if (hook.stop_hook_active) return null;

  const session = (process.env.ARC_SESSION || '').trim();
  if (!session) return null;                       // not an arc session — stay out of the way
  const cwd = typeof hook.cwd === 'string' ? hook.cwd : process.cwd();

  // 1. Anything on the board for me? Hand it over instead of going idle.
  const inj = require('./arc-notes').injection(session, cwd);
  if (inj) {
    out({
      decision: 'block',
      reason: `${inj.text}\n\n(arc delivered this at the END of your turn — the user typed nothing. `
        + `Act on it if it needs acting on, then tell the user what came back.)`,
    });
    return 'notes';
  }

  // 2. A QUESTION you asked a PEER that nobody has answered yet. You asked, so you want the
  //    answer — but a peer replies on THEIR schedule, and if you go idle first, nothing wakes
  //    you: the reply just sits on the board until a human happens to type something. So arm
  //    `arc await`, whose EXIT re-invokes you. Offered ONCE per request (markRequestsArmed),
  //    never every turn.
  const N = require('./arc-notes');
  const open = N.unarmedRequests(session, cwd);
  if (!open.notes.length) return null;
  N.markRequestsArmed(session, open.notes.map((n) => n.seq));

  const asked = open.notes.map((n) => `#${n.seq} → ${n.to || 'everyone'}: "${String(n.body).replace(/\s+/g, ' ').slice(0, 60)}"`).join('\n  ');
  out({
    decision: 'block',
    reason: `[arc] ${open.notes.length} request(s) you asked a peer are STILL UNANSWERED:\n  ${asked}\n\n`
      + `They answer on their own schedule, and nothing can wake an idle session from outside. `
      + `If you want the answer, arm the waker before you stop:\n`
      + `  Bash tool, run_in_background: true  →  arc await ${open.role}\n\n`
      + `It exits the moment they reply, and that exit re-invokes YOU with it. If the answer `
      + `isn't worth waiting on, just say so and stop — you won't be asked about these again.`,
  });
  return 'request';
}

module.exports = { run };

if (require.main === module) {
  let raw = '';
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    try { run(raw); } catch { /* NEVER wedge a session on a coordination nicety */ }
    process.exit(0);
  };
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => { raw += c; });
  process.stdin.on('end', finish);
  process.stdin.on('error', finish);
  setTimeout(finish, 500).unref();
}
