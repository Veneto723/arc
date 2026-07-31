#!/usr/bin/env node
// arc-wire-settings: the ~/.claude/settings.json merge substrate. Merges hook +
// statusline entries WITHOUT clobbering the user's existing config. Idempotent,
// refuses to touch malformed JSON, writes UTF-8 without a BOM.
//
// Used two ways:
//   • library  — mergeHooks() / readSettings() / writeSettings() are the reusable
//                merge contract the bundle installer (arc-bundle.js) rides on.
//   • CLI      — `node arc-wire-settings.js [scriptsDir]` wires arc's own core hooks
//                + statusline (scriptsDir defaults to ~/.claude/scripts).
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const settingsPathDefault = path.join(CLAUDE_DIR, 'settings.json');

// Read settings.json. Returns { settings, raw }. THROWS on malformed JSON so callers
// never silently overwrite a user's config with just their own entries.
function readSettings(settingsPath = settingsPathDefault) {
  let raw = null;
  try { raw = fs.readFileSync(settingsPath, 'utf8'); } catch { return { settings: {}, raw: null }; }
  let settings;
  try { settings = JSON.parse(raw.replace(/^﻿/, '')) || {}; } // tolerate a leading BOM
  catch (e) { throw new Error(`${settingsPath} is not valid JSON (${e.message}) — refusing to overwrite it.`); }
  return { settings, raw };
}

// Write settings back (UTF-8, no BOM, trailing newline). Backs up the prior good copy.
//
// WRITE-THEN-RENAME, because this file is READ CONSTANTLY BY LIVE SESSIONS and the naive write
// makes it briefly EMPTY. `writeFileSync` opens with O_TRUNC: the file goes to zero bytes and then
// refills, and every running session reads settings.json on its own cadence — the statusline every
// `refreshInterval` seconds, and the hook layer around each prompt and tool call. MEASURED on this
// machine: a concurrent reader caught it at ZERO BYTES 289 times in 49,176 reads (0.59%) while a
// writer looped. One deploy is one such window, but there are several sessions reading, so someone
// eventually lands in it — which is exactly the "the status bar vanished after an update, then came
// back on its own" report that sent me looking.
//
// The statusline is the VISIBLE casualty and the least important one: settings.json is also where
// the hooks are declared, including the delegate and cross-board gates. I have NOT established what
// Claude Code does when it reads this empty — it may well keep the last good config — so this is
// not a claim that gates have silently missed. It is a claim that arc should not be handing anyone
// an empty settings file, ever, when the fix is a rename.
//
// rename is atomic on NTFS, so a reader sees either the whole old file or the whole new one. The
// .bak-arc write stays a plain write on purpose: nothing reads it on a hot path, and a torn backup
// is recoverable in a way a torn settings.json is not.
// EXPORTED, because this file is not the only one that overwrites a settings file a live session is
// reading. arc-profile.syncSettings rewrites EVERY PROFILE'S OWN settings.json on ensureProfile —
// which runs on every launch — and it had the same plain writeFileSync. That is the worse of the two
// sites in practice: two sessions on ONE ACCOUNT share one profile directory, so starting a second
// session truncates the settings file the first is still reading, and the first loses its statusline
// while the new one keeps it. The global file this module owns only gets rewritten on a deploy; the
// profile file gets rewritten every time anyone opens a terminal.
// One implementation, one place, for the same reason the gate spellings ended up in one table: a rule
// with two copies has one copy.
function atomicWriteFile(filePath, body) {
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, body);
  // RETRY THE RENAME; DO NOT SURRENDER TO THE TRUNCATING WRITE ON THE FIRST REFUSAL.
  // Windows will not replace a file another process currently has OPEN — it fails EPERM — and
  // settings.json is open constantly by every live session. Measured under a concurrent reader:
  // 182 of 400 renames failed, all EPERM. The first version of this fix fell straight back to
  // `writeFileSync` on that error, so under contention it did the truncating write ~45% of the time
  // and still produced 118 empty reads. The fallback was defeating the fix in exactly the case the
  // fix was for.
  // The refusal is TRANSIENT — the reader closes its handle microseconds later — so retrying is
  // enough. With retries and no fallback the same probe saw 0 empty reads in 66,410. Backoff is a
  // real sleep (Atomics.wait on a throwaway buffer); a spin loop would keep the CPU hot and make the
  // contention worse.
  const sleep = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch {} };
  let lastErr;
  for (let attempt = 0; attempt < 40; attempt++) {
    try { fs.renameSync(tmp, filePath); return; }
    catch (e) { lastErr = e; sleep(attempt < 10 ? 5 : 25); }
  }
  // Exhausted (800ms of sleeps, ~1.1s wall): something holds the file open PERSISTENTLY — an editor,
  // a watcher, a scanner — not the transient per-tick read a live session does. Now the direct write
  // is the lesser evil, because a deploy that silently left settings.json unwired is worse than a
  // window: the hooks and the statusline would simply never arrive.
  //
  // AND SAY SO, because this path is the original bug wearing a disguise. Measured by audit: once the
  // retries are spent the truncating write reopens the zero-byte window at FULL pre-fix rate (0.75
  // empty reads per write, against a 0.60 control) — so "0 empty in 49,486" is a claim about
  // TRANSIENT contention only, and this branch is what makes that qualifier necessary. A fallback is
  // untested code that runs exactly when things are hard; one that also runs UNOBSERVED turns a
  // regression into a mystery. stderr, not a throw: the deploy must still complete.
  try { fs.unlinkSync(tmp); } catch {}
  try {
    fs.writeFileSync(filePath, body);
    process.stderr.write(
      `[arc] WARNING: could not atomically replace ${filePath} after 40 attempts `
      + `(${(lastErr && lastErr.code) || 'unknown'}) — something is holding it open. Fell back to a `
      + `direct write, which leaves a brief window where a reader sees an EMPTY settings.json. If a `
      + `session lost its statusline or a hook did not fire around now, this is why; re-run the `
      + `installer with editors/watchers closed.\n`,
    );
  } catch { throw lastErr || new Error(`could not write ${filePath}`); }
}

