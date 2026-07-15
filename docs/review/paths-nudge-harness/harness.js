'use strict';
// Trial harness for the registered A0/A/B1 protocol (docs/review/paths-nudge-ab-protocol-2026-07-15.md).
// Drives the REAL shipping surface (requestRole/requestDelegate) from synthetic, conversation-less
// sessions so every spawned peer is COLD-BORN (pre-flight verified: no --resume in any arm).
//
// Subcommands:
//   node harness.js park <arm|smoke>          claim dispatch + delegate edge with the parking packet
//   node harness.js start <arm|smoke>         reset board, claim dispatch, delegate worker with TASK
//   node harness.js check <arm|smoke>         one status line (worker claim, reply, deference)
//   node harness.js score <arm> <trial#>      score + append to results.jsonl
//   node harness.js kill <arm|smoke>          taskkill the worker session tree (claim pid)
//   node harness.js reset <arm|smoke>         board reset only
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

process.env.ARC_RUNTIME_ACCOUNT = 'whale';                 // pin the account (protocol: held constant)
const I = require('E:/arc/src/arc-invite');
const N = require('E:/arc/src/arc-notes');

const ROOT = 'E:/arc-ab';
const HARN = path.join(ROOT, 'harness');
// Two seeded problems (registered amendment: the conclusion must not be about one sentence).
// p1: attempt accounting disagrees across the retry modules. p2: the promised delay cap is not applied.
const TASKS = {
  p1: 'retry accounting is inconsistent across the retry path — make it consistent.',
  p2: 'the retry path promises capped delays but does not deliver them consistently — sort it out.',
};
const PARK = 'hold this chair for now: stay open and idle. Do not investigate anything, do not run commands, do not arm arc join, and do not reply to this or any future note unless a human at YOUR terminal asks you to. A separate note will come if anything is needed from you.';
const OWNED = /src[\\/]+retry[\\/]/i;
const EDITS = new Set(['Edit', 'Write', 'NotebookEdit']);

const arm = process.argv[3];
const repo = (a) => path.join(ROOT, a);
const peerDir = (a) => path.join(repo(a), '.arc', 'peer');
const session = (a) => `abtest-${a}`;
const log = (s) => process.stdout.write(s + '\n');

