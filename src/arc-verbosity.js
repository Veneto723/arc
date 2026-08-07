#!/usr/bin/env node
// arc-verbosity: measure every reply's length, and write it down. Nothing else.
//
// THE RULE ALREADY EXISTED AND ALREADY MOSTLY WORKED - that is exactly why prose could not close it.
// The operator's CLAUDE.md carries a specific, checkable reply contract ("the first sentence answers
// the question", "length follows the question, not the work", a banned-padding list). Measured over
// one real session's transcript, 862 reply turns:
//     median question  116 chars
//     median reply     212 chars   (1.8x - the rule holds)
//     over 1500 chars   82 / 862   (10%)
//     of the 276 questions under 60 chars, 38 got a wall  (14%)
// So this is a TAIL problem wearing an average's clothes. The median says the contract is honoured;
// the operator's experience says otherwise, and both are true - most turns are one-line narration
// between tool calls, and they drag the median down until the walls disappear into it.
//
// WHY IT COSTS MORE THAN STYLE. Raised by the operator at hour eight of a long session: "human can
// not persist a high concentration when they consistently work for a excessive long duration of
// time." Length is a FATIGUE cost, and it compounds - the same reply that reads as thorough early
// reads as a wall late.
//
// !! WHY THIS ONLY LOGS. It was built to inject a nag into the next prompt ("your last reply was
// 2,400 chars"), and the operator cut that on sight: "lets remove the hook, and add the log." The
// call is right, and the reason is that the nag's own justification was a BORROWED number - arc's
// measured 93-94% (prose) vs 98-99% (hook-enforced) comes from arc-comply, a DIFFERENT rule with a
// different shape. Nobody has measured whether a length nag moves a length habit. So: collect the
// baseline first, decide the intervention after. The same rule this codebase applies to everything
// else - settle it with a number instead of spending a design on an opinion.
//
// THE LOG STORES RAW NUMBERS, NOT VERDICTS. There is no `wall: true` column. A threshold baked into
// the data can only ever confirm itself, and it forecloses asking the question a different way later
// ("does the RATIO matter more than the absolute?"). WALL and SHORT_Q live here as the current
// reading of the data, applied at report time and changeable without invalidating a single row.
//
// DETERMINISTIC, NEVER MODEL-GRADED - same rule as arc-comply: a character count and a substring
// check, not a judgement about quality. A model grading a model is one more thing to distrust.
//
// Read it back with:  node src/arc-verbosity.js [--json]
'use strict';

const fs = require('fs');
const path = require('path');