// Write settings back (UTF-8, no BOM, trailing newline). Backs up the prior good copy.
// The .bak-arc write stays a plain write on purpose: nothing reads it on a hot path, and a torn
// backup is recoverable in a way a torn settings.json is not.
function writeSettings(settingsPath, settings, raw) {
  if (raw != null) { try { fs.writeFileSync(settingsPath + '.bak-arc', raw); } catch {} }
  atomicWriteFile(settingsPath, JSON.stringify(settings, null, 2) + '\n');
}

// Merge hook entries into settings.hooks, idempotently and without clobbering.
// entries: [{ event, command, match? }]. `match` (default: the whole command) is the
// substring used to detect an already-present entry — pass a stable script path so a
// re-install with a moved scripts dir still dedups. New entries append into the FIRST
// matcher group of the event (co-locating with the user's matchers). Returns #added.
// STRIP OUR OWN PRIOR VERSION, THEN RE-ADD — not add-if-absent.
// The old model skipped an entry whenever a hook already matched its command substring, so it could
// ADD a missing hook but never UPDATE one whose command changed: the moment arc altered a hook's
// invocation (a new flag, a changed arg), every already-installed machine kept the STALE command
// forever and the installer still said "Done". That is the exact statusLine "adopt our own" bug, one
// layer over (research #250 GOLD 2, confirmed against a live test). The fix, Orca's pattern: each
// entry carries a stable MARKER — its script filename, which survives a command change — so we remove
// any existing hook bearing that marker (OUR prior version; a user's hook has no such marker and is
// untouched) and re-add the current command. Idempotent (re-run strips the just-added and re-adds the
// same) and updating (a changed command replaces the old). Returns the count merged.
// Split a shell-ish command line into tokens, honouring single/double quotes. Not a full POSIX
// parser — enough to identify the executable and the script argument arc itself installs.
function tokenizeCommand(command) {
  const toks = [];
  const rx = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = rx.exec(command)) !== null) toks.push(m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3]);
  return toks;
}
const baseName = (p) => path.basename(String(p).replace(/\\/g, '/')).toLowerCase();

