#!/usr/bin/env node
// arc-comply: measure whether arc's WRITTEN rules actually hold, from REAL work.
//
// arc's architecture rests on a division it had never measured: hooks ENFORCE, prose ASKS. Which
// prose actually holds was unknown — the only datapoint was "agents open a referenced file ~60% of
// the time", measured under unspecified conditions. Three independent observations of ONE rule
// failing (a research peer re-armed every turn, so did `code`, and ROADMAP item 1 reached the same
// suspicion from the other side) turned that from a hunch into something worth counting.
//
// WHY THIS READS REAL TRANSCRIPTS INSTEAD OF SPAWNING SESSIONS (the operator's call, 2026-07-27).
// The obvious design — generate scenarios, spawn `claude -p` in a sandbox, grade the tool calls with
// a model — costs real quota per run, and measures behaviour under conditions someone invented. arc
// already writes a complete, honest record of every real session: the transcript. Reading it costs
// nothing, spawns nothing, and measures what agents did on ACTUAL work under ACTUAL pressure, which
// is the only condition anyone cares about. It also means a rule can be measured retroactively, on
// work that happened before the rule was ever questioned.
//
// SCORING IS DETERMINISTIC, NEVER MODEL-GRADED. Every rule here is a predicate over the transcript:
// a command shape, a tool result's text. A model grading a model is one more thing to distrust, and
// for these rules it buys nothing — "did `arc join` print ALREADY armed" is not a judgement call.
// A rule that CANNOT be checked deterministically does not belong here; it belongs in a hook.
//
// NOT PART OF THE CORE SUITE — `node test/run.js` is hermetic and finishes in seconds. This reads a
// machine's real transcripts, so its numbers depend on which sessions ran; it REPORTS, and never
// fails a build. (Its own rule predicates ARE unit-tested in the core suite, on synthetic
// transcripts — the logic is verified hermetically, the measurement is run by hand.)
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const PROJECTS = path.join(os.homedir(), '.claude', 'projects');
const encodeProject = (cwd) => String(cwd).replace(/[^A-Za-z0-9]/g, '-');

// THE PROMOTION BAR. Below this, a written rule is not working and the honest fix is to stop asking
// and start enforcing — move it into a hook, or delete it. The number is a convention, not a
// measurement: it says "most of the time is not good enough for a rule you rely on". Treat a rule
// that lands near it as unproven, not as passing.
const PROMOTE_BAR = 0.6;

