'use strict';
// Pre-flight for the A0/A/B1 run (registered protocol, spawning rule 2):
// dry-run the REAL staffRole from a synthetic, conversation-less session and
// assert the built launch command contains NO --resume (cold birth) in every arm.
// Zero sessions are started: the spawn is captured by a recorder, trust is stubbed.
const path = require('path');
const I = require('E:/arc/src/arc-invite');
const N = require('E:/arc/src/arc-notes');

const SESSION = 'abtest-preflight';           // synthetic: no state file, no conversation
// Dry-run against whichever boards have a VACANT worker chair (occupied chairs are refused, and
// mid-run the three arm boards hold live round workers). The launch shape is board-independent.
const arms = process.argv.slice(2).length ? process.argv.slice(2) : ['a0', 'a', 'b1'];
let failed = 0;

// 1) the synthetic session must have NO conversation to fork
const conv = N.sessionConv(SESSION);
console.log(`sessionConv("${SESSION}") = ${JSON.stringify(conv)}  ${conv ? 'FAIL — would fork!' : 'OK (cold birth guaranteed)'}`);
if (conv) failed++;

// 2) per arm: capture the exact launch command, assert cold birth
for (const arm of arms) {
  process.chdir(path.join('E:/arc-ab', arm));
  const rec = [];
  const prompts = [];
  const r = I.staffRole(SESSION, 'worker', {
    spawn: (cmd, args, o) => { rec.push({ cmd, args }); return { status: 0 }; },
    ensureTrusted: (dir) => ({ ok: true, dir, stubbed: true }),
    hasWt: true,
    writeScript: (text, role) => { prompts.push(text); return `X:/captured-birth-${role}.txt`; },  // 9edaf38 seam: prompt as data
  });
  const launch = rec.length ? rec[0].args.join(' ') : '(no spawn captured)';
  const resume = /--resume/.test(launch) || prompts.some((p) => /--resume/.test(p));
  const forks = /--fork-session/.test(launch) || prompts.some((p) => /--fork-session/.test(p));
  console.log(`\n[${arm}] staffRole ok=${r.ok} revived=${r.revived}${r.ok ? '' : `\n  FAIL message: ${r.message}`}`);
  console.log(`  launch: ${launch.slice(0, 400)}`);
  if (prompts.length) console.log(`  birth prompt (as data, ${prompts[0].length} chars): ${prompts[0].slice(0, 200).replace(/\n/g, ' | ')}`);
  console.log(`  --resume present: ${resume}  --fork-session present: ${forks}  => ${(!resume && !forks) ? 'COLD BIRTH OK' : 'FAIL — CONTAMINATION PATH'}`);
  if (!r.ok || resume || forks) failed++;
}

console.log(`\npre-flight: ${failed ? `FAILED (${failed})` : 'ALL CHECKS PASSED'}`);
process.exit(failed ? 1 : 0);