// Is this command one of arc's OWN installed Node hook commands? arc installs exactly
// `node "<scriptsdir>/<script>"` — so ownership requires a real argv parse, not a substring:
//   • the EXECUTABLE (token 0) basename must be exactly `node` / `node.exe` — a foreign
//     `C:/mine/badnode.exe <script>` is NOT ours (was a false-positive deletion, audit #289 blocker 6);
//   • the SCRIPT is the first non-flag token after node (so `node --require=x <script>` and
//     `node --no-warnings <script>` ARE ours — was a false negative);
//   • that script's basename must equal our script — `not-arc-stop-hook.js`, or a wrapper whose LATER
//     arg merely mentions the name, is a user hook and survives.
// A `cmd /c node <script>` wrapper (exec basename `cmd`) is deliberately NOT claimed: arc never
// installs that shape, so it is a user hook — the safe error is to keep it, not delete it.
function ownsHookCommand(command, script) {
  if (typeof command !== 'string' || !script) return false;
  const toks = tokenizeCommand(command);
  if (!toks.length) return false;
  if (baseName(toks[0]) !== 'node' && baseName(toks[0]) !== 'node.exe') return false;
  const scriptTok = toks.slice(1).find((t) => !t.startsWith('-'));   // skip node flags (--require=…, --no-warnings, …)
  return !!scriptTok && baseName(scriptTok) === String(script).toLowerCase();
}

function mergeHooks(settings, entries) {
  settings.hooks = settings.hooks || {};
  let added = 0;
  for (const e of entries) {
    // Prefer the SCRIPT NAME as the marker (arc-stop-hook.js) — it identifies this hook across any
    // change to the flags/args of its command. Fall back to an explicit match, then the whole
    // command (a bundle that gives neither can still de-dup an identical command).
    const marker = e.match || e.command;
    const groups = Array.isArray(settings.hooks[e.event]) ? settings.hooks[e.event] : (settings.hooks[e.event] = []);
    // Remove OUR prior version from every group. Script-backed entries use the exact Node script
    // argv path; non-script bundle entries retain their explicit match/identical-command fallback.
    for (const g of groups) {
      if (Array.isArray(g.hooks)) g.hooks = g.hooks.filter((x) => !(x && typeof x.command === 'string'
        && (e.script ? ownsHookCommand(x.command, e.script) : x.command.includes(marker))));
    }
    // Drop any group we just emptied — a zero-hook group is dead weight and does nothing.
    settings.hooks[e.event] = groups.filter((g) => !Array.isArray(g.hooks) || g.hooks.length > 0);
    const grps = settings.hooks[e.event];
    // A MATCHER is not decoration on PreToolUse — it is what stops the hook from spawning node
    // on EVERY tool call (Read, Grep, Edit, …), which would tax every action in the session to
    // police one command. So a matched entry lives in its OWN group and never gets folded into
    // an unmatched one.
    if (e.matcher) {
      const g = grps.find((x) => x.matcher === e.matcher && Array.isArray(x.hooks));
      if (g) g.hooks.push({ type: 'command', command: e.command });
      else grps.push({ matcher: e.matcher, hooks: [{ type: 'command', command: e.command }] });
    } else {
      const g0 = grps.find((x) => Array.isArray(x.hooks) && !x.matcher);
      if (g0) g0.hooks.push({ type: 'command', command: e.command });
      else grps.push({ hooks: [{ type: 'command', command: e.command }] });
    }
    added++;
  }
  return added;
}

