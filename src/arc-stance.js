#!/usr/bin/env node
// arc-stance: a per-session behavioural dial — how much INITIATIVE an agent takes with arc's
// agent-facing tools (arc note / watch / await). Set it like /effort: `arc:mode active`, or
// slide a passive·balanced·active bar with `arc:mode` (see the picker in arc-runner).
//
// WHY a model-level STEER and not a CLI gate: "passive = act only on the USER's order" is a
// distinction only the model can make — when you say "ask research about X", the agent runs
// `arc note research --kind request`, and that IS on your order. A CLI gate can't tell that from
// self-initiation. So the stance is INJECTED into the agent's context each turn (see
// arc-switch-hook.deliverBoard) and the agent self-governs.
//
// THE DEFAULT IS `balanced`, AND IT INJECTS NOTHING. Two facts drove that:
//   * A default of `passive` silently BROKE a real workflow: two live sessions on the whalephone
//     board had built 37 notes of genuine collaboration, and a passive default would have told
//     them "do not self-initiate a note" — they'd have just stopped talking, with nothing to say
//     why. Noting a peer is cheap, reversible, and the entire point of the board. The heavier
//     initiative — pulling a peer off their own work to ASK them something, arming a background
//     watch — is what stays opt-in.
//   * Those same 37 notes were written with NO stance system at all — the `peers` skill alone
//     already produces balanced behaviour. So the default needs no injection; only a DEVIATION
//     from it does. `passive` injects a RESTRICTION, `active` injects a GRANT, `balanced` is
//     silent — the common case costs zero tokens.
// And when you are solo, balanced changes nothing: the skill says "no peer → do nothing".
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const CACHE_DIR = path.join(os.homedir(), '.claude', 'cache');
const STANCES = ['passive', 'balanced', 'active'];
const DEFAULT = 'balanced';   // see the header: a passive default silently broke a real workflow

function stanceFile(session) { return path.join(CACHE_DIR, `arc-stance-${session}.json`); }

function getStance(session) {
  try {
    const s = JSON.parse(fs.readFileSync(stanceFile(String(session)), 'utf8')).stance;
    return STANCES.includes(s) ? s : DEFAULT;
  } catch { return DEFAULT; }
}

function setStance(session, stance) {
  const s = String(stance || '').toLowerCase();
  if (!STANCES.includes(s) || !session) return null;
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    const tmp = stanceFile(session) + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ stance: s, at: Date.now() }));
    fs.renameSync(tmp, stanceFile(session));
  } catch {}
  return s;
}

// The per-turn directive injected into the agent's context. null = inject nothing.
// Only a DEVIATION from the default speaks: passive restricts, active grants, balanced is silent.
function directive(stance) {
  if (stance === 'passive') {
    return "[arc stance: PASSIVE] Do NOT self-initiate anything with arc's tools this turn — no notes to peers, no asking peers for help, no background watching. Act only on the user's explicit order. (They can lift this with `arc:mode balanced`.)";
  }
  if (stance === 'active') {
    return "[arc stance: ACTIVE] Beyond noting peers, you MAY self-initiate the rest of the board when it clearly helps: when you're STUCK and `arc role` shows a peer whose job it is, ask them (`arc note <role> --kind request`) instead of grinding alone, and watch for the answer (`arc await`). Still confirm anything irreversible or outward-facing before doing it.";
  }
  return null; // balanced (the default): the `peers` skill already teaches it — say nothing, cost nothing
}

// One-line description, for the picker help + the set confirmation.
function summary(stance) {
  return stance === 'active' ? 'also ask a peer when stuck + watch for the reply, on your own judgment'
    : stance === 'balanced' ? 'the default — note peers on real changes; no asking / watching unless asked'
      : 'silent — act only on your order, no self-initiated notes at all';
}

// A plain-text spectrum bar with the selection marked, reused by the set-confirmation and
// (with its own ANSI) mirrored by the picker:  passive ─ [ balanced ] ─ active
function renderBar(sel) {
  return STANCES.map((s) => (s === sel ? `[ ${s} ]` : ` ${s} `)).join('─');
}

module.exports = { STANCES, DEFAULT, getStance, setStance, directive, summary, renderBar, stanceFile };
