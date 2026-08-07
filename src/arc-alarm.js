#!/usr/bin/env node
// arc-alarm: the INTERRUPT half of a note. There is no `arc alarm` verb — you post a note, and a
// kind of rank <= 1 (`alarm`, `correction`) reaches its recipients on TWO channels instead of one:
//   - IDLE peers  — the note itself wakes their listener (its EXIT re-invokes them). Free, and the
//                   same path every note uses.
//   - BUSY peers  — a flag file (`.arc/peer/alarm.json`) the pretool hook reads on every tool call.
//                   A peer mid-turn cannot be interrupted mid-generation (Claude Code exposes no
//                   such lever — re-confirmed on CLI 2.1.223: of its twelve hook events, PreToolUse
//                   is the earliest in-turn one and nothing fires while tokens stream), so the NEXT
//                   TOOL BOUNDARY is the earliest it can react. The gate denies that one call,
//                   hands over the note, and the peer re-issues.
//
// WHY THESE TWO KINDS. An `alarm` says work has stopped; a `correction` retracts something the
// recipient may be building on RIGHT NOW. Both are worthless if they arrive after the turn that
// needed them. Everything at rank >= 2 keeps the ordinary pace, because a channel that interrupts
// for routine news stops being read — and then it is unavailable for the one case it exists for.
// Measured before this was wired: 1.6 interrupts/day on one live board, 5.0 on the busier one,
// across all roles.
//
// ⚠ IT IS ADDRESSED, AND THAT IS THE PART THE OLD DESIGN COULD NOT DO. When `arc alarm` was the only
// way to raise one, every alarm was board-wide and the flag had no recipient field. 176 of the 183
// rank<=1 notes on the two live boards are DIRECTED at a single role — so a directed note now stops
// only its recipients, and only `to: null` stops everyone. Interrupting every peer for a correction
// meant for one is exactly how a gate becomes noise and stops being read.
//
// THE FLAG IS AN INDEX, NEVER A SECOND TRUTH. Every entry names a note already in the ledger, and
// the file can be rebuilt from it. That matters: a flag that disagrees with the ledger is the
// two-homes-for-one-fact problem this board keeps paying for (the contract read, the settings
// permission strip). The ledger decides what was said; this only decides who gets stopped.
// Identity is the note's stable id, never a line position — a seq is a merge-fragile ordinal.
//
// Deliberate safeties (all from the original design review, all still load-bearing):
//   - ONE read on the hot path. An absent flag ENOENTs and we fall through — no separate stat, and
//     the same catch tolerates a TTL sweep racing the read (no half-read wedge). Resolving the
//     reader's ROLE costs a second read, but only once a flag exists, so the common path is unchanged.
//   - FAIL-OPEN. The gate blocks only AFTER the ack durably persisted; if the ack write fails, the
//     tool runs. A disk/permission failure must never invert block-once into block-forever.
//   - BLOCK-ONCE, per (session, note). The ack is a SET now, not one id: several entries can be live
//     at once (one per recipient), so "have I seen this" is a per-note question.
//   - UNTRUSTED BODY. It is force-fed into a busy peer's context — a prompt-injection surface
//     stronger than a note, because the reader did not choose to read it. Capped at the source and
//     framed as coordination text, not an instruction (the framing lives in the pretool deny reason).
//   - ACKS LIVE OUTSIDE THE REPO (~/.claude/cache, like the await/offer markers): zero gitignore
//     surface, and the per-call throwaway hook never contends with long-lived runner state.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const CACHE_DIR = path.join(os.homedir(), '.claude', 'cache');
const TTL_MS = 15 * 60 * 1000;   // an alarm older than this no longer interrupts (stale-flag cap)
const BODY_CAP = 400;            // the injected body is capped (untrusted, force-fed into context)
const FLAG_KEEP = 8;             // live entries kept — a gate, not a queue; the ledger holds them all
const ACK_KEEP = 32;             // suppression list per session; not a history, so it is bounded

const flagPath = (board) => path.join(board.planDir, 'alarm.json');       // under .arc/peer/ (gitignored)
const ackPath = (session) => path.join(CACHE_DIR, `arc-alarmack-${session}.json`);

// A SET, not one id. The flag now carries several live entries (one alarm per recipient can be in
// flight at once), so "have I seen this" is per-note. Capped: an ack file is a suppression list, not
// a history — an unbounded one would grow for the life of a session.
function readAck(session) {
  try {
    const j = JSON.parse(fs.readFileSync(ackPath(session), 'utf8'));
    if (Array.isArray(j.ids)) return j.ids.map(String);
    return j.id ? [String(j.id)] : [];          // legacy single-id ack, still readable
  } catch { return []; }
}

// Returns TRUE iff the ack durably persisted. The caller FAILS OPEN on false — a failed ack write
// must let the tool run, never block it forever.
function stampAck(session, id) {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    const ids = readAck(session);
    if (!ids.includes(String(id))) ids.push(String(id));
    const tmp = ackPath(session) + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ ids: ids.slice(-ACK_KEEP), at: Date.now() }));
    fs.renameSync(tmp, ackPath(session));
    return true;
  } catch { return false; }
}