// WHY A TIMER, when the statusline is already event-driven: Claude Code re-runs it "after each
// new assistant message" (plus /compact, permission-mode and vim toggles) — i.e. on TURNS. arc's
// statusline shows three things that no turn of YOURS produces:
//   📌 2 from research   a note a PEER wrote, in another process, while you sat idle
//   ⚠ code · DEAF        a listener that died out from under you
//   ~20h30m to limit     a clock
// An idle session never re-renders, so the note badge — the ambient signal that arc's whole
// premise rests on — only appeared once you typed, by which point you no longer needed the hint.
// The docs name this exact case: "These triggers can go quiet when the main session is idle …
// To keep time-based or externally-sourced segments current during idle periods, set
// refreshInterval". 10s costs ~77ms of node per tick and no extra network (the usage API stays
// behind its own 60s cache), so what a tick actually does is re-read three local files.
//
// It also happens to fix the stance dial lagging after `/arc-mode`, but that was the symptom, not
// the reason: the command is blocked at UserPromptSubmit and a blocked prompt is not a turn — the
// very property that makes it cost zero tokens is what starves the bar of its refresh.
const STATUSLINE_REFRESH_SECONDS = 10;

// Set the statusline command only if the user has none of their own.
//
// ...but ADOPT our own: this used to bail on ANY existing statusLine, which meant arc could never
// change its own config after the first install — every later improvement silently skipped every
// existing machine, which is the worst kind of no-op (the installer says "Done"). So: a statusline
// that is not ours is still never touched, and one that IS ours is kept current.
function setStatusline(settings, command) {
  const cur = settings.statusLine;
  const isOurs = cur && cur.type === 'command' && typeof cur.command === 'string'
    && /usage-monitor\.js/.test(cur.command);
  if (cur && !isOurs) return false;                       // the user's own — leave it alone
  settings.statusLine = Object.assign({}, cur, { type: 'command', command, refreshInterval: STATUSLINE_REFRESH_SECONDS });
  return !cur;                                            // true only when we ADDED one
}

// arc's own core hooks, as merge entries relative to a scripts dir.
// arc-switch-hook FIRST on UserPromptSubmit so the classifier-immune switch runs first.
// TaskCreated/TaskCompleted drive the board's git-derived "done" (arc-done.js).
function coreHookEntries(scriptsDir) {
  const S = scriptsDir.replace(/\\/g, '/'); // forward slashes work in a hook command
  const H = [
    ['UserPromptSubmit', 'arc-switch-hook.js', ''],
    ['UserPromptSubmit', 'arc-notify.js', 'start'],
    // arc-stop-hook BEFORE arc-notify on Stop: the board's second delivery point. It can
    // block the stop to hand over a note that landed MID-TURN (e.g. a peer's reply),
    // so the session never goes idle on top of an unread answer it asked for.
    ['Stop', 'arc-stop-hook.js', ''],
    ['Stop', 'arc-notify.js', 'done'],
    ['StopFailure', 'arc-notify.js', 'fail'],
    ['Notification', 'arc-notify.js', 'wait'],
    // COMPACTION IS NOT A FAILURE. StopFailure is documented not to fire for a compaction, and on
    // this machine it does — a session that was merely compacting toasted "stopped on an error"
    // twice, with no error in it, and resumed by itself. These two bracket the pause so arc-notify
    // can tell them apart; they never toast. A NEW hook EVENT only reaches a session via install.ps1
    // (a session snapshots its hook REGISTRATIONS at start), so this needs a deploy, not a copy.
    ['PreCompact', 'arc-notify.js', 'compacting'],
    ['PostCompact', 'arc-notify.js', 'compacted'],
    ['TaskCreated', 'arc-done.js', ''],
    ['TaskCompleted', 'arc-done.js', ''],
  ];
  const entries = H.map(([event, script, arg]) => ({ event, script, command: `node "${S}/${script}"${arg ? ' ' + arg : ''}` }));
  // The stance gate for `arc delegate`. MATCHED to the shell tools only: unmatched, it would spawn
  // node on every Read/Grep/Edit in the session to police one command. A session may be handed
  // EITHER shell tool (the first invited peer had PowerShell and no Bash at all), so both.
  entries.push({
    event: 'PreToolUse', script: 'arc-pretool-hook.js', matcher: 'Bash|PowerShell',
    command: `node "${S}/arc-pretool-hook.js"`,
  });
  return entries;
}