// ---- the rules ---------------------------------------------------------------------------------
// Each rule is: does this tool call COUNT as an observation, and if so, is it a violation?
// `enforced` records whether a hook already polices the rule — that is the whole experiment. A
// hook-enforced rule should score ~1.00; it is the CONTROL that proves the harness can see
// compliance at all, so a prose rule scoring low is a finding rather than a broken counter.
//
// The `arc join` anchor is COPIED FROM THE GATE (arc-pretool-hook.js:163) on purpose: a harness that
// recognises arms differently from the hook would measure a different population than the one being
// policed, and the comparison between the two rules would be meaningless.
// TWO anchors, on purpose, and the difference between them is itself a finding.
// HOOK_ARM_RX is a VERBATIM copy of the gate's own test (arc-pretool-hook.js:163). ARM_RX is what an
// arm actually looks like in the wild — including `node <path>/arc-runner.js join`, which is what an
// agent types when `arc` is not on its PATH. The gate does not recognise that form, so a decorated
// arm written that way is never denied. Measuring `arm-bare` with the BROAD anchor would have
// blamed agents for a rule the hook never applied to them; measuring the gap between the two names
// the real defect instead. (Found by running this harness on arc's own transcripts.)
// IMPORTED, never re-spelled. This is the gate's OWN predicate (arc-pretool-hook.js). When the two
// were written separately they drifted, and the drift is precisely what hid the blind spot: the
// harness recognised arms the gate did not, and the difference read as an agent failure instead of
// a gate defect. Sharing the regex makes that class of error impossible — if the gate's coverage
// changes, this measurement changes with it.
const HOOK_ARM_RX = require('./arc-pretool-hook').ARM_LEAD_RX;
// AN ARM WEARS MANY SPELLINGS, and a narrow anchor UNDER-counts the denominator — which flatters
// the compliance rate, the direction of error that matters least to notice and most to avoid.
// Adversarial verification found ~25% of real arms missed by the first version: a quoted path
// (`node "$HOME/.claude/scripts/arc-runner.js" join x` — the closing quote defeated `\S*`), an
// absolute cmd path (`& "$env:USERPROFILE\.local\bin\arc.cmd" join x`), an env prefix
// (`ARC_SESSION=... node ... join`), and chained arms (`cd E:\arc; arc join x`). So the arm is
// matched ANYWHERE in the command, on any of the three executable spellings.
// ...but ONLY at a COMMAND POSITION. Matching the phrase anywhere over-corrected badly: this repo's
// own sessions are full of notes and echoes that QUOTE `arc join`, and those were counted as arms
// (151 phantom "violations" in one run, including an adb command that merely contained the words).
// An arm is an EXECUTABLE INVOCATION, so it must sit at the start of the string or right after a
// shell separator — never mid-sentence inside a quoted argument.
// TWO SHAPES, because an arm has two executables. `arc join x` runs the launcher directly; the other
// runs NODE with the runner as an ARGUMENT (`node src/arc-runner.js join x`) — which is what an agent
// types when `arc` is not on its PATH, and which a single "executable at command position" pattern
// structurally cannot match, since the path sits after a space.
const ARM_RX = new RegExp(
  '(?:^|[;&|]\\s*|\\n\\s*)' +                                              // command position ONLY
  '(?:[A-Za-z_][A-Za-z0-9_]*=\\S*\\s+)*' +                                 // ARC_SESSION=... prefix
  '(?:&\\s*)?' +                                                           // PowerShell call operator
  '(?:'
  + '["\']?(?:[^\\s"\';|&]*[\\\\/])?arc(?:\\.cmd|\\.exe)?["\']?\\s+join(?:\\s|$)'
  + '|'
  + 'node(?:\\.exe)?\\s+(?:-\\S+\\s+)*["\']?[^\\s"\';|&]*arc-runner\\.js["\']?\\s+join(?:\\s|$)'
  + ')', 'i');
