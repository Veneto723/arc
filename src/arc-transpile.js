#!/usr/bin/env node
// arc-transpile: convert a Claude Code conversation transcript into a flat message list
// that a Codex rollout can carry — TEXT-FIRST. Humans re-read the *text* of a chat, not
// the tool minutiae, so text messages convert at full fidelity and tool calls degrade to
// a short readable line ("[ran Bash: …]"). Proven safe: a Codex session resumes from
// exactly these text records (see arc-handoff.js for the end-to-end path).
//
// This module is PURE and host-agnostic (no Codex, no filesystem side effects beyond the
// optional reader) so it can be unit-tested without an installed Codex. arc-handoff.js
// wraps it with the Codex-specific seed/inject/resume orchestration.
'use strict';

const fs = require('fs');

const MAX_TOOL_INPUT = 200;    // a tool CALL is a one-line marker, not a payload
const MAX_TOOL_RESULT = 300;   // a tool RESULT rarely matters to the human narrative
const clip = (s, n) => { s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '…' : s; };

// Render one Claude content block to plain text. Tool calls/results become short markers;
// thinking is dropped (Codex has its own reasoning, and thinking is Claude-internal).
function blockToText(b) {
  if (!b || typeof b !== 'object') return typeof b === 'string' ? b : '';
  switch (b.type) {
    case 'text': return b.text || '';
    case 'tool_use': {
      const inp = b.name === 'Bash' && b.input && b.input.command ? b.input.command
        : b.input != null ? JSON.stringify(b.input) : '';
      return `[ran ${b.name || 'tool'}: ${clip(inp, MAX_TOOL_INPUT)}]`;
    }
    case 'tool_result': {
      const c = typeof b.content === 'string' ? b.content
        : Array.isArray(b.content) ? b.content.map((x) => (x && x.text) || '').join(' ')
          : JSON.stringify(b.content);
      return `[result${b.is_error ? ' (error)' : ''}: ${clip(c, MAX_TOOL_RESULT)}]`;
    }
    case 'thinking': return '';                 // drop
    case 'image': return '[image]';
    default: return '';                         // unknown / Claude-internal block
  }
}

// One Claude record -> { role, text } or null. `user` string content is a human turn;
// `user` array content is usually tool_results (Anthropic feeds tool output as a user
// message) and/or text; `assistant` is text + tool_use markers.
function recordToMessage(rec) {
  if (!rec || (rec.type !== 'user' && rec.type !== 'assistant')) return null;
  if (rec.isSidechain === true) return null;    // subagent transcript — not the main thread
  const m = rec.message;
  if (!m) return null;
  const role = rec.type;
  const c = m.content;
  let text;
  if (typeof c === 'string') text = c;
  else if (Array.isArray(c)) text = c.map(blockToText).filter(Boolean).join('\n').trim();
  else text = '';
  if (!text) return null;                        // pure-tool or empty turn with nothing renderable
  return { role, text };
}

// Transpile Claude transcript RECORDS -> a codex-ready message list. Consecutive
// same-role turns are merged (a tool_use turn + its follow-up text turn read as one
// assistant message), which is cleaner history and what Codex expects.
function transpile(records, opts = {}) {
  const out = [];
  let dropped = 0;
  for (const rec of records) {
    const msg = recordToMessage(rec);
    if (!msg) { if (rec && (rec.type === 'user' || rec.type === 'assistant')) dropped++; continue; }
    const last = out[out.length - 1];
    if (last && last.role === msg.role) last.text += '\n\n' + msg.text;
    else out.push(msg);
  }
  // Optional tail cap: no model can re-ingest a 54 MB session, so the caller may keep only
  // the last N messages (the recent context that matters). 0/undefined = keep everything.
  let messages = out;
  let trimmed = 0;
  if (opts.keepLast && out.length > opts.keepLast) {
    trimmed = out.length - opts.keepLast;
    messages = out.slice(-opts.keepLast);
    // history must start on a user turn for a clean resume; drop a leading assistant.
    while (messages.length && messages[0].role === 'assistant') { messages.shift(); trimmed++; }
  }
  return { messages, stats: { records: records.length, emitted: messages.length, mergedFrom: out.length, droppedTurns: dropped, trimmed } };
}

// Read a Claude Code transcript .jsonl into records (skips torn lines).
function readTranscript(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const out = [];
  for (const line of raw.split('\n')) { if (!line.trim()) continue; try { out.push(JSON.parse(line)); } catch { /* torn */ } }
  return out;
}

module.exports = { transpile, recordToMessage, blockToText, readTranscript, MAX_TOOL_INPUT, MAX_TOOL_RESULT };