// Wire arc's core hooks + statusline into settings.json.
// The BOARD commands an agent must be able to run UNATTENDED. Found by the first live
// staffing a peer: the new session's whole job is to arm its listener with nobody watching —
// it sat forever at a Bash permission prompt instead, claimed but deaf. The same prompt would
// wedge every Stop-hook re-arm in an unattended session. These are coordination commands
// (claim, listen, read, post) — nothing destructive is on this list, and `arc delegate` is
// deliberately NOT: it is the one verb that can spawn a session, so it stays gated by the stance (/arc-mode).
// EVERY shell tool, not just Bash. A session does not always get the Bash tool: the first
// INVITED peer reported `No such tool available: Bash` and had only PowerShell — so a Bash-only
// allowlist matched nothing, `arc join` raised a permission prompt, and the tab sat there
// claimed-but-deaf. That is precisely the failure this allowlist exists to prevent, so it must
// cover whichever shell the harness hands the session. (Found by the scout peer, in its own
// runtime.)
// `arc close` is HERE because the stop-hook's own nag prescribes it — a remedy the hook demands
// must never be permission-blocked (a content classifier once vetoed it mid-session and the agent
// could not comply with arc's own instruction). `arc export`/`arc import` are the board's transport
// verbs — post-dating the original list, they were missing by staleness, not decision. `arc
// delegate` stays OFF the list on purpose and by doctrine: it is the one verb that spawns a
// session, and the operator's rule is that a spawn is permitted by the human — the permission
// prompt IS that permission.
// ⚠ `arc note` IS NO LONGER HERE — the operator's rule (2026-07-31): **a session asks before it
// INITIATES a note; answering one that reached it does not need consent.** Posting is no longer an
// unattended coordination command, so it leaves this list and falls to the normal permission prompt.
// The reply half needs no permission entry at all: arc-pretool-hook's reply exemption returns
// `allow` for a PROVEN reply (addressed to you, from the role you are answering, and the sole
// command on the line), which bypasses the prompt without an allowlist rule. That gate is stricter
// than a wildcard could ever be — a wildcard cannot tell a reply from a broadcast.
// `arc notes` (READING) stays: reading is not initiating, and an unattended session must be able to
// read its own inbox. Note the two are one character apart and the strings below are matched
// EXACTLY, so retiring `arc note` cannot take `arc notes` with it.
const BOARD_COMMANDS = ['arc join', 'arc await', 'arc role', 'arc notes', 'arc close', 'arc export', 'arc import'];
const SHELL_TOOLS = ['Bash', 'PowerShell'];
const BOARD_PERMISSIONS = SHELL_TOOLS.flatMap((tool) =>
  BOARD_COMMANDS.flatMap((cmd) => [`${tool}(${cmd}:*)`, `${tool}(${cmd})`]));

// RETIRING A PERMISSION NEEDS ITS OWN LIST, because mergePermissions only ever ADDS. Dropping a
// command from BOARD_COMMANDS is invisible on any machine that already installed it: the entry sits
// in settings.json forever and the new rule silently does nothing. Same shape as the feed serving a
// stale VERSION after deploy — the file changed and the running state did not.
const RETIRED_PERMISSIONS = SHELL_TOOLS.flatMap((tool) => [`${tool}(arc note:*)`, `${tool}(arc note)`]);