const DECORATION_RX = /[;&|`$()<>\r\n]/;

// A MENTION IS NOT AN INVOCATION. Even anchored at a command position, `arc join` still matched
// inside quoted strings — a grep pattern (`"listening\|arc join"`), a `node -e` program containing
// the literal. Those are this repo's own sessions DISCUSSING the arm, and counting them inflates the
// denominator with commands that never armed anything. Quote parity before the match is a cheap,
// honest discriminator: an odd number of quotes to the left means the match is inside a string.
function armMatch(cmd) {
  const rx = new RegExp(ARM_RX.source, 'gi');
  let m;
  while ((m = rx.exec(cmd)) !== null) {
    const before = cmd.slice(0, m.index);
    const dq = (before.match(/"/g) || []).length;
    const sq = (before.match(/'/g) || []).length;
    if (dq % 2 === 0 && sq % 2 === 0) return m[0];
  }
  return null;
}
const isArm = (call) => armMatch(String(call.command || '').trim()) !== null;
const isHookArm = (call) => HOOK_ARM_RX.test(String(call.command || '').trim());
const isDecorated = (call) => DECORATION_RX.test(String(call.command || '').trim());

const RULES = [
  {
    id: 'arm-bare',
    scope: 'call',
    enforced: true,                      // arc-pretool-hook.js:163 DENIES a decorated arm
    rule: 'an `arc join` must be BARE — no pipe, redirect, & or ;',
    why: 'decoration detaches the listener; its exit wakes nobody and the "listening" line lies.',
    // Only arms the GATE can see — measuring the broad form here would score agents against a rule
    // the hook never applied to their command. The unseen ones get their own row, below.
    observe: isHookArm,
    violated: isDecorated,
  },
  {
    id: 'arm-gate-blind-spot',
    scope: 'call',
    // A GAP row, neither hook nor prose: it measures arms the gate CANNOT see. Averaging it into
    // "hooks" said the hooks were failing when the truth is narrower and worse — one hook has a
    // hole. Kept out of both averages so the hook-vs-prose comparison stays honest.
    enforced: null,
    rule: 'the malformed-arm gate should SEE every arm, not just ones spelled `arc join`',
    why: 'the gate anchors on a leading `arc`, so `node <path>/arc-runner.js join x | head` is never checked.',
    // Measured as COVERAGE, not as decoration. The first version asked "was this unseen arm also
    // decorated?" and used the gate's own DECORATION_RX — which flags `$`, so every arm written
    // `node "$HOME/..." join` counted as malformed when `$HOME` is just a path. What actually
    // matters, and what this now reports, is the hole itself: of every real arm, how many can the
    // gate not even look at? Whether a given unseen arm happened to be harmful is a second question;
    // a gate that cannot see a quarter of its subject is the finding.
    observe: isArm,
    violated: (call) => !isHookArm(call),
  },
  {
    id: 'arm-once',
    scope: 'turn',                       // <- the whole point; see below
    enforced: false,                     // prose only: the peers skill + the stop-hook nag
    rule: 'arm the listener ONCE per turn — the nag is a signal, not a command to re-run',
    why: 'a redundant arm creates no listener; it is a task launched for nothing that then reports success.',
    // THIS RULE IS MEASURED PER TURN, AND THE FIRST VERSION OF IT WAS WRONG — worth recording,
    // because the wrong version is the tempting one. It asked, per CALL, "did arc answer ALREADY
    // armed?" — i.e. did arc itself refuse this arm as redundant. That predicate scored a perfect
    // 100% over 487 real arms... because it NEVER FIRES: arc only declines when a listener is still
    // live, and a listener that exited (every note-wake consumes one) is legitimately re-armed. A
    // predicate that cannot fail is not a measurement, and it reported the rule as holding while
    // three independent observers said it did not.
    // What "arm ONCE" actually forbids is re-arming WITHIN A TURN. So: a turn that armed at all is
    // the observation, and arming more than once in it is the violation.
    observe: (calls) => calls.some(isArm),
    violated: (calls) => calls.filter(isArm).length > 1,
    detail: (calls) => `${calls.filter(isArm).length} arms in one turn`,
  },
];

// ---- transcript walking -------------------------------------------------------------------------
// Yields one entry per shell tool call: { command, result, convId, turn }. The RESULT is paired back
// to its call by tool_use_id — a tool_result arrives in a LATER user message, so a naive
// line-by-line reader sees the command and the answer as unrelated events.
function callsIn(file) {
  const out = [];
  let raw = '';
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return out; }
  const pending = new Map();          // tool_use_id -> index in `out`
  let turn = 0;
  // WHO OPENED THE TURN. arc's own stop-hook nag says "arm your listener" — so an arm right after a
  // nag is a session DOING AS IT WAS TOLD, and scoring it as a violation of "arm ONCE" would blame
  // an agent for obeying arc. But counting every nag as a fresh turn hides the very repetition the
  // rule is about. Neither definition is the honest one alone, so both are recorded and the report
  // shows the RANGE (see `report`): compliance is bounded by how you choose to count a turn, and
  // the reader is told that rather than handed one number.
  let turnKind = 'human';
  const SYSTEM_OPENER_RX = /^\s*(?:\[arc(?:\s|\])|Stop hook feedback:|<task-notification>|<system-reminder>|Caveat: The messages below|This session is being continued)/;
  for (const line of raw.split(/\r?\n/)) {
    if (!line.startsWith('{')) continue;
    let j; try { j = JSON.parse(line); } catch { continue; }
    // A SUBAGENT's messages are inlined into the parent transcript with isSidechain. They are a
    // different actor obeying different instructions, so counting them would score the parent for
    // work it did not do.
    if (j.isSidechain) continue;
    if (!j.message) continue;
    // CONTENT IS A STRING OR AN ARRAY, and getting this wrong silently destroyed the measurement.
    // A plain human prompt arrives as a STRING; only tool-carrying messages use the array form. The
    // first version required an array and `continue`d otherwise — so every real user prompt was
    // skipped, the turn counter almost never advanced, and 233 shell calls across a whole session
    // collapsed into ONE "turn". That manufactured multi-arm turns wholesale and reported a prose
    // rule at 30% when the arms were spread across many genuine turns. A parser that silently drops
    // the most common message shape does not fail loudly; it just answers a different question.
    const raw2 = j.message.content;
    const content = typeof raw2 === 'string' ? [{ type: 'text', text: raw2 }]
      : Array.isArray(raw2) ? raw2 : null;
    if (!content) continue;
    if (j.type === 'assistant') {
      for (const c of content) {
        if (!c || c.type !== 'tool_use') continue;
        if (!/^(Bash|PowerShell)$/i.test(String(c.name || ''))) continue;
        pending.set(c.id, out.length);
        out.push({ id: c.id, command: (c.input && c.input.command) || '', result: '', convId: path.basename(file, '.jsonl'), turn, turnKind });
      }
      continue;
    }
    if (j.type !== 'user') continue;
    // A user message carrying ONLY tool_results is the harness answering the model, not a new turn.
    let sawResult = false;
    for (const c of content) {
      if (!c || c.type !== 'tool_result') continue;
      sawResult = true;
      const at = pending.get(c.tool_use_id);
      if (at == null) continue;
      const body = typeof c.content === 'string' ? c.content
        : Array.isArray(c.content) ? c.content.map((x) => (x && x.text) || '').join('\n')
          : '';
      out[at].result = body;
      pending.delete(c.tool_use_id);
    }
    if (!sawResult) {
      turn += 1;
      const text = content.filter((c) => c && c.type === 'text').map((c) => c.text || '').join('\n');
      turnKind = SYSTEM_OPENER_RX.test(text) ? 'system' : 'human';
    }
  }
  return out;
}

// Every transcript for a repo — i.e. every conversation that ever ran in it. `arc export`-style
// project encoding, so this finds the same folder Claude Code writes to.
function transcriptsFor(repoRoot) {
  const dir = path.join(PROJECTS, encodeProject(path.resolve(repoRoot)));
  try { return fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).map((f) => path.join(dir, f)); }
  catch { return []; }
}

// ---- measurement --------------------------------------------------------------------------------
function measure(files) {
  const tally = RULES.map((r) => ({ ...r, observations: 0, violations: 0, strictObservations: 0, strictViolations: 0, examples: [], sessions: new Set() }));
  let calls = 0;
  // DEDUPE BY tool_use_id ACROSS FILES. A resumed or FORKED conversation replays its parent's
  // history into a NEW transcript, so the same physical tool call is present in several files —
  // adversarial verification counted 53 duplicated arms in whalephone and 18 in arc. Re-counting
  // them inflates numerator and denominator together AND fakes independent evidence: three of
  // whalephone's "6 sessions" are one lineage. The id is globally unique, so it is the right key.
  const seenIds = new Set();
  for (const f of files) {
    const all = callsIn(f).filter((c) => { if (!c.id) return true; if (seenIds.has(c.id)) return false; seenIds.add(c.id); return true; });
    calls += all.length;
    // CALL-scoped rules: one observation per shell call.
    for (const call of all) {
      for (const t of tally) {
        if (t.scope !== 'call' || !t.observe(call)) continue;
        t.observations += 1;
        t.sessions.add(call.convId);
        if (t.violated(call)) {
          t.violations += 1;
          if (t.examples.length < 3) t.examples.push(String(call.command).replace(/\s+/g, ' ').trim().slice(0, 100));
        }
      }
    }
    // TURN-scoped rules: one observation per TURN, because some rules are about how often a thing
    // was done, and a per-call predicate structurally cannot see "again".
    const byTurn = new Map();
    for (const call of all) {
      const k = call.turn;
      if (!byTurn.has(k)) byTurn.set(k, []);
      byTurn.get(k).push(call);
    }
    for (const [, turnCalls] of byTurn) {
      for (const t of tally) {
        if (t.scope !== 'turn' || !t.observe(turnCalls)) continue;
        t.observations += 1;
        t.sessions.add(turnCalls[0].convId);
        const bad = t.violated(turnCalls);
        if (bad) {
          t.violations += 1;
          if (t.examples.length < 3) t.examples.push(t.detail ? t.detail(turnCalls) : 'violation');
        }
        // The STRICT reading: only turns a HUMAN opened. arc's nag literally instructs a re-arm, so
        // every nag-opened turn is a turn the session was TOLD to arm in — counting those as fresh
        // observations lets arc's own prompting inflate its own compliance score.
        if (turnCalls[0].turnKind === 'human') {
          t.strictObservations += 1;
          if (bad) t.strictViolations += 1;
        }
      }
    }
  }
  return {
    files: files.length,
    calls,
    rules: tally.map((t) => ({
      id: t.id, rule: t.rule, why: t.why, enforced: t.enforced, scope: t.scope,
      observations: t.observations, violations: t.violations,
      sessions: t.sessions.size,
      rate: t.observations ? (t.observations - t.violations) / t.observations : null,
      // The same rule counted the strict way — human-opened turns only. Reported as a RANGE because
      // the honest answer is bounded by the definition, and hiding that behind one number is how a
      // measurement starts lying.
      strictRate: t.strictObservations ? (t.strictObservations - t.strictViolations) / t.strictObservations : null,
      strictObservations: t.strictObservations,
      examples: t.examples,
    })),
  };
}

// FLOOR, never round. toFixed(0) printed 485/487 as "100%" on the same line that listed 2
// violations — a number that rounds a failure away is the exact dishonesty this tool exists to
// catch, and it was in the tool. Flooring means only a genuinely perfect score can read 100%.
function pct(x) { return x == null ? '  n/a' : String(Math.floor(x * 100)).padStart(4) + '%'; }

function report(m, label) {
  const L = [];
  L.push(`arc compliance — ${label}`);
  L.push(`  ${m.files} transcript(s) · ${m.calls} shell call(s) examined`);
  L.push('');
  for (const r of m.rules) {
    const kind = r.enforced === true ? 'HOOK ' : r.enforced === null ? ' GAP ' : 'prose';
    if (!r.observations) {
      L.push(`  ${pct(null)}  [${kind}] ${r.id} — never exercised here (0 observations)`);
      continue;
    }
    const flag = r.enforced === false && r.rate < PROMOTE_BAR ? '  <-- BELOW THE BAR: enforce it or drop it'
      : r.enforced === null && r.violations ? '  <-- a HOLE in the gate, not an agent failure' : '';
    L.push(`  ${pct(r.rate)}  [${kind}] ${r.id}  (${r.observations - r.violations}/${r.observations} across ${r.sessions} transcript lineage(s))${flag}`);
    L.push(`         ${r.rule}`);
    if (r.scope === 'turn' && r.strictRate != null && r.strictObservations) {
      L.push(`         range: ${pct(r.rate).trim()} counting every turn  ·  ${pct(r.strictRate).trim()} counting only HUMAN-opened turns (${r.strictObservations})`);
      L.push(`         (arc's own nag tells a session to arm, so nag-opened turns flatter this rule.)`);
    }
    if (r.violations) {
      L.push(`         ${r.violations} violation(s); e.g. ${r.examples[0]}`);
    }
  }
  L.push('');
  // The comparison IS the point: a hook-enforced rule and a prose rule, counted the same way.
  const enforced = m.rules.filter((r) => r.enforced === true && r.observations);
  const prose = m.rules.filter((r) => r.enforced === false && r.observations);
  if (enforced.length && prose.length) {
    const avg = (rs) => rs.reduce((a, r) => a + r.rate, 0) / rs.length;
    L.push(`  hooks ${pct(avg(enforced))}   vs   prose ${pct(avg(prose))}`);
    L.push('  (a hook-enforced rule is the CONTROL — if it does not score high, distrust the counter,');
    L.push('   not the agents. Prose below ' + PROMOTE_BAR.toFixed(2) + ' is a rule that is asked for and not followed.)');
  }
  return L.join('\n');
}

// ---- CLI ----------------------------------------------------------------------------------------
function run(argv) {
  const args = (argv || []).filter(Boolean);
  const json = args.includes('--json');
  const target = args.find((a) => !a.startsWith('-'));
  const repo = path.resolve(target || process.cwd());
  const files = transcriptsFor(repo);
  if (!files.length) {
    return { ok: false, message: `no transcripts found for ${repo}\n  (looked in ${path.join(PROJECTS, encodeProject(repo))})` };
  }
  const m = measure(files);
  return { ok: true, measurement: m, message: json ? JSON.stringify(m, null, 2) : report(m, repo) };
}

module.exports = { RULES, ARM_RX, HOOK_ARM_RX, DECORATION_RX, PROMOTE_BAR, armMatch, isArm, isHookArm, callsIn, transcriptsFor, measure, report, run };

if (require.main === module) {
  const r = run(process.argv.slice(2));
  process.stdout.write(String(r.message) + '\n');
  process.exit(r.ok ? 0 : 1);
}