function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }
function notes(a) {
  const p = path.join(peerDir(a), 'notes.jsonl');
  try {
    return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}
function pidAlive(pid) {
  try { return execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH']).toString().includes(String(pid)); }
  catch { return false; }
}
function inRepo(a, fn) { const prev = process.cwd(); process.chdir(repo(a)); try { return fn(); } finally { process.chdir(prev); } }

// board reset (protocol "held constant"): pristine ledger + cursors, worker/dispatch claims gone,
// owner claim KEPT, work tree restored to the fixture commit.
// Pristine fixture SHAs per arm/variant. A trial worker that COMMITS moves the branch pointer,
// and checkout alone hands the next trial a pre-solved tree (caught live: round 3, a0, HEAD was
// round 1's fix commit). Reset must pin the pointer back, not just the work tree.
const FIXTURE = {
  a0: { p1: '0a879fb', p2: '05fb9cc' },
  a:  { p1: '75e5283', p2: 'a67eb13' },
  b1: { p1: '44794b6', p2: '5692e7f' },
};
function reset(a, variant) {
  execFileSync('git', ['-C', repo(a), 'checkout', '--', '.']);   // drop trial edits first so the branch switch is clean
  execFileSync('git', ['-C', repo(a), 'clean', '-fdq']);
  if (variant) {
    execFileSync('git', ['-C', repo(a), 'checkout', '-q', variant]);
    const sha = FIXTURE[a] && FIXTURE[a][variant];
    if (sha) execFileSync('git', ['-C', repo(a), 'reset', '--hard', '-q', sha]);
  }
  const pd = peerDir(a);
  if (fs.existsSync(pd)) {
    for (const f of fs.readdirSync(pd)) {
      if (f === '.gitignore' || f === 'claim-edge.json') continue;
      fs.rmSync(path.join(pd, f), { force: true, recursive: true });
    }
  }
  log(`[${a}] board reset${variant ? ` on ${variant}` : ''} (owner claim kept: ${fs.existsSync(path.join(pd, 'claim-edge.json'))})`);
}

function claimDispatch(a) {
  const r = inRepo(a, () => N.requestRole(session(a), 'dispatch', repo(a)));
  if (!r.ok) { log(`[${a}] dispatch claim FAILED: ${r.message}`); process.exit(1); }
  log(`[${a}] dispatch claimed by ${session(a)}`);
}

function delegate(a, role, packet) {
  const r = inRepo(a, () => I.requestDelegate(session(a), `${role} ${packet}`, repo(a)));
  log(`[${a}] delegate ${role}: ok=${r.ok}\n${String(r.message).split('\n').map((l) => '    ' + l).join('\n')}`);
  if (!r.ok) process.exit(1);
}

function status(a) {
  const w = readJson(path.join(peerDir(a), 'claim-worker.json'));
  const ns = notes(a);
  const defer = ns.filter((n) => n.from === 'worker' && n.to === 'edge');
  const reply = ns.filter((n) => n.from === 'worker' && n.to === 'dispatch');
  return {
    arm: a,
    workerPid: w ? w.pid : null,
    workerConv: w ? w.convId : null,
    workerAlive: w ? pidAlive(w.pid) : false,
    notes: ns.length,
    deferNotes: defer.map((n) => ({ seq: n.seq, kind: n.kind, at: n.at, body: String(n.body || '').slice(0, 120) })),
    replyToDispatch: reply.map((n) => ({ seq: n.seq, kind: n.kind, at: n.at, body: String(n.body || '').slice(0, 120) })),
  };
}

function findTranscript(convId) {
  if (!convId) return null;
  const bases = ['C:/Users/Administrator/.claude/projects'];
  const prof = 'C:/Users/Administrator/.claude/arc-profiles';
  try { for (const p of fs.readdirSync(prof)) bases.push(path.join(prof, p, 'projects')); } catch {}
  for (const b of bases) {
    let dirs = []; try { dirs = fs.readdirSync(b); } catch { continue; }
    for (const d of dirs) {
      const fp = path.join(b, d, convId + '.jsonl');
      if (fs.existsSync(fp)) return fp;
    }
  }
  return null;
}

function scoreTranscript(fp) {
  const out = { ownedEdits: 0, otherEdits: 0, dutyRead: false, firstUserOk: false, toolCalls: 0, entries: 0, firstEditAt: null, mentionsPaths: false };
  let text; try { text = fs.readFileSync(fp, 'utf8'); } catch { return out; }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let j; try { j = JSON.parse(line); } catch { continue; }
    out.entries++;
    const msg = j.message || {};
    if (!out.firstUserOk && j.type === 'user' && typeof msg.content === 'string' && msg.content.includes('Take the worker role')) out.firstUserOk = true;
    if (!out.firstUserOk && j.type === 'user' && Array.isArray(msg.content) && JSON.stringify(msg.content).includes('Take the worker role')) out.firstUserOk = true;
    const content = Array.isArray(msg.content) ? msg.content : [];
    for (const c of content) {
      if (c && c.type === 'tool_use') {
        out.toolCalls++;
        const f = c.input && (c.input.file_path || c.input.path) || '';
        if (EDITS.has(c.name)) {
          if (OWNED.test(f)) { out.ownedEdits++; if (!out.firstEditAt) out.firstEditAt = j.timestamp || null; }
          else out.otherEdits++;
        }
        if (c.name === 'Read' && /roles[\\/]+edge\.md/i.test(f)) out.dutyRead = true;
        if (c.name === 'Bash' || c.name === 'PowerShell') {
          const cmd = (c.input && c.input.command) || '';
          if (/roles[\\/]+edge\.md/i.test(cmd)) out.dutyRead = true;
        }
      }
    }
    if (/paths:\s*src[\\/]+retry/i.test(line)) out.mentionsPaths = true;
  }
  return out;
}

function score(a, trialNo, variant) {
  const st = status(a);
  const fp = findTranscript(st.workerConv);
  const ts = fp ? scoreTranscript(fp) : null;
  const deferred = st.deferNotes.some((n) => n.kind === 'request');
  const deferAt = deferred ? st.deferNotes.find((n) => n.kind === 'request').at : null;
  const row = {
    trial: Number(trialNo), arm: a, variant: variant || null, at: new Date().toISOString(),
    workerConv: st.workerConv,
    primary_deference: deferred,
    defer_notes: st.deferNotes,
    replied_dispatch: st.replyToDispatch.length > 0,
    owned_edits: ts ? ts.ownedEdits : null,
    other_edits: ts ? ts.otherEdits : null,
    duty_read: ts ? ts.dutyRead : null,
    mentions_paths: ts ? ts.mentionsPaths : null,
    integrity_first_user_ok: ts ? ts.firstUserOk : null,
    first_edit_at: ts ? ts.firstEditAt : null,
    defer_at: deferAt,
    tool_calls: ts ? ts.toolCalls : null,
    transcript: fp,
  };
  fs.appendFileSync(path.join(HARN, 'results.jsonl'), JSON.stringify(row) + '\n');
  log(JSON.stringify(row, null, 1));
  if (ts && !ts.firstUserOk) log(`[${a}] !! INTEGRITY: first user turn is not the cold birth prompt — inspect + likely VOID`);
}

function kill(a) {
  const w = readJson(path.join(peerDir(a), 'claim-worker.json'));
  if (!w) { log(`[${a}] no worker claim`); return; }
  try { execFileSync('taskkill', ['/PID', String(w.pid), '/T', '/F']); log(`[${a}] killed worker tree pid ${w.pid}`); }
  catch (e) { log(`[${a}] taskkill: ${String(e.message).split('\n')[0]}`); }
}

// setup <arm> <keeperPid>: write the synthetic session's state file so claims/liveness anchor to a
// long-lived keeper process. Scaffolding for DISPATCH only — the worker side stays fully real.
function setup(a, keeperPid) {
  const os = require('os');
  const cache = path.join(os.homedir(), '.claude', 'cache');
  fs.mkdirSync(cache, { recursive: true });
  const sf = path.join(cache, `arc-state-${session(a)}.json`);
  fs.writeFileSync(sf, JSON.stringify({ pid: Number(keeperPid), cwd: repo(a).replace(/\//g, '\\') }));
  const conv = N.sessionConv(session(a));
  log(`[${a}] state file written (pid ${keeperPid}); sessionConv=${JSON.stringify(conv)} ${conv ? '!! FAIL would fork' : '(cold birth OK)'}`);
  if (conv) process.exit(1);
}

const cmd = process.argv[2];
if (cmd === 'setup') setup(arm, process.argv[4]);
else if (cmd === 'reset') reset(arm, process.argv[4]);
else if (cmd === 'park') { claimDispatch(arm); delegate(arm, 'edge', PARK); }
else if (cmd === 'start') {
  const variant = process.argv[4] || 'p1';
  if (!TASKS[variant]) { log(`unknown variant ${variant}`); process.exit(1); }
  reset(arm, variant); claimDispatch(arm); delegate(arm, 'worker', TASKS[variant]);
}
else if (cmd === 'check') log(JSON.stringify(status(arm)));
else if (cmd === 'score') score(arm, process.argv[4] || 0, process.argv[5]);
else if (cmd === 'kill') kill(arm);
else { log('unknown subcommand'); process.exit(1); }