function mergePermissions(settings, allow) {
  if (!settings.permissions || typeof settings.permissions !== 'object') settings.permissions = {};
  const cur = Array.isArray(settings.permissions.allow) ? settings.permissions.allow : (settings.permissions.allow = []);
  for (const p of allow) if (!cur.includes(p)) cur.push(p);
  // strip anything arc granted and has since taken back — exact match, so `arc notes` is untouched
  for (let i = cur.length - 1; i >= 0; i--) if (RETIRED_PERMISSIONS.includes(cur[i])) cur.splice(i, 1);
  return settings;
}

// A plain-object overlay where the RIGHT side wins per key — the ONE merge policy both
// skillOverrides writers share (here: arc defaults laid UNDER the user's values; in
// arc-profile.syncSettings: root values laid under the profile's). Non-plain-object
// inputs sanitize to {}: typeof [] === 'object' and string keys set on an array are
// dropped by JSON.stringify, so a corrupt "skillOverrides": [] would otherwise make a
// merge report success while writing nothing, forever. Shared so the two call sites
// cannot drift (the drift WAS real: the first draft hand-rolled this twice with two
// different corrupt-value guards).
const asMap = (v) => (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};
function overlayMaps(base, wins) { return { ...asMap(base), ...asMap(wins) }; }

// The /arc-* skill stubs exist ONLY for the / menu — the hook intercepts the typed
// command before the model runs, so their bodies must never reach the model's ambient
// skill listing either. "user-invocable-only" hides a skill from the model's listing
// while keeping it in the human's / menu: zero ambient tokens, full autocomplete.
// Defaults-under-user: a user's own override (e.g. "off" to hide one from the menu
// too) is their call and must survive every reinstall/update.
function mergeSkillOverrides(settings) {
  const SL = require('./arc-slash');
  const defaults = {};
  for (const e of SL.MENU) defaults[`arc-${e.verb}`] = 'user-invocable-only';
  settings.skillOverrides = overlayMaps(defaults, settings.skillOverrides);
  // SWEEP the arc-* namespace, mirroring the installer's stub sweep: when a verb is
  // removed from MENU, its stub is deleted but an overlay can only ever ADD — the
  // override key would outlive the skill forever, silently configuring nothing.
  // Only arc-* names, only when MENU no longer ships them; a user's overrides for
  // their own skills are out of this namespace and untouchable.
  for (const k of Object.keys(settings.skillOverrides)) {
    if (/^arc-/.test(k) && !(k in defaults)) delete settings.skillOverrides[k];
  }
  return settings;
}

function wireArcSettings(scriptsDir = path.join(CLAUDE_DIR, 'scripts'), settingsPath = settingsPathDefault) {
  const { settings, raw } = readSettings(settingsPath);
  mergeHooks(settings, coreHookEntries(scriptsDir));
  mergePermissions(settings, BOARD_PERMISSIONS);
  mergeSkillOverrides(settings);
  setStatusline(settings, `node "${scriptsDir.replace(/\\/g, '/')}/usage-monitor.js" --compact`);
  writeSettings(settingsPath, settings, raw);
  return { settingsPath, backedUp: raw != null };
}

module.exports = { readSettings, writeSettings, atomicWriteFile, mergeHooks, ownsHookCommand, mergePermissions, mergeSkillOverrides, overlayMaps, BOARD_PERMISSIONS, setStatusline, STATUSLINE_REFRESH_SECONDS, coreHookEntries, wireArcSettings };

if (require.main === module) {
  try {
    const r = wireArcSettings(process.argv[2] || path.join(CLAUDE_DIR, 'scripts'));
    process.stdout.write(`settings.json wired (hooks + statusline)${r.backedUp ? ' — backup at settings.json.bak-arc' : ''}\n`);
  } catch (e) {
    process.stderr.write(`arc-wire-settings: ${e.message}\n  Nothing was changed.\n`);
    process.exit(1);
  }
}