// The current alarm, or null: absent, cleared mid-read, unparseable, or STALE past its TTL. ONE
// read — an absent flag throws ENOENT and we fall through; no separate stat, no two-syscall race.
function readFlag(board) {
  let raw;
  try { raw = fs.readFileSync(flagPath(board), 'utf8'); }
  catch { return null; }
  let f; try { f = JSON.parse(raw); } catch { return null; }
  if (!f) return null;
  const live = (Array.isArray(f.notes) ? f.notes : (f.id ? [f] : []))   // v1 single-record still reads
    .filter((n) => n && n.id && !(typeof n.at === 'number' && Date.now() - n.at > TTL_MS));
  return live.length ? live : null;
}

// THE GATE — called by the pretool hook on every tool call. Returns {id, body, from} to BLOCK this
// one call, or null to let it run. Stamps the ack BEFORE signalling a block and FAILS OPEN if the
// stamp did not persist. Suppressed once this session has seen the alarm (via a prior block, or —
// once the stop-hook half lands — via the note-read).
// ⚠ AN ALARM IS NOW ADDRESSED. When the `arc alarm` verb was the only way to raise one, every alarm
// was board-wide and `to` did not exist. Folding the raise into the KIND changed that: 176 of the 183
// rank<=1 notes on the two live boards are DIRECTED at one role. Interrupting every peer for a
// correction meant for one would make the gate noise, and noise is how a gate stops being read.
// So: broadcast (to == null) reaches everyone; a directed one reaches only its recipients. Resolving
// my role costs a read, but ONLY once a flag exists — the ENOENT fast path is untouched.
function checkAndAck(session, board) {
  const live = readFlag(board);
  if (!live) return null;                               // hot path: nothing raised
  let me = null;
  try { me = require('./arc-notes').getRole(session, board); } catch {}
  const seen = readAck(session);
  const mine = live.find((n) => {
    if (seen.includes(String(n.id))) return false;      // already handled this one
    if (n.to == null) return true;                      // broadcast — everyone
    const to = Array.isArray(n.to) ? n.to : [n.to];
    return !!me && to.includes(me);
  });
  if (!mine) return null;
  if (!stampAck(session, mine.id)) return null;         // FAIL-OPEN: only block if the ack persisted
  return { id: mine.id, body: String(mine.body || ''), from: String(mine.from || 'a peer'),
    kind: String(mine.kind || 'alarm'), seq: mine.seq || null };
}

// RAISE FROM A NOTE — the whole point of folding the verb into the kind. Called after a note of rank
// <= 1 (alarm, correction) is stored, so ONE tunnel (arc note) drives both channels: the ledger wakes
// idle peers, this flag stops busy ones at their next tool call.
// The flag is a DERIVED INDEX, never a second source of truth — the ledger already holds every one of
// these notes, and this file can be rebuilt from it. That matters because a flag that disagrees with
// the ledger is the two-homes-for-one-fact problem this board keeps paying for.
function raiseFromNote(board, note, seq) {
  try {
    const existing = readFlag(board) || [];
    const entry = {
      id: note.id, seq: seq || null, from: String(note.from || 'a peer'),
      to: note.to == null ? null : note.to,
      kind: String(note.kind || 'alarm'),
      body: String(note.body || '').replace(/\s+/g, ' ').trim().slice(0, BODY_CAP),
      at: Date.now(),
    };
    const notes = existing.filter((n) => n.id !== entry.id).concat([entry]).slice(-FLAG_KEEP);
    const tmp = flagPath(board) + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ v: 2, notes }));
    fs.renameSync(tmp, flagPath(board));
    return true;
  } catch { return false; }
}



// A compact one-line indicator for an ACTIVE alarm, or '' when there is none (or it is stale past
// its TTL — readFlag already drops those, so the status bar and the gate agree on "active"). The
// caller styles and positions it; this just owns the flag's on-screen shape. A raised alarm is a
// board-wide STATE, so it belongs in the persistent status bar, not only the one-time raise line.
function badge(board, session) {
  let live; try { live = readFlag(board); } catch { return ''; }
  if (!live) return '';
  // The FIRST entry this session has not acked. With the flag now a per-recipient list, "is there an
  // alarm" and "is there an alarm FOR ME that I have not handled" are different questions, and the
  // badge has always meant the second.
  let me = null;
  try { me = require('./arc-notes').getRole(session, board); } catch {}
  const seen = session ? readAck(session) : [];
  const f = live.find((n) => !seen.includes(String(n.id))
    && (n.to == null || (!!me && (Array.isArray(n.to) ? n.to : [n.to]).includes(me))));
  if (!f) return '';
  // DISSOLVE once THIS session has taken the alarm up — acked via a flag-block or a note-read. The
  // badge means "an alarm you have NOT handled yet"; clearing it the moment you start handling it IS
  // the "on it" signal (and the raiser, auto-acked, never sees its own). Others still see it until
  // they engage. No session => show it (a role-less viewer in the folder should still see an alarm).
  const body = String(f.body || '').replace(/\s+/g, ' ').trim().slice(0, 44);
  return `ALARM: ${body}`;
}

module.exports = { raiseFromNote, badge, checkAndAck, readFlag, readAck, stampAck,
  flagPath, ackPath, TTL_MS, BODY_CAP };
