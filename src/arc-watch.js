#!/usr/bin/env node
// arc-watch: emit one line per NEW unread note for a role, so a session can WAKE on an
// incoming request instead of waiting for a human to prompt it.
//
// (Vocabulary: this is the PEER channel — one live session asking another, via notes on the
// board. Notes are how work is handed to a peer; there is no separate "delegate" tool, and
// calling a request a "delegation" only ever confused things. `arc delegate` USED to fire a
// headless one-shot here; it was removed because a peer keeps its context and a native
// subagent covers the stateless case.)
//
// The board delivers notes at TURN boundaries (a human prompt), so an idle session
// never sees a request until someone nudges it. A RESPONDER peer (e.g. a `research`
// session whose job is answering others) fixes that by running this as a Monitor /
// BACKGROUND task:
//
//     Monitor / background:  arc watch research
//
// Each note a peer posts (`arc note research --kind request "investigate X"`) then prints
// a line here → that line is an event that re-invokes the (otherwise idle) session, which
// runs `arc notes` to read it and acts. This only OBSERVES — it never advances the read
// cursor; `arc notes` does the actual read. Each unread note is emitted once per process.
//
// It runs until stopped. The session must stay ALIVE (terminal open) — a background
// waker can pull back an idle session, but nothing can wake a closed one.
'use strict';

const R = require('./arc-board');
const F = require('./arc-notes');

const POLL_MS = 2500;

// Resolve the role to watch: an explicit arg, else this session's own claimed role.
function resolveRole(roleArg, session, board) {
  const r = String(roleArg || '').trim().toLowerCase();
  if (r) return r;
  return session ? F.getRole(session, board) : null;
}

// One poll: emit any unread note for `role` we haven't emitted yet (never touches the
// cursor). Returns the updated `emitted` set. Pure-ish (takes/returns state) so it's
// testable without a running loop.
function poll(board, role, emitted, write) {
  let u;
  try { u = R.unreadFor(board, role); } catch { return emitted; }
  for (const n of u.notes) {
    if (emitted.has(n.seq)) continue;
    emitted.add(n.seq);
    const body = String(n.body).replace(/\s+/g, ' ').slice(0, 140);
    write(`${n.kind === 'request' ? 'request' : 'note'} for ${role} from ${n.from}${n.priority === 'high' ? ' [!]' : ''}: ${body}`);
  }
  return emitted;
}

function run(roleArg, cwd) {
  const session = (process.env.ARC_SESSION || '').trim();
  const board = R.resolveBoard(cwd || process.cwd());
  const role = resolveRole(roleArg, session, board);
  if (!role) {
    process.stderr.write('[arc watch] no role to watch — pass one (`arc watch research`) or claim one first (`arc role research`).\n');
    process.exit(1);
  }
  process.stderr.write(`[arc watch] watching board "${board.name}" for notes to "${role}" (Ctrl+C / stop to end)\n`);
  const emitted = new Set();
  const write = (line) => process.stdout.write(line + '\n');
  poll(board, role, emitted, write);              // fire anything ALREADY waiting immediately
  setInterval(() => poll(board, role, emitted, write), POLL_MS);
}

// ---- arc await ----------------------------------------------------------------------
// `arc watch` streams forever, which suits a session that is already awake. But a session
// about to go IDLE needs the opposite shape: something that EXITS the moment a note lands,
// because in Claude Code a background command's EXIT is what re-invokes the agent — a
// still-running command that merely prints does not. So this is `watch` with one change
// that matters: it stops. That exit IS the wake.
//
// Armed by the Stop hook when a request you asked a PEER is still unanswered (see
// arc-stop-hook.js). It does NOT mark anything read — it only observes; the board delivers
// on the turn it wakes.
const AWAIT_TIMEOUT_MS = 20 * 60 * 1000;   // a peer may be mid-task; then we stop waiting

function awaitOnce(roleArg, cwd, opts) {
  const o = opts || {};
  const pollMs = o.pollMs || POLL_MS;
  const timeoutMs = o.timeoutMs || AWAIT_TIMEOUT_MS;
  const write = o.write || ((l) => process.stdout.write(l + '\n'));
  const now = o.now || (() => Date.now());
  const session = (process.env.ARC_SESSION || '').trim();
  const board = R.resolveBoard(cwd || process.cwd());
  const role = resolveRole(roleArg, session, board);
  if (!role) {
    process.stderr.write('[arc await] no role — pass one (`arc await research`) or claim one first (`arc:role research`).\n');
    return 1;
  }
  const started = now();

  const check = () => {
    let u;
    try { u = R.unreadFor(board, role); } catch { return false; }
    if (!u.count) return false;
    write(`[arc await] ${u.count} note(s) landed for "${role}" on the "${board.name}" board — this exit is your wake-up:`);
    for (const n of u.notes) {
      write(`  #${n.seq} from ${n.from}${n.priority === 'high' ? ' [!]' : ''}: ${String(n.body).replace(/\s+/g, ' ').slice(0, 300)}`);
    }
    write('Read them properly (and mark them read) with:  arc notes');
    return true;
  };

  return new Promise((resolve) => {
    if (check()) return resolve(0);
    const t = setInterval(() => {
      if (check()) { clearInterval(t); return resolve(0); }
      if (now() - started > timeoutMs) {
        clearInterval(t);
        write(`[arc await] nothing landed for "${role}" within ${Math.round(timeoutMs / 60000)}m — giving up. Your peer may be mid-task or gone; the board keeps the request either way, and their reply will reach you at a later turn.`);
        return resolve(0);          // exit 0: a quiet wake, not a failure
      }
    }, pollMs);
  });
}

module.exports = { run, poll, resolveRole, awaitOnce };

if (require.main === module) run(process.argv[2], process.cwd());
