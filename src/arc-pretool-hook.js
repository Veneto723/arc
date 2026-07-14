#!/usr/bin/env node
// arc-pretool-hook: the stance (arc:mode) as an ENFORCED GATE, not just a steer.
//
// Everything else the stance governs is advice injected into the model's context — and that is
// the right shape for it, because "act only on the user's order" is a judgment only the model
// can make. But `arc invite` is different in kind: it spawns a REAL SESSION — a window, a
// process, its own quota — and an injected sentence cannot actually stop an agent from running
// a command. Heavy, outward-facing, and irreversible-ish actions deserve a gate that holds.
//
// PreToolUse can return a permission decision, so the dial becomes literal:
//
//   passive   → DENY   the agent may not spawn a session at all. (The USER can still type
//                      `arc:invite <role>` — that is the user's own order, and it is a PROMPT,
//                      not a tool call, so it never reaches this hook. Passive means the AGENT
//                      does not self-initiate; it never means the user is blocked.)
//   balanced  → ASK    (the default) the agent may propose it; the permission prompt IS the
//                      confirmation. This is also what happens today, since `arc invite` is
//                      deliberately kept off the allowlist.
//   active    → ALLOW  auto-approved: you asked for an agent that starts peers on its own.
//
// RUNAWAY GUARD: even under ACTIVE we downgrade to ASK once the board already has several live
// peers. Each peer is a session burning its own quota, and "spawn a helper" is exactly the kind
// of move that looks locally reasonable every single time. A cap costs nothing when it is not
// hit, and the fall-back is a prompt — never a hard refusal, so the user stays in control.
//
// SAFETY: this hook sits in front of EVERY Bash/PowerShell call, so it must be inert and it must
// never wedge a session. It bails out silently (exit 0, no output = "defer to the normal flow")
// for anything that is not an arc-invite command, for non-arc sessions, and on ANY error.
'use strict';

// Match `arc invite` anywhere it could plausibly be a command — including inside a quoted string.
// This FAILS CLOSED on purpose: a false positive costs at worst a permission prompt, while a false
// negative lets a session spawn ungated.
//
// And be honest about what this is: a GUARDRAIL against an agent's own self-initiation, not a
// sandbox against a hostile one. Any command-string matcher can be walked around (build the
// string at runtime, pipe it to a shell, and no regex sees it). It exists to make the dial mean
// something for an agent that is trying to cooperate — which is every agent here — not to contain
// one that is trying not to.
const RX_INVITE = /(?:^|[\s;&|(`])arc(?:\.cmd|\.exe)?\s+invite\b/i;

const MAX_PEERS_AUTO = 3;   // beyond this, even ACTIVE asks first

function out(decision, reason, systemMessage) {
  const payload = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: decision,
      permissionDecisionReason: reason,
    },
  };
  if (systemMessage) payload.systemMessage = systemMessage;
  process.stdout.write(JSON.stringify(payload));
}

function run(raw) {
  let hook = {};
  try { hook = JSON.parse(raw || '{}'); } catch { return null; }

  const tool = String(hook.tool_name || '');
  if (!/^(Bash|PowerShell)$/i.test(tool)) return null;            // not a shell call — defer
  const cmd = String((hook.tool_input && hook.tool_input.command) || '');
  if (!RX_INVITE.test(cmd)) return null;                          // not an invite — defer, silently

  const session = (process.env.ARC_SESSION || '').trim();
  if (!session) return null;                                      // not an arc session — stay out of the way

  const stance = require('./arc-stance').getStance(session);      // passive | balanced | active

  if (stance === 'passive') {
    out('deny',
      '[arc:mode passive] The agent may not spawn peer sessions in passive mode.',
      'arc: refused an agent-initiated `arc invite` — you are in PASSIVE mode.\n'
      + '  want the peer? type it yourself:  arc:invite <role>   (zero tokens, always allowed)\n'
      + '  or lift the restriction:          arc:mode balanced');
    return 'deny';
  }

  if (stance === 'active') {
    // Count the peers already here. Cheap, and it fails OPEN to a prompt, never to a refusal.
    let peers = 0;
    try {
      const R = require('./arc-board');
      const N = require('./arc-notes');
      const board = R.resolveBoard(N.resolveCwd(session, typeof hook.cwd === 'string' ? hook.cwd : null));
      const me = N.getRole(session, board);
      peers = R.liveRoles(board).filter((l) => l.role !== me).length;
    } catch { /* cannot count — treat as 0 and let ACTIVE do its job */ }

    if (peers >= MAX_PEERS_AUTO) {
      out('ask',
        `[arc:mode active] ${peers} peers are already live — asking before spawning another.`,
        `arc: ACTIVE would auto-approve this, but ${peers} peers are already on the board.\n`
        + '  each one is a session burning its own quota, so this one needs your nod.');
      return 'ask-cap';
    }
    out('allow', '[arc:mode active] auto-approved — you asked for an agent that starts its own peers.');
    return 'allow';
  }

  // balanced (the default): the agent may propose it; approving the prompt IS the confirmation.
  out('ask',
    '[arc:mode balanced] Spawning a peer session is a real action — the prompt is your confirmation.',
    'arc: the agent wants to spawn a peer session (new tab, forked context, its own quota).\n'
    + '  approve to allow it  ·  arc:mode active auto-approves  ·  arc:mode passive refuses outright');
  return 'ask';
}

module.exports = { run, RX_INVITE, MAX_PEERS_AUTO };

if (require.main === module) {
  let raw = '';
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    // ANY failure here must be invisible: this hook runs before every shell command, and a
    // coordination nicety must never block a session's work. No output = defer to normal flow.
    try { run(raw); } catch { /* defer */ }
    process.exit(0);
  };
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => { raw += c; });
  process.stdin.on('end', finish);
  process.stdin.on('error', finish);
  setTimeout(finish, 500).unref();
}
