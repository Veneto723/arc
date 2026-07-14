#!/usr/bin/env node
// arc-stop-hook: the board's SECOND delivery point — the END of a turn.
//
// UserPromptSubmit delivers notes at turn START, which means a note that arrives while
// you are working sits on the board until a HUMAN types something. For a delegate you
// fired YOURSELF that is backwards: you asked for the work, so the answer should come
// back to you — not wait for a nudge.
//
// Stop fires as the agent is about to go idle. `{decision:'block', reason}` keeps the
// turn alive and feeds `reason` to the model, so an arrived note is handed over with
// NOBODY TYPING A CHARACTER. Two cases, in order:
//
//   1. Unread notes  → block once and hand them over. injection() advances the read
//      cursor over exactly what it delivered, so the same note can never block twice —
//      delivery is idempotent, and that is what makes this loop-safe.
//
//   2. No notes, but a delegate I fired is STILL RUNNING → this is the last moment we
//      can do anything. Nothing outside can wake an idle session: arc runs claude on the
//      real TTY (stdio:'inherit'), so it holds no handle to type into, and Claude Code
//      exposes no timer hook and no external prompt injection. The ONLY wake channel is
//      a background command the session itself started, which re-invokes the agent WHEN
//      IT EXITS. So we block once and ask the agent to arm `arc await <role>` before it
//      stops. That command exits the moment the result lands → the session wakes itself.
//
// Safety (a Stop hook that misfires wedges a session, so all three are load-bearing):
//   • stop_hook_active → return immediately. We NEVER chain a block onto our own block.
//   • We only ever block when there is genuinely something to say (a note, or an
//     un-armed in-flight delegate) — never speculatively.
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

  // 2. Nothing yet — but if a delegate is still out, arm the waker BEFORE going idle.
  const D = require('./arc-delegate');
  const pending = D.pendingFor(session, cwd);
  if (!pending.length) return null;
  D.markArmed(pending);                            // tell the agent once, never every turn

  const role = pending[0].role;
  const list = pending.map((p) => `${p.runtime}: "${String(p.task).slice(0, 60)}"`).join('\n  ');
  out({
    decision: 'block',
    reason: `[arc] ${pending.length} delegate(s) you fired are STILL RUNNING:\n  ${list}\n\n`
      + `Nothing can wake an idle session from the outside, so arm the waker before you stop:\n`
      + `  Bash tool, run_in_background: true  →  arc await${role ? ` ${role}` : ''}\n\n`
      + `It exits the moment the result lands on the board, and that exit re-invokes YOU with it. `
      + `Then tell the user the delegate is running and that you'll report back when it lands.`,
  });
  return 'arm';
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