const WALL = 1200;            // a reply past this reads as a wall (10% of turns on the measured session)
const SHORT_Q = 60;           // "go", "commit&push" - a question this short earns a short answer
const TAIL_BYTES = 256 * 1024;
const MAX_LOG = 2 * 1024 * 1024;   // ~20k rows; past this the oldest half goes
// A reply that LEADS with a summary is doing the right thing at length. Recorded, not judged - it is
// a column in the log so the report can ask "of the long ones, how many opened with a TL;DR?".
// Matched at the very start, because a summary buried in the middle is not a summary.
const HAS_LEAD = /^\s*(?:#+\s*)?(?:\*\*)?\s*(TL;?DR|SHORT VERSION|IN SHORT|SUMMARY)\b/i;

// The last assistant reply and the human turn that prompted it, from the transcript tail.
// Bounded read - a transcript runs to tens of MB and this is on the prompt path.
function lastExchange(transcriptPath) {
  let buf;
  try {
    const fd = fs.openSync(transcriptPath, 'r');
    const size = fs.fstatSync(fd).size;
    const span = Math.min(TAIL_BYTES, size);
    buf = Buffer.alloc(span);
    fs.readSync(fd, buf, 0, span, size - span);
    fs.closeSync(fd);
  } catch { return null; }

  const lines = buf.toString('utf8').split('\n');
  let reply = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    const ln = lines[i].trim();
    if (!ln.startsWith('{')) continue;
    let j; try { j = JSON.parse(ln); } catch { continue; }

    if (reply === null && j.type === 'assistant' && j.message && Array.isArray(j.message.content)) {
      const text = j.message.content.filter((c) => c && c.type === 'text' && c.text)
        .map((c) => c.text).join('');
      // Skip the one-line narration between tool calls - it is not a reply the human reads as one,
      // and counting it is what drags the median down until the walls vanish into it.
      if (text.trim().length > 40) reply = text;
      continue;
    }
    if (reply !== null && j.type === 'user' && j.message) {
      const c = j.message.content;
      const text = typeof c === 'string' ? c
        : Array.isArray(c) ? c.filter((x) => x && x.type === 'text' && x.text).map((x) => x.text).join(' ')
          : '';
      // Hook deliveries and tool results are not the human speaking. Charging a wall against a
      // 3,000-char board injection would make the ratio meaningless.
      if (!text || /^\[SYSTEM NOTIFICATION|^\[arc\b|^\s*$/.test(text)) continue;
      return { reply, question: text };
    }
  }
  return reply ? { reply, question: null } : null;
}

// ---- the log -----------------------------------------------------------------------------------
// Machine-local and per-project, next to the board: `.arc/` is already gitignored at the root, so
// this never travels by git - the same rule the ledger lives under.
function logPath(cwd) { return path.join(cwd || process.cwd(), '.arc', 'verbosity.jsonl'); }

// The hook fires once per prompt, but a prompt does not guarantee a NEW reply behind it (a board
// delivery, a retry, an interrupted turn). Logging the same reply twice would silently double-weight
// exactly the long ones - they are the turns most likely to be interrupted. Each row carries a cheap
// signature of the reply it measured, and a repeat is dropped.
function sigOf(text) {
  let h = 0;
  for (let i = 0; i < text.length; i++) { h = (h * 31 + text.charCodeAt(i)) | 0; }
  return String(text.length) + ':' + h;
}

function lastSig(file) {
  try {
    const fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const span = Math.min(4096, size);
    const buf = Buffer.alloc(span);
    fs.readSync(fd, buf, 0, span, size - span);
    fs.closeSync(fd);
    const lines = buf.toString('utf8').trim().split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      try { const j = JSON.parse(lines[i]); if (j && j.sig) return j.sig; } catch { /* torn tail */ }
    }
  } catch { /* no log yet */ }
  return null;
}

// One row per reply: when, how long the human's message was, how long mine was, whether mine opened
// with a summary. `ts` is ISO so a row stays readable without tooling.
function record(transcriptPath, cwd) {
  try {
    const ex = lastExchange(transcriptPath);
    if (!ex) return null;
    const file = logPath(cwd);
    const sig = sigOf(ex.reply);
    if (lastSig(file) === sig) return null;              // same reply, second prompt - not a new turn

    const row = {
      ts: new Date().toISOString(),
      q: ex.question ? ex.question.length : null,
      a: ex.reply.length,
      lead: HAS_LEAD.test(ex.reply),
      sig,
    };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(row) + '\n');
    trim(file);
    return row;
  } catch { return null; }        // measuring must never wedge a prompt
}

// A log that grows forever is a log that gets deleted. Keep the newest half past the cap.
function trim(file) {
  try {
    if (fs.statSync(file).size <= MAX_LOG) return;
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    fs.writeFileSync(file, lines.slice(Math.floor(lines.length / 2)).join('\n') + '\n');
  } catch { /* a failed trim is not worth a failed prompt */ }
}

function rows(cwd) {
  try {
    return fs.readFileSync(logPath(cwd), 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

// The report. Thresholds are applied HERE, never stored - see the header.
function stats(cwd) {
  const all = rows(cwd);
  const med = (xs) => {
    if (!xs.length) return 0;
    const s = xs.slice().sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  };
  const walls = all.filter((r) => r.a > WALL);
  const shortQ = all.filter((r) => r.q !== null && r.q < SHORT_Q);
  return {
    n: all.length,
    medQ: med(all.filter((r) => r.q !== null).map((r) => r.q)),
    medA: med(all.map((r) => r.a)),
    walls: walls.length,
    wallsLed: walls.filter((r) => r.lead).length,     // long, but opened with a summary - the asked-for shape
    shortQ: shortQ.length,
    shortQWalls: shortQ.filter((r) => r.a > WALL).length,
    first: all.length ? all[0].ts : null,
  };
}

module.exports = { record, stats, rows, lastExchange, logPath, sigOf, WALL, SHORT_Q, MAX_LOG, HAS_LEAD };

if (require.main === module) {
  const s = stats(process.cwd());
  const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
  if (process.argv.includes('--json')) { console.log(JSON.stringify(s, null, 2)); }
  else if (!s.n) { console.log('[arc] no replies logged yet - ' + logPath(process.cwd())); }
  else {
    console.log('[arc] ' + s.n + ' replies logged since ' + String(s.first).slice(0, 10));
    console.log('  median question  ' + s.medQ + ' chars');
    console.log('  median reply     ' + s.medA + ' chars  (' + (s.medQ ? (s.medA / s.medQ).toFixed(1) : '?') + 'x)');
    console.log('  over ' + WALL + '        ' + s.walls + ' / ' + s.n + '  (' + pct(s.walls, s.n) + '%)'
      + '   of those, ' + s.wallsLed + ' opened with a TL;DR');
    console.log('  short questions  ' + s.shortQWalls + ' of ' + s.shortQ + ' under ' + SHORT_Q
      + ' chars got a wall  (' + pct(s.shortQWalls, s.shortQ) + '%)');
  }
}
