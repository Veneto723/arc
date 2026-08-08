// arc-board: the BOARD — an append-only sticky-note ledger shared by the arc sessions
// working in the same place. Sessions that share a board are PEERS; each occupies a ROLE
// by writing a CLAIM. Those four words are the whole vocabulary.
//
// A BOARD = the git repo root of the session's cwd (canonicalised), else the literal
// folder. Two sessions started anywhere inside E:\whalephone are peers. Want a
// second pair on one repo? Give it a git worktree — a different folder is a
// different board, so the FILESYSTEM does the isolation, not a config field.
//
// The board follows the session's CURRENT cwd, which Claude Code reports per prompt
// and which can DRIFT. Moving around inside a repo is harmless (we walk up to the
// git root), but `cd`-ing into a DIFFERENT repo genuinely changes boards — the role
// claimed in the old board stops applying, and `/arc-role` will say you have none.
// That is intended ("you moved flats"), but it is surprising, so: documented.
//
// Design notes (each one earned; see docs/research/agent-handoff/SUMMARY.md):
//  * APPEND-ONLY, never consumed. Linda tuple spaces distinguish rd() (read, tuple
//    stays) from in() (take, tuple removed). This is rd()-only: a note is never
//    removed, only a per-role CURSOR advances. "Done" facts stay auditable forever.
//  * NO seq FIELD. A note's seq IS its 1-based line number, assigned at READ time.
//    Two peers appending concurrently would both compute "last+1" and collide; a
//    line's position cannot collide. Cursor = how many lines that role has read.
//    ^ TRUE ON ONE FILESYSTEM, AND ONLY THERE. A position is not an identity: it is
//    an accident of arrival order. The moment a board is SHARED ACROSS MACHINES via
//    git, two clones append different lines to the same offsets and every positional
//    reference silently re-points. PROVEN with two real clones: a plain merge writes
//    "<<<<<<< HEAD" INTO the ledger (unparseable — the board wedges); a merge=union
//    driver merges clean and is WORSE — the same note `replyTo:4` resolved to
//    "HOME-1" on one machine and "OFFICE-1" on the other. Same file, same history,
//    two meanings, no error. So a shared board needs an identity that travels: see
//    `id` below. seq survives as a LOCAL DISPLAY INDEX only — never as a reference.
//    SHARING IS OPT-IN, AND THIS BOARD DOES NOT TAKE IT (2026-07-16). arc's own repo
//    is PUBLIC, and committing the ledger would publish every note anyone ever writes
//    here — so .peer/ stays self-ignored below and the ledger stays local. The
//    machinery is built and proven anyway, because it is what makes the ledger
//    CORRECT, not merely shareable: a reference that means one note is right even
//    when nothing is ever merged. To share a board (a PRIVATE repo), un-ignore
//    notes.jsonl by hand — ensureBoard only writes .gitignore when absent, so an
//    edited one is never fought.
//  * STABLE ID, position-independent: `id` = "<origin>:<token>". The origin is this
//    machine (.peer/origin.json, never committed); the token is RANDOM, never a
//    counter — "count what's there and add one" is the exact race the positional
//    design was built to avoid, and reintroducing it here would undo that. Notes
//    written before ids exist are a FROZEN prefix, so they map 1:1 onto synthetic
//    ids "~:<position>" and their old numeric replyTo keeps meaning what it meant.
//  * NO LOCKING, NO GIT CAS. Peers on one machine share one working directory, so
//    they share one file on one filesystem: single-line O_APPEND writes are atomic
//    between processes. Across machines git is the transport and `merge=union` the
//    merge; correctness there comes from ids + a per-origin cursor, not from locking.
//  * SELF-IGNORING. .peer/.gitignore is "*", so the board never enters the
//    project's history and the project's own .gitignore never learns it exists.
'use strict';

const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const path = require('path');

// THE BOARD FOLDER: .arc/peer/
//
// Everything arc puts in a repo now lives under ONE `.arc/`, and the split inside it is the
// design, not an accident:
//   .arc/roles/<role>.md   COMMITTED   what a role owns. A project fact — same on every machine,
//                                      true whether or not anyone is in that chair.
//   .arc/peer/             IGNORED     the board: notes, cursors, claims. Machine state — a
//                                      claim is a PID, and a PID means nothing on your other PC.
// `.arc/peer/.gitignore` is `*`, so the board self-ignores while `.arc/roles/` commits normally.
// One folder, two lifetimes, each declaring its own.
//
// It was `.plan` until 2026-07-15 — a name left from before the room->board rename, confusing
// enough that it had to be explained out loud ("there is no .board; .plan IS the board").
//
// Renaming it moves LIVE STATE, which is the dangerous kind, so:
//   * READ falls back through LEGACY_DIRS, so the ledger is never invisible for even one call
//     between a deploy and the first write. A board that reports "no notes" when it has 38 is a
//     lie, and the silent kind.
//   * ensureBoard MIGRATES on the next write with ONE atomic rename — the whole ledger, every
//     cursor and claim, arrives intact; nothing is copied and it cannot half-finish.
// After that the fallback is a couple of failed stats, forever. No permanent shim, no data loss,
// no window where two sessions write to different folders and silently stop seeing each other.
const PLAN_DIR = path.join('.arc', 'peer');
// Newest first. A machine that skipped a hop (home still on `.plan`) migrates straight here.
const LEGACY_DIRS = ['.peer', '.plan'];
const NOTES = 'notes.jsonl';
// The self-ignore sits at .arc/.gitignore and swallows the WHOLE .arc — peer/ AND roles/.
// The operator's ruling (2026-07-17): everything under .arc is machine state and travels by
// `arc export` / `arc import`, never by git. Charters included — that half of the old split
// ("a role's duty is a project fact and commits") was overruled. One file, one level up,
// same trick: it ignores itself too, so the project's own .gitignore never needs to know
// arc exists. (The former peer/.gitattributes `merge=union` went with it: nothing under
// .arc passes through git now, and the union job moved into `arc import`'s ledger merge —
// which git's union never did soundly anyway; see the id-less-prefix note in mergeLedgers.)
const GITIGNORE_BODY =
  '# arc machine state: the board (peer/), the role charters (roles/), claims, cursors.\n' +
  '# None of it is a project artifact — it travels between machines by `arc export` /\n' +
  '# `arc import`, never by git (operator ruling, 2026-07-17). This file ignores the\n' +
  '# whole .arc including itself, so the project\'s own .gitignore never needs to know\n' +
  '# arc exists.\n' +
  '*\n';

// ---- board resolution ---------------------------------------------------------
// Canonicalise so E:\WhalePhone, e:\whalephone and a junction all name one board.
function canonical(p) {
  let out = p;
  try { out = fs.realpathSync.native(p); } catch { out = path.resolve(p); }
  out = path.resolve(out);
  return out.toLowerCase();   // Windows FS is case-insensitive: one board per path, any case
}

// Walk up for a .git (dir OR file — worktrees use a .git *file*). Fall back to cwd.
function repoRoot(startDir) {
  let dir = path.resolve(startDir);
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) return path.resolve(startDir); // no repo — the folder IS the board
    dir = up;
  }
}

// The board a session started in `cwd` belongs to.
function resolveBoard(cwd) {
  const root = canonical(repoRoot(cwd || process.cwd()));
  // basename of a drive root ("e:\") is "" — fall back to the path so a board is
  // never nameless. (Yes, people really do keep a git repo at a drive root.)
  // READ FALLBACK: a board not written to since the rename still lives under an old name, and
  // pointing at an empty `.arc/peer` would report "no notes" for a board that has 38 — a lie,
  // and the worst kind (silent). Prefer the current name; use an old one only while it is the
  // one that actually exists. ensureBoard migrates on the next write, then this never fires.
  let planDir = path.join(root, PLAN_DIR);
  if (!fs.existsSync(planDir)) {
    for (const legacy of LEGACY_DIRS) {
      const p = path.join(root, legacy);
      if (fs.existsSync(p)) { planDir = p; break; }
    }
  }
  return { root, planDir, name: path.basename(root) || root };
}

// Create the board dir + its self-ignore. Idempotent; cheap to call every time.
// Also THE MIGRATION POINT: this runs on every write path (a claim, a note), so the legacy
// `.plan` folder is renamed the first time anyone writes. One atomic rename carries the entire
// ledger, every cursor and every claim — nothing is copied, nothing is lost, and it cannot
// half-finish. It MUTATES board.planDir because callers hold the object by reference and would
// otherwise keep writing to the folder we just moved out from under them.
function ensureBoard(board) {
  const target = path.join(board.root, PLAN_DIR);
  if (board.planDir !== target && !fs.existsSync(target)) {
    // The target is NESTED now (.arc/peer), and rename() will not create the parent — without
    // this the migration silently fails and the board just stays where it was.
    try { fs.mkdirSync(path.dirname(target), { recursive: true }); } catch {}
    try { fs.renameSync(board.planDir, target); board.planDir = target; }
    catch { /* someone raced us, or it is locked — keep using the legacy dir, still correct */ }
  }
  fs.mkdirSync(board.planDir, { recursive: true });
  if (path.basename(path.dirname(board.planDir)) === '.arc') {
    // The self-ignore covers the WHOLE .arc from one level up (see GITIGNORE_BODY), and the
    // old per-dir pair inside peer/ is retired: the .gitignore is redundant under the parent
    // rule, and the .gitattributes union merge is moot — nothing under .arc meets git now.
    // Unlinking every call is a no-op after the first (ENOENT); this IS the migration.
    const gi = path.join(path.dirname(board.planDir), '.gitignore');
    if (!fs.existsSync(gi)) fs.writeFileSync(gi, GITIGNORE_BODY);
    for (const f of ['.gitignore', '.gitattributes']) { try { fs.unlinkSync(path.join(board.planDir, f)); } catch {} }
  } else {
    // A legacy planDir (root-level .peer/.plan — the rename above raced or is locked): there is
    // no .arc parent to hold the rule, so the in-dir self-ignore stays until the migration lands.
    const gi = path.join(board.planDir, '.gitignore');
    if (!fs.existsSync(gi)) fs.writeFileSync(gi, GITIGNORE_BODY);
  }
  return board;
}

const notesPath = (board) => path.join(board.planDir, NOTES);
const cursorPath = (board, role) => path.join(board.planDir, `cursor-${role}.json`);
const claimPath = (board, role) => path.join(board.planDir, `claim-${role}.json`);

// LAST-SEEN HEAD, per role, machine-local. The revive freshness brief must show a peer the commits
// it HAS NOT SEEN — and "haven't seen" is a git POSITION, not a wall-clock time. `--since=<time>`
// filters by committer date, which is wrong on a two-machine repo: a commit pulled from the other
// machine keeps its ORIGINAL date, so one made at 09:00 and pulled at 15:00 is excluded by
// `--since=14:00` though the peer never saw it (audit #149, reproduced). So we record the HEAD sha
// the peer actually saw — stamped every turn by the stop hook — and brief `<sha>..HEAD`, which is
// ancestry: immune to date skew and to pull/cherry-pick reordering. Machine-local, gitignored: it
// is "what THIS clone's peer last saw", and a home peer revived on home reads home's marker.
const seenPath = (board, role) => path.join(board.planDir, `seen-${role}.json`);
function stampSeen(board, role, sha) {
  if (!sha) return null;
  try { ensureBoard(board); atomicWriteJson(seenPath(board, role), { sha: String(sha).trim(), at: Date.now() }); return sha; }
  catch { return null; }   // a missed stamp just widens the next brief — never break a turn over it
}
function readSeen(board, role) {
  try { return JSON.parse(fs.readFileSync(seenPath(board, role), 'utf8')); } catch { return null; }
}
// LEGACY: a claim used to be called a "lease" (before the board/peer/claim rename). A session
// that is LIVE RIGHT NOW may still be holding one — and an invisible claim is not a cosmetic
// problem: a second session would see the role as vacant, take it, and the two would share a
// cursor and eat each other's notes, which is the exact failure claims exist to prevent. So
// every READ accepts both names, and a fresh claim migrates the old file away.
const legacyClaimPath = (board, role) => path.join(board.planDir, `lease-${role}.json`);
const CLAIM_FILE_RX = /^(?:claim|lease)-(.+)\.json$/;
const VALID_ROLE = /^[a-z][a-z0-9_-]{0,23}$/;
// A conversation id is a UUID and nothing else. VALID_ROLE has always gated the role half of a
// claim; this gates the OTHER half, because a convId is not merely cosmetic — it becomes a filename
// (`<convId>.jsonl`) and a launch argument. `arc import` writes a convId an ARCHIVE declared, and
// a Windows filename may legally contain `;` and `$(`, so an unchecked pointer is attacker-authored
// text on a command line. Same grammar the runner already uses at arc-runner.js:475.
const VALID_CONV = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const validConv = (id) => typeof id === 'string' && VALID_CONV.test(id);
function readClaimFile(board, role) {
  for (const p of [claimPath(board, role), legacyClaimPath(board, role)]) {
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { /* try the next name */ }
  }
  return null;
}

// ---- notes -------------------------------------------------------------------
// One line = one note. `seq` is the 1-based line number, assigned at READ time.
// ---- the note schema ---------------------------------------------------------
// Notes were free prose, and two real sessions promptly invented a taxonomy BY HAND —
// "DELEGATION: …", "Re your #8", "CORRECTION to #13 — I was WRONG", "VERDICT: …". So the
// structure is real; it was just encoded where only a human could follow it. These fields make
// it MACHINE-READABLE. All are OPTIONAL: `arc note all "build is broken"` still works, and every
// note written before this stays valid (an absent kind reads as `info`).
//
// The one that matters most is `supersedes`. The ledger is append-only ON PURPOSE (you never
// rewrite history, you append a correction) — but nothing linked the correction to what it
// corrected, so a reader could act on a claim its own author had publicly retracted. Now they
// are linked, and the retracted note is marked wherever it is read.
const KINDS = ['info', 'request', 'result', 'correction', 'alarm', 'contract'];
// `decision` was this kind's first name, and notes carrying it EXIST on disk (whalephone posted 3).
// The rename is not a free edit: normalizeKind degrades an unknown kind to `info`, so without this
// alias those notes would silently drop from rank 2 to rank 5 — a clause that binds two roles
// re-filed as routine news, with nothing to say why. A LEGACY SHIM, in the same spirit as the ones
// the board/peer/role rename had to keep: read the old spelling, always write the new one.
// Object.create(null), NOT a literal: a bare `{}` inherits Object.prototype, so a ledger line whose
// kind is "__proto__" or "constructor" resolves through the prototype chain and the unguarded
// truthiness test below returns an OBJECT (or a function) as the note's kind. Verified: with a
// literal, normalizeKind('__proto__') returned an object, not a string. Reachable through `arc
// import`, which merges lines from another machine verbatim — the same door seq/ord are already
// hardened against. A null-prototype map has no inherited keys, so only real aliases resolve.
// `blocker` was this kind's first name too, and 36 notes carry it on the two live boards. It was
// renamed to `alarm` when the separate `arc alarm` verb was folded into the kind: one word for the
// thing, one tunnel to send it. Without this shim those 36 notes would degrade to `info` — rank 0 to
// rank 5 — so a stop-the-line would re-file itself as routine news, silently, on every read.
// SECOND shim in this map for the same reason as the first: read the old spelling, always write the
// new one. (An alias is cheap; a ledger that lies about what it was told is not.)
const KIND_ALIASES = Object.assign(Object.create(null), { decision: 'contract', blocker: 'alarm' });
const DEFAULT_KIND = 'info';
// How loudly a kind wants to be read. Used to RANK the injection digest: an alarm or a
// retraction must never sit below routine news.
const KIND_RANK = { alarm: 0, correction: 1, contract: 2, request: 3, result: 4, info: 5 };

function normalizeKind(k) {
  const s = String(k || '').trim().toLowerCase();
  if (KIND_ALIASES[s]) return KIND_ALIASES[s];   // an old spelling still on disk reads as its new name
  return KINDS.includes(s) ? s : DEFAULT_KIND;   // unknown kind degrades to info, never throws
}
const asSeq = (v) => { const n = parseInt(v, 10); return Number.isInteger(n) && n > 0 ? n : undefined; };

// ---- references: what `replyTo`/`supersedes` POINT AT --------------------------
// A reference used to be a position ("note 4"), which is only meaningful in one file on one
// machine. Proven to break the moment a board is shared: after a union merge the SAME `replyTo:4`
// meant "HOME-1" on one clone and "OFFICE-1" on the other — a thread that re-parents itself
// depending on who is reading. So a reference now stores the target's ID, which cannot drift.
//
// BOTH FORMS ARE READ, FOREVER. Every note already on every board stores a NUMBER, and the ledger
// is append-only — there is no rewrite pass and there must never be one. A number means "the note
// at that position in the frozen pre-id prefix", which is exactly what it meant when it was
// written, and that prefix cannot move.
const refKey = (ref) => {
  if (typeof ref === 'string') return ref;                     // an id: already stable
  const n = asSeq(ref);
  return n === undefined ? undefined : legacyId(n);            // legacy position -> its frozen id
};
// Callers hand us whatever the agent typed — usually the DISPLAY seq it just read ("--reply-to 127").
// Resolve that to the target's id at WRITE time, so what lands in the ledger is stable. Falls back
// to the raw value when the target cannot be found, so a reference to a not-yet-synced note is kept
// rather than dropped: better a dangling pointer we can still see than a silent deletion.
// The inverse, for DISPLAY: an id is what we store, a seq is what a human reads. Renders the
// LOCAL number of whatever a reference points at. Returns null when the target is not on this
// board yet (a reply that arrived before the note it answers — possible the instant a board is
// shared), so callers can say so instead of printing a raw id at a human.
function refSeq(all, ref) {
  const key = refKey(ref);
  if (!key) return null;
  const hit = all.find((n) => n.id === key);
  return hit ? hit.seq : null;
}
function resolveRef(board, ref, all) {
  if (ref === undefined || ref === null || ref === '') return undefined;
  if (typeof ref === 'string' && ref.includes(':')) return ref;  // already an id
  const seq = asSeq(ref);
  if (seq === undefined) return undefined;
  const hit = (all || allNotes(board)).find((n) => n.seq === seq);
  return hit ? hit.id : legacyId(seq);
}

// ---- origin: WHICH MACHINE wrote a note ---------------------------------------
// Machine-local and NEVER committed (.peer/.gitignore is "*"), so each clone keeps its own —
// which is the point: it is what makes two machines' notes distinguishable after a union merge.
// Generated once, then stable forever; if it is ever lost, notes written after simply belong to a
// new origin. That degrades cleanly (a cursor re-shows that origin's notes once) and never
// corrupts: an id already written into the ledger is immutable.
const originPath = (board) => path.join(board.planDir, 'origin.json');
// Per-machine fingerprint for the foreign-clone guard below. Node built-ins only (os.hostname +
// os.networkInterfaces), zero deps. ARC_MACHINE_ID overrides it — an operator escape hatch (and the
// test seam). Cached: os.networkInterfaces is a syscall and boardOrigin is on the append path.
let _machineFp;
function machineId() {
  const override = process.env.ARC_MACHINE_ID;
  if (override) return override;                          // explicit override — never cached
  if (_machineFp != null) return _machineFp;
  let host = ''; try { host = os.hostname() || ''; } catch {}
  const macs = [];
  try {
    const ifs = os.networkInterfaces();
    for (const name of Object.keys(ifs)) for (const ni of ifs[name] || []) {
      if (ni && !ni.internal && ni.mac && ni.mac !== '00:00:00:00:00:00') macs.push(ni.mac);
    }
  } catch {}
  _machineFp = `${host}|${[...new Set(macs)].sort().join(',')}`;
  return _machineFp;
}

// The origin id names THIS board's writer, and `ord` + the per-origin cursor assume ONE writer per
// origin. origin.json travels with an OUT-OF-BAND copy (VM/image clone, backup restore, raw folder
// copy — anything that bypasses arc export/import, which strips it), so two live machines then write
// under one origin; a per-origin cursor carried across the clone silently DROPS a genuinely-unread note
// (ord ambiguity across the merge — reproduced, F1). GUARD: stamp the writing machine into origin.json,
// and RE-MINT a fresh origin whenever the recorded fingerprint is not THIS machine — INCLUDING an
// un-fingerprinted (pre-fix) origin.json, since a clone taken before the source stamped `m` carries no
// fingerprint and is otherwise indistinguishable from a clone. Re-mint reuses the existing "lost origin
// degrades cleanly" path (audit #166): the clone becomes its own writer and per-origin ord/cursor stay
// honest. It touches ONLY future writes — every already-written note keeps its own id, so nothing is
// renumbered or lost — and it is invisible to export/import (origin.json is never staged). ACCEPTED
// COST (B, the operator's call): an `m`-less origin.json cannot be told apart from a legit pre-fix
// board, so EVERY board re-mints ONCE on its first post-deploy write — harmless (its past notes and
// their delivery are untouched; only future notes take the new origin). RESIDUAL kept honest: a
// golden-image/snapshot clone of an ALREADY-fingerprinted board preserves hostname+MAC, so its `m`
// matches and it still shares the origin (the same-fingerprint boundary — tested). ARC_MACHINE_ID pins
// a stable id if a flapping NIC/VPN fingerprint causes unwanted re-mint churn.
function boardOrigin(board) {
  const me = machineId();
  try {
    const rec = JSON.parse(fs.readFileSync(originPath(board), 'utf8'));
    if (rec.id && rec.m === me) return rec.id;           // ours — the recorded fingerprint is THIS machine
    // else: a DIFFERENT machine's fingerprint, OR none at all (pre-fix, possibly a clone) -> re-mint below
  } catch {}
  const id = crypto.randomBytes(4).toString('hex');
  try { ensureBoard(board); atomicWriteJson(originPath(board), { id, at: Date.now(), m: me }); } catch {}
  return id;
}
// LATENT EDGE — double-mint, NOT a bug (audit #166). Before origin.json exists, two concurrent
// FIRST-EVER appends can each mint a different origin id; last writer wins the file, but notes
// already appended keep whichever id their writer read. So the earliest notes could split across
// two origins. It does NOT break `ord` (each origin still counts its own subsequence cleanly) or
// the cursor (per-origin) — the board is just finer-grained than intended for its first few notes.
// First-append race only; every append after origin.json exists reads the one id.
// RANDOM, not a counter. See the design note at the top: reading the ledger to compute "last+1"
// is the collision the positional scheme existed to prevent, and it would come back the moment two
// local peers appended in the same tick. 48 random bits per note need no coordination at all.
function mintId(board) { return `${boardOrigin(board)}:${crypto.randomBytes(6).toString('hex')}`; }
// Notes written before ids existed: a FROZEN prefix (everything new carries an id), so their line
// position is stable and doubles as their identity. ZERO-PADDED because ids are compared as strings
// and "~:10" sorts before "~:2" — which would silently reorder the very prefix whose order the old
// numeric replyTo depends on. Width 6 outlives any realistic board.
const LEGACY_ORIGIN = '~';
const LEGACY_W = 6;
const legacyId = (pos) => `${LEGACY_ORIGIN}:${String(pos).padStart(LEGACY_W, '0')}`;
const noteOrigin = (n) => String(n.id || `${LEGACY_ORIGIN}:`).split(':')[0];

// ---- a note body is UNTRUSTED INPUT, sanitised where it is WRITTEN --------------------------------
// The board's writers read the internet. `research` reads external repos by duty and then posts what
// it found here, so "machine-local" is not the trust boundary it sounds like: text can travel from a
// web page into a note body without a human ever looking at it. Delivery renders a body with
// indentation and nothing else (arc-notes.js:1049), so anything the body contains is shown inside
// arc's own framing — and a body is free to contain a line that looks exactly like arc's framing.
//
// Sanitising at WRITE time, not at render time, is deliberate: the ledger is append-only and read by
// several surfaces (injection, `arc notes`, the feed, arc-scope), and a rule enforced at one renderer
// is a rule the next renderer forgets. Fix the bytes once, at the only door in.
//
// What goes: C0/C1 control characters (a bare ESC/CR can rewrite a terminal line, and NUL truncates
// a C string) and Unicode BIDI overrides (U+202A-202E, U+2066-2069), which can visually reorder text
// so what a human reads is not what is stored. TAB and NEWLINE stay — they are ordinary formatting.
// Nothing is REJECTED: a peer's report must never be lost because it quoted a hostile byte, so the
// characters are dropped and the note still lands. (Prior art: ECC's hasUnsafeControlCharacters,
// routed by research 2026-07-27 — arc strips where ECC refuses, because a dropped note is worse.)
function sanitizeBody(text) {
  let out = '';
  for (const ch of String(text == null ? '' : text)) {
    const c = ch.codePointAt(0);
    if (c === 9 || c === 10) { out += ch; continue; }   // TAB / LF: ordinary formatting, kept
    if (c <= 0x1F || (c >= 0x7F && c <= 0x9F)) continue;  // C0 controls, DEL, C1 controls
    if (c >= 0x202A && c <= 0x202E) continue;             // bidi embeddings + overrides
    if (c >= 0x2066 && c <= 0x2069) continue;             // bidi isolates
    out += ch;
  }
  return out;
}

// THE HEADLINE, AND WHO IT IS FOR. A note's body is written for the PEER, who reads all of it. This
// field is written for the OPERATOR, who does not: measured on two real boards, 45 notes/day at a
// ~2,700-char median is ~120 KB/day of prose, and no human audits that. A one-line title makes the
// ledger scannable without shortening a single note — the peer loses nothing.
//
// DERIVED WHEN OMITTED, because the agents are already writing one. Real leads from the whalephone
// board: "ROW 3 IS DONE AND MEASURED — see my crossing note…", "CONSUMED — the collector reads…".
// They invent the convention and then run on, because there is no slot to stop at. So take the lead
// they already wrote: cut at the em dash / colon they already use as the boundary.
//
// TRUNCATE, NEVER REJECT. Claude Code shipped the strict version of exactly this field and had to
// undo it (v2.1.211: "Fixed SendMessage rejecting a long summary — it now truncates instead, so
// sends no longer fail on a character limit"). A note that fails to post is worse than an ugly title.
const TITLE_MAX = 72;
// Below this a boundary cut is a LABEL, not a headline: "✓ done" / "committed" duplicate the `kind`
// field and say nothing about WHAT. Measured, the floor is the dominant path (59%/56% of notes) and
// exempting known lead words would regress ~233 notes into bare labels (audit #495 item 4a).
const MIN_TITLE = 24;
function noteTitle(explicit, body) {
  // A STRING OR NOTHING. Coercing whatever arrives persisted "0", "false", "[object Object]" and
  // "a,b" into an append-only ledger — 0 and false must fall through to derivation, and an object
  // must never be stringified into a stored field (audit #495 D7).
  let t = typeof explicit === 'string' ? explicit.trim() : '';
  if (!t) {
    const lead = String(body == null ? '' : body).split('\n').find((l) => l.trim()) || '';
    t = lead.replace(/[*`_#>]/g, '').trim();
    // the author's own boundary: "<headline> — <detail>" / "<headline>: <detail>". Keep it ONLY when
    // it still says something: real leads include "CONSUMED —" and "COMMITTED —", and a list row
    // reading "CONSUMED" tells the operator nothing about WHAT. Below MIN_TITLE the boundary is a
    // label rather than a headline, so fall through and let the truncation carry more of the line.
    const m = t.match(/^(.{4,}?)(?:\s+[—–-]+\s+|[.;:]\s+)/);
    if (m && m[1].trim().length >= MIN_TITLE) t = m[1];
  }
  t = sanitizeBody(t).replace(/\s+/g, ' ').trim();      // untrusted when explicit, same as the body
  if (!t) return undefined;                              // a bodiless note needs no headline
  if (t.length <= TITLE_MAX) return t;
  // CUT AT A WORD BOUNDARY, never mid-token. Measured over 1,797 real notes on two boards: a hard
  // slice left 37% of headlines truncated mid-word; backing up to the last space drops that to 0%
  // for an average of five characters (audit #495). clipBody two files over already does this, for
  // the reason it states — "cutting inside a token makes the last thing it sees a lie". This also
  // removes the only path that could persist a LONE SURROGATE: slicing by UTF-16 code unit can
  // split an emoji in half, and the ledger is append-only, so a malformed pair would be forever.
  const cut = t.slice(0, TITLE_MAX - 1);
  const sp = cut.lastIndexOf(' ');
  const kept = (sp >= MIN_TITLE ? cut.slice(0, sp) : cut).trimEnd();
  return kept + '…';
}

function appendNote(board, note) {
  ensureBoard(board);
  const rec = {
    id: mintId(board),                           // stable identity — survives any merge or reorder
    ts: new Date().toISOString(),
    from: String(note.from || 'unknown'),
    title: noteTitle(note.title, note.body),     // the OPERATOR's skim line; see noteTitle
    to: note.to == null ? null                                         // null = broadcast to the whole flat
      : (Array.isArray(note.to) ? note.to.map(String) : String(note.to)),   // one role, or a specific subset (array)
    kind: normalizeKind(note.kind),
    priority: note.priority === 'high' ? 'high' : 'normal',
    body: sanitizeBody(note.body),               // untrusted input — see sanitizeBody
    replyTo: resolveRef(board, note.replyTo),        // this note ANSWERS that note (a thread)
    supersedes: resolveRef(board, note.supersedes),  // this note RETRACTS/replaces that note
    refs: note.refs && typeof note.refs === 'object' ? note.refs : undefined, // {sha, files, tests}
  };
  // A correction/result almost always names its target; if the caller gave one but no kind,
  // infer the obvious one rather than filing a retraction as routine news.
  //
  // A CONTRACT THREAD STAYS A CONTRACT THREAD. Answering a contract clause IS a clause, so it
  // inherits `contract` rather than becoming a `result`. Caught on the shipping surface, not in a
  // module test: replying the natural way — `arc note backend --reply-to 12 "I expose POST /x"`,
  // with no --kind — filed the clause as a `result`, so it dropped out of the contract's own
  // accounting and the read said "2 clauses" over a thread of three. Requiring every clause to
  // restate --kind would be a rule enforced by memory, and memory is what measures ~93% here.
  if (!note.kind) {
    const parentRef = rec.replyTo || rec.supersedes;
    let parentKind = null;
    if (parentRef) {
      try {
        const key = refKey(parentRef);
        const p = allNotes(board).find((n) => n.id === key || refKey(n.id) === key);
        parentKind = p ? (p.kind || DEFAULT_KIND) : null;
      } catch { /* inference must never break a post */ }
    }
    if (parentKind === 'contract') rec.kind = 'contract';
    else if (rec.supersedes) rec.kind = 'correction';
    else if (rec.replyTo) rec.kind = 'result';
  }
  // An alarm or a retraction is high-priority by nature — don't make callers remember.
  if (rec.kind === 'alarm' || rec.kind === 'correction') rec.priority = 'high';
  // A CONTRACT CLAUSE THAT RETRACTS ANOTHER IS ALSO HIGH. Keeping the thread coherent (above) costs
  // the auto-HIGH a `correction` would have carried — and a revised clause is precisely the note a
  // peer must not miss, because it is already building against the version being withdrawn. So the
  // urgency is restored explicitly: a contract note that supersedes something changes an agreement,
  // and that outranks routine news whatever it is called.
  if (rec.kind === 'contract' && rec.supersedes) rec.priority = 'high';
  for (const k of Object.keys(rec)) if (rec[k] === undefined) delete rec[k];
  // HEAL A TORN TAIL FIRST, or this append destroys someone else's note rather than its own.
  // O_APPEND is atomic between CONCURRENT WRITERS; it says nothing about a process that DIES
  // mid-write. That leaves a fragment with no trailing newline — and the ledger already expects
  // one (allNotes carries an explicit "skip a torn line"). What it did not do was heal it: the next
  // note was glued onto the fragment, the two became ONE unparseable line, and the skip then
  // discarded BOTH. The note lost that way is the HEALTHY one, belonging to a caller who was told
  // the post succeeded. Cost of the bug: one good note, silently, permanently. Cost of the fix:
  // reading one byte.
  //
  // STILL EXACTLY ONE appendFileSync — the newline rides the same call as the record, because two
  // appends would surrender the cross-process atomicity this line is built on and trade a
  // crash-window for a race that happens far more often.
  //
  // The read-then-append IS itself racy (two writers can both see a torn tail and both prepend),
  // and that is deliberately fine: the worst outcome is a blank line between two records, which
  // allNotes discards at `if (!line.trim()) return`. A harmless empty line is the correct thing to
  // lose a race to.
  const notes = notesPath(board);
  let heal = '';
  try {
    const size = fs.statSync(notes).size;
    if (size > 0) {
      const fd = fs.openSync(notes, 'r');
      try {
        const last = Buffer.alloc(1);
        fs.readSync(fd, last, 0, 1, size - 1);
        if (last[0] !== 0x0A) heal = '\n';
      } finally { fs.closeSync(fd); }
    }
  } catch { /* unreadable/absent — append plain; a missing heal is the old behaviour, never worse */ }
  // Single-line O_APPEND: atomic between processes on one filesystem.
  fs.appendFileSync(notes, heal + JSON.stringify(rec) + '\n');
  return rec;
}

// seq -> the note that RETRACTED it (or undefined). Derived from the ledger, so it cannot lie
// and needs no back-writing: history stays append-only.
// Keyed by the target's ID, never its position — a retraction must keep retracting the same note
// after a merge reorders the ledger. Callers look up by `note.id`.
function supersededMap(board, all) {
  const notes = all || allNotes(board);
  const m = new Map();
  for (const n of notes) if (n.supersedes) m.set(refKey(n.supersedes), n);   // last writer wins
  return m;
}

// ---- CONTRACTS, DERIVED — never a stored "closed" flag -------------------------------------------
// A contract is not a file class, it is a THREAD: an opener of kind `contract` plus every note that
// replies to (or supersedes) it. Two things about it are already true in the ledger and this function
// only reads them out — it invents no field, so there is nothing that can drift out of date. That is
// deliberate: a DECLARED "closed" flag would be a fact with two homes (the flag and the clauses), and
// a stale flag is worse than no flag because it is trusted. Derived fails visibly and can be
// asserted against the notes it came from.
//
// WHO IS BOUND is the OPENER'S recipient list, and it changes only by SUPERSEDING the opener — the
// same rule `arc notes --thread` prints, and for the reason recorded there: inferring membership from
// the newest clause reads a reply addressed to the other party as the whole membership, and silently
// drops a role from its own contract.
//
// WHAT "UNCLOSED" MEANS: a bound role that has not yet DECLARED ITS OWN HALF. The peers skill states
// the protocol — "each side then declares ONLY ITS OWN half" — so a seam is settled exactly when
// every bound role has a live clause in the thread, and open while anyone is still owed.
// A RETRACTED CLAUSE RE-OPENS IT, which is the point rather than an edge case: withdrawing your half
// means the other side is building against something you have taken back, and that has to be visible.
function contracts(board, allIn, supIn) {
  const all = allIn || allNotes(board);
  const sup = supIn || supersededMap(board, all);
  const byId = new Map(all.map((n) => [n.id, n]));
  const recipients = (n) => (n.to == null ? [] : (Array.isArray(n.to) ? n.to.slice() : [String(n.to)]));

  // A thread's root: walk `replyTo || supersedes` — supersedes IS a thread edge, because the
  // documented way to retract a clause is `--supersedes` with no `--reply-to`, and treating that as
  // a new root ejects the amendment from the contract it amends.
  const memo = new Map();
  const rootOf = (n) => {
    if (memo.has(n.id)) return memo.get(n.id);
    memo.set(n.id, n);                                  // provisional — also breaks a reference cycle
    const ref = n.replyTo || n.supersedes;
    if (!ref) return n;
    const key = refKey(ref);
    const up = byId.get(key) || all.find((x) => refKey(x.id) === key || String(x.seq) === String(ref));
    if (!up || up.id === n.id) return n;
    const r = rootOf(up);
    memo.set(n.id, r);
    return r;
  };

  const groups = new Map();
  for (const n of all) {
    const root = rootOf(n);
    if ((root.kind || 'info') !== 'contract') continue;   // only a contract THREAD counts
    if (!groups.has(root.id)) groups.set(root.id, { root, clauses: [] });
    groups.get(root.id).clauses.push(n);
  }

  return [...groups.values()].map(({ root, clauses }) => {
    // THE TIE-BREAK IS A FUNCTION OF CONTENT, NEVER OF LEDGER POSITION. This walk used `.find()`,
    // which takes the first match in ledger order — and ledger order is MERGE order, so two clones
    // that each amended the same opener would compute different memberships from the same notes.
    // That is reasoning by position, which this file forbids everywhere else ("a note's identity is
    // its stable id, NEVER its line").
    // `ord` is NOT a candidate: it is per-origin, so origin A's ord 5 against origin B's ord 5 is not
    // a comparison at all. `ts` travels inside the note, so every clone sees the same values — clock
    // skew can still pick the wrong winner, but it picks the SAME wrong winner everywhere, and
    // agreeing-and-wrong beats diverging. `id` is the deterministic backstop for an exact ts tie.
    // TWO amendments to one opener is a genuine disagreement between two humans' clones, so it is
    // REPORTED as well as resolved — resolving silently would hide the one thing worth knowing.
    let memberSrc = root;
    const conflicts = [];
    for (let hops = 0; hops < 64; hops++) {              // bounded: a cycle must not hang a render
      const cands = clauses.filter((n) => n.supersedes && refKey(n.supersedes) === memberSrc.id);
      if (!cands.length) break;
      if (cands.length > 1) {
        cands.sort((a, b) => (Date.parse(a.ts) || 0) - (Date.parse(b.ts) || 0)
          || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
        conflicts.push({ of: memberSrc.seq, by: cands.map((n) => n.seq) });
      }
      memberSrc = cands[cands.length - 1];               // newest by ts, id as the exact-tie backstop
    }
    // WITHDRAWN — the one way out of a contract, and it did not exist until a real board needed it.
    // Superseding the OPENER is how membership changes, so it cannot also mean "withdraw"; that is the
    // usual byte-identical problem. But the KIND of the superseding note is a real signal already in
    // the ledger and it says exactly the right thing:
    //     superseded by a `contract` note   -> AMENDED. The replacement IS the new opener.
    //     superseded by a `correction`      -> WITHDRAWN. "I was wrong that this is a seam."
    // Without this a contract is PERMANENT: retracting the opener the documented way left it listed
    // and still open, and the contract-kind form even added a reply, so a never-answered announcement
    // started reading as a live negotiation. Verified in a sandbox before this was written, because
    // the fix I was about to ship instead was to tell four agents to run a command that does nothing.
    // ⚠ WITHDRAWN IS LISTED, NOT DROPPED — and the reason is that this diff had already answered the
    // same question the other way ten lines below. `contractStrays` REPORTS a group that is not a
    // live contract rather than removing it from the count; returning null here made a withdrawn one
    // VANISH. Two policies for one question ("what do we do with a group that is no longer a live
    // contract") is precisely how the `--kind contract` / `--thread` disagreement this file exists to
    // fix got created. audit's ruling, and it is right: a withdrawal is MORE interesting than a
    // misfiled note — somebody deliberately closed a seam, and "why is it gone" is the question a
    // reader will actually have. It also fixes a live nonsense: with the group gone, its own clauses
    // failed the stray lookup and were reported as misfiled (4 of 8 on a real board).
    const withdrawn = (memberSrc.kind || 'info') !== 'contract';
    const members = recipients(memberSrc);
    const live = clauses.filter((n) => !sup.get(n.id));
    // The opener is the ASK, not a declaration — its author has not thereby declared a half. Only a
    // clause does, and only a live one.
    const declared = new Set(live.filter((n) => n.id !== root.id).map((n) => n.from));
    const awaiting = members.filter((r) => !declared.has(r));
    return {
      id: root.id, seq: root.seq, from: root.from, ts: root.ts, body: String(root.body || ''),
      members, declared: members.filter((r) => declared.has(r)), awaiting,
      clauses: clauses.length, retracted: clauses.length - live.length,
      // REPLIES SEPARATE "A SEAM BEING NEGOTIATED" FROM "A POST NOBODY ANSWERED", and the difference
      // is not cosmetic — it is the difference between a true and a false statement. `awaiting` says
      // a role owes a half, which is only meaningful if the thread is a seam at all. Measured on a
      // live board: of 4 open contracts, THREE had zero replies at 42h, 186h and 238h — they are
      // announcements posted with `--kind contract`, and calling them "awaiting uiux" asserts a debt
      // nobody ever incurred. With replies>0 someone has engaged and the debt is real.
      // Deliberately NOT a guess at intent: an announcement and an ignored seam are byte-identical,
      // exactly like the clause-vs-new-contract case this file refuses to guess. Age plus silence is
      // reported; the reader draws the conclusion.
      replies: clauses.length - 1,
      // A withdrawn seam owes nobody anything — it is not open, whoever had not declared a half.
      withdrawn, open: !withdrawn && awaiting.length > 0,
      // two amendments to one opener: resolved above (newest ts, id as backstop) AND reported here,
      // because a fork like that is two clones disagreeing, not a detail
      conflicts,
    };
  }).sort((a, b) => b.seq - a.seq);
}

// A `contract` note whose THREAD ROOT is not a contract — someone meant to declare a clause and
// filed it under an ordinary note. Reported rather than dropped, because the two reads of this board
// disagreed about them for real: `arc notes --kind contract` counted their root as a contract (it
// grouped by "root of every contract-kind note", whatever that root turned out to be) while
// `arc notes --thread` REFUSED to open the same row — "#514 is not a contract — it is an <info>".
// Nine listed, seven openable, and nothing said which two or why. Measured on a live board: 2 of 9,
// and one of them is a cmd.exe truncation artifact whose body is a mangled command line, so this is
// a real data problem an operator should see and not a hypothetical.
// The `--thread` rule is the correct one — a contract thread is rooted at a contract — so that is
// what `contracts()` returns, and these are handed back separately so nobody has to choose between
// a wrong count and a silent drop.
function contractStrays(board, allIn) {
  const all = allIn || allNotes(board);
  const roots = new Map(contracts(board, all).map((c) => [c.id, true]));
  const byId = new Map(all.map((n) => [n.id, n]));
  const seenGuard = new Set();
  const rootIdOf = (n) => {
    let cur = n; seenGuard.clear();
    for (let hops = 0; hops < 256; hops++) {
      const ref = cur.replyTo || cur.supersedes;
      if (!ref || seenGuard.has(cur.id)) break;
      seenGuard.add(cur.id);
      const key = refKey(ref);
      const up = byId.get(key) || all.find((x) => refKey(x.id) === key || String(x.seq) === String(ref));
      if (!up || up.id === cur.id) break;
      cur = up;
    }
    return cur;
  };
  return all.filter((n) => (n.kind || 'info') === 'contract')
    .map((n) => ({ note: n, root: rootIdOf(n) }))
    .filter(({ note, root }) => root.id !== note.id && !roots.has(root.id))
    .map(({ note, root }) => ({ seq: note.seq, from: note.from, rootSeq: root.seq, rootKind: root.kind || 'info' }));
}

// A `request` with no `result`/`correction` replying to it: asked, and never answered. This is
// the thing that used to scroll silently away.
//
// A RETRACTED REQUEST IS NOT OWED. `--supersedes` is how a sender says "never mind", and the board
// already tells every reader not to act on the note it retracts — so billing the recipient for an
// answer to it creates a debt that CANNOT be paid: the only way to clear it would be to reply to a
// note nobody is allowed to act on. Found by using it: a request I retracted the moment I realised
// it was unanswerable (I had told the peer not to reply) kept showing as owed anyway.
// A note's recipient is a single role (string), a SPECIFIC SUBSET (array, addressed to each), or
// broadcast (null, everyone). This is the one place that knows "is this directed at <role>" — used
// by delivery, receipts, and the request tracker so all three agree on who a multi-recipient note is for.
const toHas = (to, role) => Array.isArray(to) ? to.includes(role) : to === role;

function openRequests(board, role) {
  const all = allNotes(board);
  const retracted = supersededMap(board, all);
  // WHO has replied to each request (request-id → set of replier roles). A single/broadcast request
  // closes on ANY reply (unchanged). A MULTI-recipient request is owed-by-each: it stays open until
  // every recipient SOMEONE HOLDS has replied. An empty chair is excluded (waiting on a role nobody
  // holds is infinite); a deaf-but-held one still counts — it can answer once woken, and the sender
  // sees via receipts that it has not, then drops it by choice. "Wait for all who can answer."
  const repliers = new Map();
  for (const n of all) if (n.replyTo) { const k = refKey(n.replyTo); if (!repliers.has(k)) repliers.set(k, new Set()); repliers.get(k).add(n.from); }
  let live = null;   // lazily built: only a multi-recipient request needs the live roster
  const answered = (n) => {
    const who = repliers.get(n.id) || new Set();
    if (!Array.isArray(n.to)) return who.size > 0;
    if (!live) live = new Set(liveRoles(board).map((l) => l.role));
    const expected = n.to.filter((r) => live.has(r));
    return expected.length > 0 && expected.every((r) => who.has(r));
  };
  return all.filter((n) => n.kind === 'request' && !answered(n) && !retracted.has(n.id)
    && (!role || n.from === role || n.to == null || toHas(n.to, role)));
}

// ---- receipts: has a note's recipient SEEN it --------------------------------
// A receipt with NO note and NO state of its own — derived purely from each recipient's read
// cursor, the exact inverse of unreadFor's filter (n.ord > cursor = unread ⇒ n.ord <= cursor =
// seen). "Seen" is the mail-signature sense: the note was DELIVERED into that role's context
// (their cursor passed it), NOT read-and-agreed. This is what lets a RESULT be terminal — the
// sender can see it landed, so a content-free "received" acknowledgement (a whole extra note, and
// a WAKE if they were idle) is never needed. Returns { recipients, seen }:
//   DIRECTED (to a role): recipients = [that role] — one addressee signs for it.
//   BROADCAST (to == null): recipients = the LIVE peers (minus the sender) — an announcer can ask
//     "did everyone get it?" and read `seen.length` of `recipients.length`, and who is missing.
//     A closed chair is not counted: nobody is there to read, so it would be a permanent "unseen".
function seenBy(board, note, all) {
  if (!note) return { recipients: [], seen: [] };
  const notes = all || allNotes(board);
  const n = notes.find((x) => x.id === note.id) || note;   // ensure per-origin ord + origin are present
  const recipients = note.to == null
    ? liveRoles(board).map((l) => l.role).filter((r) => r !== note.from)   // broadcast → the live peers
    : (Array.isArray(note.to) ? note.to : [note.to]);                      // directed (one) or a subset (many)
  const hasSeen = (role) => n.ord != null && n.ord <= ((readCursorMap(board, role, notes)[noteOrigin(n)]) || 0);
  return { recipients, seen: recipients.filter(hasSeen) };
}

// Per-recipient status of a request I sent: [{ role, seen, replied }] for each addressee. This is
// what makes wait-for-all safe rather than a blind hang — the sender can SEE that one recipient has
// not even seen the note (deaf) while another has replied, and decide to proceed without the absent one.
function requestStatus(board, note, all) {
  const notes = all || allNotes(board);
  const recipients = Array.isArray(note.to) ? note.to : (note.to != null ? [note.to] : []);
  const seen = new Set(seenBy(board, note, notes).seen);
  const replied = new Set(notes.filter((n) => n.replyTo && refKey(n.replyTo) === note.id).map((n) => n.from));
  return recipients.map((r) => ({ role: r, seen: seen.has(r), replied: replied.has(r) }));
}

// Every note answering `ref`, oldest first — the thread under a request. Takes a display seq (what
// a human types) or an id; both resolve to the same thread.
function repliesTo(board, ref, all) {
  const notes = all || allNotes(board);
  const target = typeof ref === 'string' && ref.includes(':') ? ref : (notes.find((n) => n.seq === asSeq(ref)) || {}).id;
  return target ? notes.filter((n) => n.replyTo && refKey(n.replyTo) === target) : [];
}

// `seq` stays exactly what it was: the note's PHYSICAL line number. It is the number a human reads
// and types, and it is LOCAL — after a merge the same note sits at a different line on each machine,
// so seq is a display index and NOTHING may reference a note by it across machines. That is what
// `id` is for. (Deliberately NOT re-sorted into a machine-independent order: seq is the physical
// position on purpose — a torn line must leave its gap so the cursor can advance past it exactly
// once — and a stable display number buys nothing once references are ids.)
// The one addition: notes written before ids get a synthetic one. They are a FROZEN set (everything
// new carries an id), so their position cannot move and "~:<pos>" maps 1:1 onto the numeric replyTo
// they already carry.
function allNotes(board) {
  let raw; try { raw = fs.readFileSync(notesPath(board), 'utf8'); } catch { return []; }
  const out = [];
  let legacy = 0;
  const ord = {};
  raw.split('\n').forEach((line, i) => {
    if (!line.trim()) return;
    let n; try { n = JSON.parse(line); } catch { return; }        // skip a torn line
    if (!n.id) n.id = legacyId(++legacy);                         // frozen prefix -> stable synthetic id
    // A RENAMED KIND IS NORMALISED ON READ, not rewritten on disk. The ledger is append-only, so the
    // old spelling stays in the bytes forever — but every consumer must see the new one, because they
    // key off it: arc-notes.js ranks with `KIND_RANK[n.kind] ?? 5`, so an un-normalised `decision`
    // scores 5 (routine news) instead of 2, and a clause binding two roles would sort below chatter.
    // Normalising here fixes ranking, filtering and display in one place, and rewrites nothing.
    if (n.kind && KIND_ALIASES[String(n.kind).toLowerCase()]) n.kind = KIND_ALIASES[String(n.kind).toLowerCase()];
    const org = noteOrigin(n);
    // ORD: this note's index among ITS OWN origin's notes, counted at READ time. The same trick the
    // positional design already relies on, narrowed to the one scope where it still holds: a
    // position across writers is an accident, but a position WITHIN one writer's stream is that
    // writer's own append order, and git's union merge concatenates each side's lines without
    // reordering them — so every machine counts the same ordinal for the same note. This is what
    // the cursor advances on. It needs no counter at write time (that race is why seq is positional
    // at all) and, unlike a timestamp, it cannot tie: notes written in the same millisecond still
    // have distinct ordinals. BOUNDARY (audit #166): ord assumes an origin's line order never
    // changes — union-append preserves it, but a `git rebase` of a SHARED ledger would not. Out of
    // scope by design: .peer/ self-ignores, so the ledger never enters a rebased branch in normal
    // flow. If that ever changes, ord's monotonicity across the rewrite is not guaranteed.
    // SPREAD FIRST — the computed fields MUST win. With `...n` last, a ledger line carrying its own
    // "seq" (or "ord") overrode the position arc computed here, and neither is cosmetic: seq reaches
    // the feed's HTML unescaped, and ord is what a read cursor advances on. appendNote cannot emit
    // either (it whitelists fields), but `arc import` merges archive lines VERBATIM — so this is the
    // door an archive came through.
    out.push({ ...n, seq: i + 1, ord: (ord[org] = (ord[org] || 0) + 1) });
  });
  return out;
}

function noteCount(board) { return allNotes(board).length; }

// Highest physical record position, including a torn line. Cursors are positions
// in the append-only file, not counts of successfully parsed notes.
function latestSeq(board) {
  let raw; try { raw = fs.readFileSync(notesPath(board), 'utf8'); } catch { return 0; }
  let latest = 0;
  raw.split('\n').forEach((line, i) => { if (line.trim()) latest = i + 1; });
  return latest;
}

// ---- cursors (rd()-only: nothing is consumed, the cursor just advances) --------
// Keyed by ROLE, not session id — a restarted terminal gets a new session id but is
// still "coding in this board", and must resume where it left off, not re-read all.
// A CURSOR CANNOT BE A POSITION ON A SHARED BOARD. "I have read 5 notes" is a claim about MY line
// order, and the other machine's notes interleave by timestamp — so a note that arrives from the
// office bearing an OLDER ts sorts BEHIND a home cursor and is marked read having never been shown.
// Silent, and the exact failure the whole rd()-only design exists to prevent. So the cursor is a
// HIGH-WATER PER ORIGIN: "everything origin X wrote up to here". An origin's own notes are appended
// in ts order on its own machine, so (ts,id) is monotonic within an origin, and nothing another
// machine does can move it. `seq` is still recorded — for the fail-open check below, and because a
// human debugging a cursor wants the number they saw.
const noteKey = (n) => n.ord;                      // ordinal WITHIN its origin — see allNotes
function highWater(notes) {
  const o = {};
  for (const n of notes) {
    const org = noteOrigin(n);
    if (!o[org] || n.ord > o[org]) o[org] = n.ord;
  }
  return o;
}
function readCursor(board, role) {                 // legacy scalar view — kept for callers/tests
  try { return JSON.parse(fs.readFileSync(cursorPath(board, role), 'utf8')).seq || 0; }
  catch { return 0; }
}
function readCursorMap(board, role, all) {
  let rec; try { rec = JSON.parse(fs.readFileSync(cursorPath(board, role), 'utf8')); } catch { return {}; }
  // FAIL-OPEN, unchanged in spirit: a cursor past the end means the ledger was truncated or
  // rewritten (it is supposed to be append-only). Re-read from the start rather than silently
  // skipping — a duplicate note is noise; a missed one is the bug this design exists to prevent.
  if (rec.seq && rec.seq > latestSeq(board)) return {};
  if (rec.o && typeof rec.o === 'object') return rec.o;
  // A cursor written before origins existed: "I read the first N". Every note it covers is from the
  // frozen prefix, so its high-water converts exactly.
  return highWater((all || allNotes(board)).filter((n) => n.seq <= (rec.seq || 0)));
}
function writeCursor(board, role, seq) {
  ensureBoard(board);
  const covered = allNotes(board).filter((n) => n.seq <= seq);
  const rec = { o: highWater(covered), seq, at: Date.now() };
  // preserve a fresh-claim broadcast floor across markRead: it is set ONCE (at claim) and must survive
  // every later cursor advance, or the first markRead would erase it and re-expose the old broadcasts.
  try { const f = JSON.parse(fs.readFileSync(cursorPath(board, role), 'utf8')).bfloor; if (f && typeof f === 'object') rec.bfloor = f; } catch {}
  atomicWriteJson(cursorPath(board, role), rec);
  return seq;
}

// ---- atomic state writes + a claim lock ---------------------------------------
// A claim or cursor written with a bare writeFileSync can be TORN by a crash mid-write,
// and a check-then-write claim lets TWO sessions both "win" the same role — after which
// they share a cursor and silently eat each other's notes (the exact failure this whole
// design exists to prevent). So: every state write is tmp -> fsync -> rename, and the
// claim's check+write runs under an atomic lock.
function sleepSync(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch {}
}

function atomicWriteJson(file, obj) {
  const tmp = `${file}.tmp-${process.pid}`;
  const fd = fs.openSync(tmp, 'w');
  try { fs.writeSync(fd, JSON.stringify(obj)); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);            // atomic within one filesystem
}

// mkdir is atomic on Windows AND POSIX — the portable lock. A crashed holder must never
// wedge the board, so a lock older than LOCK_STALE_MS is broken rather than waited on.
const LOCK_STALE_MS = 10_000;
function withLock(board, name, fn) {
  const lock = path.join(board.planDir, `.lock-${name}`);
  const deadline = Date.now() + 3000;
  for (;;) {
    try { fs.mkdirSync(lock); break; }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try { if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) { fs.rmdirSync(lock); continue; } } catch {}
      if (Date.now() > deadline) throw new Error(`role state is locked by another session (${name})`);
      sleepSync(25);
    }
  }
  try { return fn(); } finally { try { fs.rmdirSync(lock); } catch {} }
}

// The BROADCAST FLOOR of a fresh claim ({origin: ord}, or {}). A brand-new role would otherwise inherit
// every `to: all` broadcast ever posted — the note-dump on first claim. The floor marks that backlog
// pre-read for BROADCASTS ONLY. Directed notes carry no floor, so a note ADDRESSED to the role (an
// `arc delegate` packet, or one left for an empty chair) still delivers in full — the documented "a
// fresh claim inherits its chair's directed notes" feature (arc-notes:501) is untouched. Fail-open to
// {} (no floor) so a torn/absent cursor never SUPPRESSES a note — a duplicate is noise, a miss is the bug.
function readFloor(board, role) {
  try { const f = JSON.parse(fs.readFileSync(cursorPath(board, role), 'utf8')).bfloor; return (f && typeof f === 'object') ? f : {}; }
  catch { return {}; }
}

// What `role` hasn't seen: addressed to it, or broadcast; never its own notes.
function unreadFor(board, role) {
  const all = allNotes(board);
  const latest = latestSeq(board);
  const cur = readCursorMap(board, role, all);      // per-origin read high-water (fail-open handled inside)
  const cursor = readCursor(board, role);           // reported for debugging, never used to filter
  const floor = readFloor(board, role);             // fresh-claim broadcast floor — broadcasts only
  const notes = all.filter((n) => {
    if (n.from === role || n.ord <= (cur[noteOrigin(n)] || 0)) return false;   // own note, or already read
    return n.to == null
      ? n.ord > (floor[noteOrigin(n)] || 0)          // broadcast: also skip the pre-claim `to: all` backlog
      : toHas(n.to, role);                            // directed: unfloored — delivered in full until read
  });
  const senders = [...new Set(notes.map((n) => n.from))];
  return { cursor, count: notes.length, notes, senders, latest, total: all.length };
}

// Advance past everything currently in the ledger (called after injection).
function markRead(board, role) { return writeCursor(board, role, latestSeq(board)); }

// ---- role claim --------------------------------------------------------------
// Cursors are keyed by role, so TWO live "coding" sessions in one board would share
// a cursor and steal each other's notes. At most one live holder per (board, role).
function isAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

// ---- A PID IS NOT AN IDENTITY -------------------------------------------------
// isAlive() answers "does SOME process have this pid?", never "is it the one that wrote this
// claim?". Windows recycles pids, and arc spawns a node process for EVERY hook — so the collision
// is not theoretical. Caught on the whalephone board: the `research` claim (pid 9512) read
// dead → LIVE → dead across three probes minutes apart, with the session closed the whole time.
// A stranger had taken its pid. A dead process cannot resurrect; that flicker IS the proof.
//
// What believing it costs: `arc delegate research "…"` posts a note into a chair nobody is in and
// nobody ever answers, staffRole refuses to revive ("already held by a LIVE session"), and the
// empty-chair warning never fires. The role becomes unfillable — the exact failure the whole
// live/closed distinction exists to prevent.
//
// THE RULE, and it needs no new field: a claim is genuine only if its process started BEFORE the
// claim was written. A recycled pid always starts AFTER the claim it inherited.
//     android: process started 10:54:21, claim written 10:54:29  → genuine.
//
// THE COST, measured before choosing (this runs on the per-turn path):
//   • process.kill is 0ms and has no false NEGATIVE — a genuinely dead pid is settled for FREE,
//     with no query at all. That is the overwhelmingly common case.
//   • Only a live-LOOKING pid needs the OS. One powershell spawn is ~270ms, and ~270ms is its
//     STARTUP: asking about 3 pids costs the same as asking about 1. So we batch.
//   • A short disk cache then amortises it to ~0 across the many short-lived hook processes.
// Bounded lie: ≤ PIDSTART_TTL, instead of forever.
const PIDSTART_CACHE = path.join(os.homedir(), '.claude', 'cache', 'arc-pidstart.json');
const PIDSTART_TTL = 30000;
const FILETIME_EPOCH = 11644473600000;   // ms from 1601-01-01 (FILETIME) to 1970-01-01 (unix)
const CLAIM_SKEW_MS = 2000;              // absorb rounding only; a recycled pid is off by hours
// Printed LAST by the probe. Its presence is what proves the enumeration RAN — the exit code
// cannot, because SilentlyContinue still exits 1 when any pid in the batch has died.
const PROBE_OK = 'arc-probe-ok';
let pidStartMemo = null;                 // per-process memo, so one hook run pays at most once

// pid -> start time (epoch ms), null if no such process. Returns null ENTIRELY if the OS cannot
// be asked — the caller must then FAIL OPEN, never invent a verdict.
// opts.fresh — re-probe the asked pids even when their cache entries are warm. The warm cache is
// itself one of isHolder's two fail-open windows (a dead predecessor's start served for ≤30s), so
// a caller for whom a false "live" is expensive (the delegate path) passes fresh to bypass exactly
// the thing being doubted. The fresh answer still writes through to the memo + disk cache, so
// every later check in the same flow agrees with it.
function procStarts(pids, opts) {
  const fresh = !!(opts && opts.fresh);
  const want = [...new Set(pids.map(Number).filter(Boolean))];
  if (!want.length) return {};
  if (!pidStartMemo) {
    try { pidStartMemo = JSON.parse(fs.readFileSync(PIDSTART_CACHE, 'utf8')) || {}; } catch { pidStartMemo = {}; }
  }
  const now = Date.now();
  const need = want.filter((p) => {
    if (fresh) return true;
    const e = pidStartMemo[p];
    return !e || typeof e.at !== 'number' || now - e.at > PIDSTART_TTL;
  });
  if (need.length) {
    // .ToFileTimeUtc() — NOT .Ticks. `.Ticks` on a LOCAL DateTime encodes the local wall clock, so
    // on this UTC+8 box a process started 02:54:21Z reports as 10:54:21Z: every genuine claim would
    // look like it predated its own process by 8 hours and EVERY peer would read as dead. Verified
    // against a process whose real start time was known before this was trusted.
    // A DONE MARKER, not the exit code. `-ErrorAction SilentlyContinue` suppresses the error
    // MESSAGE but NOT the exit status: ask about a batch where any pid has since died and
    // powershell prints perfect output for the survivors and still exits 1. The old guard
    // (`status !== 0 -> return null`) then threw that good answer away and FAILED OPEN, voiding
    // the impostor check for the WHOLE BATCH.
    //
    // And it voided it exactly where it was built to work: a squatter is BY DEFINITION a
    // transient process, so it is the likeliest thing in the batch to exit mid-probe — the check
    // disabled itself in its own reason for existing. (Found by the research peer, reproduced
    // here: live+dead pid => status 1, stdout correct. My own notes even warn that SilentlyContinue
    // does not clear the exit code; I wrote the guard anyway.)
    //
    // But the exit code cannot simply be IGNORED either, or the two failures become one: "every
    // pid is gone" and "powershell could not run at all" both give empty stdout + nonzero status.
    // Reading the second as the first would mark every peer an impostor — fail-CLOSED, the far
    // worse direction (it invites a second session into an occupied chair). So the pipeline prints
    // a marker LAST: see it and the enumeration provably ran, so a pid missing from stdout is
    // genuinely gone; miss it and we could not ask, so fail open.
    let r;
    try {
      r = spawnSync('powershell.exe', ['-NoProfile', '-Command',
        `Get-Process -Id ${need.join(',')} -ErrorAction SilentlyContinue | %{ "$($_.Id) $($_.StartTime.ToFileTimeUtc())" }; "${PROBE_OK}"`],
      // windowsHide: a CONSOLE-LESS parent (the detached feed) otherwise makes a NEW console window
      // for this child every cache-miss — a focus-stealing pop-up (audit #348). Every recurring PS
      // shell-out must set it; only arc-invite's peer birth window is intentional.
      { encoding: 'utf8', timeout: 5000, windowsHide: true });
    } catch { return null; }
    if (!r || r.error) return null;                        // could not spawn/timed out — cannot ask
    const out = String(r.stdout || '');
    if (!out.includes(PROBE_OK)) return null;              // it never finished — cannot ask
    const seen = {};
    for (const line of out.split('\n')) {
      const m = line.trim().match(/^(\d+)\s+(\d+)$/);
      if (m) seen[m[1]] = Number(m[2]) / 10000 - FILETIME_EPOCH;
    }
    // A pid absent from the output has NO READABLE start — cache null, a real answer. Absent means
    // one of two things, and for our purpose they are the same: the pid is GONE, or it is ALIVE but
    // UNREADABLE (a protected/system process whose StartTime the query cannot see — dwm.exe on a
    // recycled number is the live example). Either way this pid is not a start we can match a claim
    // against, so isHolder treats null as "not a provable holder" — see :584.
    for (const p of need) pidStartMemo[p] = { start: seen[p] !== undefined ? seen[p] : null, at: now };
    try { fs.mkdirSync(path.dirname(PIDSTART_CACHE), { recursive: true }); atomicWriteJson(PIDSTART_CACHE, pidStartMemo); } catch {}
  }
  const out = {};
  for (const p of want) out[p] = pidStartMemo[p] ? pidStartMemo[p].start : null;
  return out;
}

// Is this claim's process still the one that WROTE it? `starts` lets a caller pre-batch.
function isHolder(claim, starts) {
  if (!claim || !claim.pid) return false;
  if (!isAlive(claim.pid)) return false;          // free, and never a false negative
  if (!claim.at) return true;                     // legacy claim, no timestamp — trust the pid
  const s = starts !== undefined ? starts : procStarts([claim.pid]);
  // FAIL OPEN when the OS cannot be asked. Reading a LIVE peer as dead is the worse error: it
  // invites a duplicate session into an occupied chair. Unsure means "behave as we always did".
  if (!s) return true;
  const t = s[claim.pid];
  // No readable start for a pid that isAlive() accepted. TWO causes, same verdict: it died between
  // the two probes, OR it is alive but its start is UNREADABLE — a recycled pid now owned by a
  // PROTECTED process (dwm.exe was the live find). In both the pid cannot be proven to be the one
  // that WROTE this claim, so fail CLOSED: the chair is vacant. This is the opposite of the !s
  // branch above (fail OPEN) on purpose — there the OS could not be asked at all; here it answered,
  // and the answer excludes this pid.
  if (t == null) return false;
  // KNOWN ACCEPTED RACE (audit #152), documented so the record does not overclaim: `t` may be a
  // CACHED start, up to PIDSTART_TTL (30s) old and NOT re-probed. So within that window a claimed
  // pid that DIED and was recycled onto another live process reads its DEAD predecessor's start,
  // which still passes this check — the chair reads genuinely held for ≤30s. This is the FAIL-SAFE
  // direction: a dead peer looks briefly alive, so a revive is momentarily REFUSED and then
  // self-heals at TTL; it never admits a SECOND session into an occupied chair (the dangerous
  // direction). a0c93bb closed the COLD-cache door (a protected pid probes to null → vacant); this
  // warm-cache door is left open on purpose — Windows does not recycle a pid onto a chosen number
  // within 30s, so the probability is low and the outcome transient. If pid-reuse ever gets faster
  // or PIDSTART_TTL grows, this window grows with it. The DELEGATE path — where a false "live"
  // costs the most (a packet posted to a dead chair, reported as handled) — already closes it:
  // requestDelegate passes procStarts(..., {fresh: true}) results in as `starts`. Do the same
  // elsewhere if the window ever matters on another path.
  return claim.at >= t - CLAIM_SKEW_MS;
}

function roleClaim(board, role) {
  const l = readClaimFile(board, role);          // claim-*.json, or a legacy lease-*.json
  return l && isHolder(l) ? l : null;            // a dead — or IMPOSTOR — holder's claim is vacant
}

// Returns {ok:true} if claimed, or {ok:false, holder} if a LIVE *other* session holds it.
// IDENTITY IS THE SESSION, NOT THE PID: `/arc-restart` re-execs arc-runner with a NEW pid
// but the SAME ARC_SESSION, and must be able to reclaim its own role. The pid is only
// a liveness probe. (Fall back to pid comparison for claims written without a session.)
// The check and the write happen UNDER A LOCK: without it, two sessions claiming the same
// role at once both read "vacant" and both write — both believe they hold it, then share a
// cursor and eat each other's notes. `convId` records WHICH CONVERSATION took the role, so a
// later session resuming that same conversation can pick it back up (see vacantClaimForConv).
function claimRole(board, role, pid, sessionId, convId) {
  ensureBoard(board);
  try {
    return withLock(board, `role-${role}`, () => {
      const held = roleClaim(board, role);
      if (held) {
        const same = (sessionId && held.sessionId) ? held.sessionId === sessionId : held.pid === pid;
        if (!same) return { ok: false, holder: held };
      }
      // don't lose a previously-recorded conversation when this claim doesn't name one
      const conv = convId || (held && held.convId) || null;
      atomicWriteJson(claimPath(board, role), { role, pid, sessionId: sessionId || null, convId: conv, at: Date.now() });
      try { fs.unlinkSync(legacyClaimPath(board, role)); } catch {}   // migrate off the old name
      // FRESH-CLAIM BROADCAST FLOOR — only when there is genuinely no cursor yet. A brand-new role would
      // otherwise inherit every `to: all` broadcast ever posted (the note-dump on first claim). Seed a
      // floor at the current tip so that backlog reads as already-seen, with an EMPTY read-map (o:{}) so
      // NOTHING else is marked read: directed notes (an arc delegate packet, notes left for an empty
      // chair) carry no floor and still deliver in full. A revived/returning role has a cursor already
      // and is left untouched — it keeps its real read position. See readFloor/unreadFor.
      if (!fs.existsSync(cursorPath(board, role))) {
        atomicWriteJson(cursorPath(board, role), { o: {}, seq: 0, bfloor: highWater(allNotes(board)), at: Date.now() });
      }
      return { ok: true };
    });
  } catch (e) {
    return { ok: false, holder: null, busy: true, error: String(e && e.message) };
  }
}

// The claim this CONVERSATION was working under, now vacant (its session died). That is the
// role a resumed conversation should pick back up: a relaunch mints a NEW ARC_SESSION, so the
// role would otherwise be silently lost and the session would stop receiving notes entirely.
// A role that WAS held and is now empty — carrying the conversation of the session that held it.
// This is what makes a closed peer revivable AS ITSELF: its transcript is still on disk, and this
// is the only record of which one is its. Without it the only way to refill a chair is to fork
// someone else's context, which hands the role's name to a session that has none of its memory.
function vacantClaimForRole(board, role) {
  const l = readClaimFile(board, role);
  // !isHolder, NOT !isAlive: a stranger squatting the pid must leave the chair REVIVABLE. This is
  // the worst face of the bug — the role reads "held" so nothing may staff it, while the session
  // that could answer is gone. Vacancy and liveness have to be decided by the same rule.
  return (l && l.convId && !isHolder(l)) ? l : null;
}

// Adopt the vacant chair a CONVERSATION last held — but a conversation owns exactly ONE role, so
// more than one vacant claim carrying the same convId is CORRUPTION, and adopting the readdir-first
// one is how it spread. Real case (whalephone): a uiux session relaunched, its conversation matched
// BOTH claim-quiz and claim-uiux (both stamped with its convId), and `return l` on the first match
// handed it QUIZ because 'quiz' < 'uiux' — so uiux was silently adopted into the quiz chair, and
// every relaunch re-stamped it. Guessing on ambiguity is the bug. Collect ALL matches: exactly one
// is a clean adoption; more than one, refuse — a session that cannot be placed unambiguously claims
// fresh via its own charter rather than taking a chair that might not be its.
function vacantClaimForConv(board, convId) {
  if (!convId) return null;
  let files = [];
  try { files = fs.readdirSync(board.planDir); } catch { return null; }
  // STEP 1 — resolve the AUTHORITATIVE file per logical role BEFORE any convId/vacancy test. A role
  // may carry both a current claim-<role> and a stale legacy lease-<role>; claim-* is authoritative
  // (it is what every other reader normalizes to). Testing convId FIRST and preferring claim-* second
  // (the old order) lets a divergent stale lease win when the current claim names a DIFFERENT
  // conversation — it filtered the current claim out, then "preferred claim" within a set that no
  // longer held it, adopting the legacy chair and overwriting the current one (audit #289 blocker 4).
  const authoritative = new Map();                  // fileRole -> { file, isClaim }
  for (const f of files) {
    const fm = f.match(CLAIM_FILE_RX);
    if (!fm) continue;                              // a legacy lease-*.json is still OUR claim
    const fileRole = fm[1];
    if (!VALID_ROLE.test(fileRole)) continue;
    const isClaim = f.startsWith('claim-');
    const cur = authoritative.get(fileRole);
    if (!cur || (isClaim && !cur.isClaim)) authoritative.set(fileRole, { file: f, isClaim });
  }
  // STEP 2 — adopt the roles whose AUTHORITATIVE record matches this conversation and is vacant. The
  // filename is the authority for WHICH chair a file is; a payload role that disagrees is corruption
  // and must never rename the chair, so require both to agree (audit #271 M4). Current + legacy files
  // for one logical role are migration aliases, deduped in step 1, so a match here is one real chair.
  const matches = [];
  for (const [fileRole, { file }] of authoritative) {
    try {
      const l = JSON.parse(fs.readFileSync(path.join(board.planDir, file), 'utf8'));
      if (l.role !== fileRole || !l.convId || l.convId !== convId || isHolder(l)) continue;
      matches.push({ ...l, role: fileRole });
    } catch { /* torn claim = no claim */ }
  }
  return matches.length === 1 ? matches[0] : null;   // 0 = nothing; >1 distinct role = corrupt, do not guess
}

// Who else is live in this flat right now (dead claims are ignored, not deleted —
// a crashed session's claim just goes vacant).
// THE place to batch: this asks about every claim on the board at once, so it must cost ONE
// query, not one per role. The pids that survive the free isAlive probe are the only ones the
// OS is asked about — usually one, often none.
function liveRoles(board) {
  let files = []; try { files = fs.readdirSync(board.planDir); } catch { return []; }
  const claims = files
    .map((f) => (f.match(CLAIM_FILE_RX) || [])[1])
    .filter((r, i, a) => r && a.indexOf(r) === i)   // one role may have BOTH names mid-migration
    .map((r) => readClaimFile(board, r))
    .filter((l) => l && isAlive(l.pid));            // free pass: settles every ordinary dead claim
  if (!claims.length) return [];
  const starts = procStarts(claims.map((l) => l.pid));
  return claims.filter((l) => isHolder(l, starts));
}

// ---- PARENTAGE: who spawned this peer -------------------------------------------------------
// arc knew a peer EXISTED and never knew who MADE it, so nothing could ever reap one: a leaked
// probe was indistinguishable from a standing team member. Every cleanup was a human recognising
// a name they had watched an agent type. In one session that cost five leaks — three test peers a
// human had to name, sixteen orphan consoles from a harness whose kill hit the wrong process, and
// a peer that survived a spawn its own caller was told had failed.
//
// The record is written by the SPAWNER at birth, not by the peer: a newborn cannot know who made
// it (it is a fresh conversation with a birth prompt), and asking it to self-report parentage
// would be trusting the thing being tracked. `bornOf` is the spawner's CONVERSATION, never its
// session id or pid — those are handles that change on a respawn, and this repo has now been
// bitten three separate times by treating one as an identity (a recycled pid squatting a chair; a
// peer wearing its caller's session; a session refused its own role after a restart).
const birthPath = (board, role) => path.join(board.planDir, `born-${role}.json`);
function recordBirth(board, role, bornOf) {
  if (!bornOf) return null;   // a caller with no conversation to name: cold birth, unparented
  try { atomicWriteJson(birthPath(board, role), { role, bornOf, at: Date.now() }); return { role, bornOf }; }
  catch { return null; }      // parentage is bookkeeping — it must never break a spawn
}
function readBirth(board, role) {
  try { return JSON.parse(fs.readFileSync(birthPath(board, role), 'utf8')); } catch { return null; }
}
function clearBirth(board, role) {
  try { fs.unlinkSync(birthPath(board, role)); } catch {}
}

// ---- retire: the OTHER end of the role lifecycle ----------------------------------------------
// `close` stops a peer but deliberately KEEPS everything that makes it revivable — the claim (which
// holds the convId pointer), its cursor, seen stamps, birth record and charter. That is right for a
// standing duty that is merely idle, and wrong for a role that is FINISHED: nothing ever left the
// roster, so a done role kept a chair on the graph and a cursor on the ledger forever, and the only
// way out was hand-deleting board files — the exact thing arc tells agents never to do.
//
// THE LEDGER IS NEVER TOUCHED. notes.jsonl is append-only history, and every other role's cursor is
// a POSITION in it — deleting a retired role's lines silently shifts every other reader's `ord`
// (measured on this board). What a role SAID stays said; what it OWNS is what goes.
function roleArtifacts(board, role) {
  const r = String(role).toLowerCase();
  const out = [];
  const add = (p, what) => { try { if (p && fs.existsSync(p)) out.push({ path: p, what }); } catch {} };
  add(claimPath(board, r), 'the chair — and its convId, the revive pointer');
  add(legacyClaimPath(board, r), 'legacy lease file');
  add(cursorPath(board, r), 'read cursor — how far it had read');
  add(seenPath(board, r), 'seen stamps');
  add(birthPath(board, r), 'birth record — who spawned it');
  try { add(require('./arc-duty').dutyPath(board, r), 'its charter — what the role OWNS'); } catch {}
  return out;
}
function retireRole(board, role) {
  const removed = [], failed = [];
  for (const a of roleArtifacts(board, role)) {
    try { fs.unlinkSync(a.path); removed.push(a); } catch (e) { failed.push({ path: a.path, err: e.message }); }
  }
  return { role: String(role).toLowerCase(), removed, failed };
}
// Every role THIS conversation spawned, live or not. Keyed by conv so it survives your own respawn.
function spawnsOf(board, conv) {
  if (!conv) return [];
  const out = [];
  try {
    for (const f of fs.readdirSync(board.planDir)) {
      const m = /^born-(.+)\.json$/.exec(f);
      if (!m) continue;
      const b = readBirth(board, m[1]);
      if (b && b.bornOf === conv) out.push(b);
    }
  } catch {}
  return out;
}

// A ROLE MOVE MUST NOT BURN THE REVIVE POINTER. This used to unlink the claim outright — the
// same mistake closePeer already fixed (see :859) surviving in the MOVE path: a session
// switching roles deleted its OLD chair's claim, and with it the convId that made the old role
// revivable. Fired in production 2026-07-18: audit's session was mis-adopted into 'research'
// (the restart/sweeper race — ROADMAP) and the move DELETED claim-audit, so the next
// `arc delegate audit` silently birthed a stranger in the chair's name. Tombstone like
// closePeer does: keep the convId, drop the pid; unlink only a claim with no conversation to
// point at. Under the same role lock claimRole holds, and pid-checked INSIDE it — a concurrent
// revive that re-claimed the chair must not have its live claim clobbered by our tombstone.
function releaseRole(board, role, pid) {
  return withLock(board, `role-${role}`, () => {
    for (const p of [claimPath(board, role), legacyClaimPath(board, role)]) {
      try {
        const c = JSON.parse(fs.readFileSync(p, 'utf8'));
        if (c.pid !== pid) continue;               // not ours (or already re-claimed) — leave it
        if (c.convId) atomicWriteJson(p, { role: c.role || role, sessionId: c.sessionId || null, convId: c.convId, at: Date.now() });
        else fs.unlinkSync(p);
      } catch {}
    }
  });
}

// ---- CLOSING A PEER: kill the TREE, in the only order that works ----------------------------
// THE CLAIM PID IS THE MIDDLE OF THE TREE, and that is the whole trap:
//     pwsh (the shell that outlives claude)  ->  node arc-runner  <-- THE CLAIM PID  ->  claude.exe
// Kill claude and arc-runner's `for(;;)` RESPAWNS IT — which is exactly why a harness's kill left
// sixteen orphan consoles alive, and why my own probe pids kept changing under me while I killed
// the same peer four times. Kill only the runner and claude is orphaned but still burning quota.
// So: RUNNER FIRST (it can no longer respawn), then claude, then the parent shell.
//
// Best-effort by design: a peer that is already half-dead must still end up fully dead and the
// claim must still be released. A close that refuses because one pid was already gone would leave
// exactly the mess it exists to clear.
function closePeer(board, role, opts) {
  const o = opts || {};
  // ONE raw snapshot at entry. The kill target and the abort baseline BOTH derive from it, so a
  // revive cannot slip between two adjacent reads and desync them — poisoning entryPid with the
  // revive's own pid so the :809 abort silently fails to fire and tombstones a live peer (audit
  // #172). `claim` is the genuineness-filtered view (inlined roleClaim = readClaimFile + isHolder)
  // so only a genuine holder is killed (a recycled-pid stranger reads vacant, untouched); `entryPid`
  // is the RAW pid so the tombstone still fires for an already-exited peer (the common close).
  const entry = readClaimFile(board, role);
  const entryPid = entry && entry.pid;
  const claim = entry && isHolder(entry) ? entry : null;
  const kill = o.kill || ((pid) => { try { process.kill(pid, 'SIGKILL'); return true; } catch { return false; } });
  const tree = o.tree || treeOf;
  const killed = [];
  if (claim && claim.pid) {
    const t = tree(claim.pid);                       // { parent, children }
    // ORDER IS LOAD-BEARING — see above.
    if (kill(claim.pid)) killed.push({ pid: claim.pid, what: 'runner' });
    for (const c of t.children) if (kill(c)) killed.push({ pid: c, what: 'claude' });
    if (t.parent && kill(t.parent)) killed.push({ pid: t.parent, what: 'shell' });
  }
  // THE CLAIM IS THE REVIVE POINTER — CLOSE MUST NOT BURN IT. This used to unlink the claim file
  // ("a chair held by a corpse is worse than an empty one"), and that reasoning belonged to the
  // pre-genuineness era: a pid-less claim cannot read as held (isHolder requires a pid), so nothing
  // refuses to staff the chair. What unlinking actually destroyed was `convId` — the ONLY thing
  // vacantClaimForRole has to find the peer's own conversation — so `arc close` printed "REVIVABLE,
  // not deleted" while guaranteeing the next delegate would silently BIRTH A STRANGER in the
  // chair's name. Caught in production the first time a real standing peer was closed between
  // assignments (audit, 2026-07-16): its transcript sat untouched on disk and the roster showed
  // "empty chair" instead of "was here; REVIVE as itself". The close-then-revive round trip is the
  // standing-duty lifecycle; the tombstone below is what makes the promise in close's own message
  // true. Unlink only when there is no conversation to point at — then the chair really is bare.
  // THE TOMBSTONE IS A CLAIM MUTATION, so it must hold the SAME lock claimRole holds — or a
  // concurrent `arc delegate <role>` (revive) writes a LIVE claim under the lock and our unlocked
  // tombstone clobbers it: the live peer reads vacant (DOUBLE-STAFFING) and its convId reverts to
  // the stale one we read before the revive (audit #167, a real race — closePeer took no lock).
  // The kill stayed OUTSIDE the lock on purpose: killing a tree can be slow, and the lock guards
  // the claim FILE, not the process. And inside the lock we RE-CHECK the pid: if it changed since
  // we entered, a revive won the chair while we were killing — do NOT tombstone a live peer.
  // Read the claim RAW (not roleClaim): roleClaim is genuineness-filtered, so a dead pid reads as
  // "no claim", and filtering here would skip the tombstone for every peer that already exited —
  // the common close. The kill above stays filtered (a recycled pid may be a stranger).
  return withLock(board, `role-${role}`, () => {
    const raw = readClaimFile(board, role);
    if (raw && raw.pid && raw.pid !== entryPid) {
      // A concurrent revive re-claimed this role after we started closing. Its live claim wins;
      // tombstoning it would erase a live peer. Leave it — we only killed the OLD peer's tree.
      return { role, killed, hadClaim: true, revivable: !!raw.convId, reclaimed: true };
    }
    if (raw && raw.convId) {
      atomicWriteJson(claimPath(board, role), { role, sessionId: raw.sessionId || null, convId: raw.convId, at: Date.now() });
    } else {
      try { fs.unlinkSync(claimPath(board, role)); } catch {}
    }
    clearBirth(board, role);
    return { role, killed, hadClaim: !!raw, revivable: !!(raw && raw.convId), reclaimed: false };
  });
}

// The pids around a runner: its parent shell and its claude child. Windows-only (WMI), and it must
// never throw — a close that dies on a query leaves the tree alive.
function treeOf(pid) {
  const out = { parent: null, children: [] };
  try {
    const q = spawnSync('powershell.exe', ['-NoProfile', '-Command',
      `$p=Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; if($p){ "P:"+$p.ParentProcessId };` +
      `Get-CimInstance Win32_Process -Filter "ParentProcessId=${pid}" | ForEach-Object { "C:"+$_.ProcessId }`],
      { encoding: 'utf8', timeout: 8000, windowsHide: true });   // no pop-up window from a console-less parent (audit #348)
    for (const line of String(q.stdout || '').split(/\r?\n/)) {
      const m = /^([PC]):(\d+)$/.exec(line.trim());
      if (!m) continue;
      if (m[1] === 'P') out.parent = parseInt(m[2], 10);
      else out.children.push(parseInt(m[2], 10));
    }
  } catch {}
  return out;
}

module.exports = {
  PLAN_DIR, GITIGNORE_BODY,
  canonical, repoRoot, resolveBoard, ensureBoard,
  notesPath, appendNote, sanitizeBody, allNotes, noteCount, latestSeq,
  KINDS, KIND_RANK, DEFAULT_KIND, normalizeKind, supersededMap, openRequests, repliesTo, seenBy, requestStatus, contracts, contractStrays,
  // EXPORTED because a caller outside this file was answering "is this note directed at <role>?"
  // with `n.to === role` and getting it wrong for both an array `to` and a broadcast. There is one
  // right answer to that question and it lives here; anyone who needs it should be able to reach it
  // rather than re-derive it. NOTE it deliberately does NOT cover a broadcast (`to == null`) —
  // "addressed to everyone" is a different question, and callers that mean it say `n.to == null ||
  // toHas(n.to, role)`, exactly as openRequests does above.
  toHas,
  readCursor, readCursorMap, readFloor, writeCursor, unreadFor, markRead, stampSeen, readSeen,
  boardOrigin, machineId, noteOrigin, noteKey, refKey, resolveRef, refSeq, legacyId,
  noteTitle,
  isAlive, isHolder, procStarts, roleClaim, readClaimFile, claimRole, releaseRole, liveRoles, vacantClaimForRole,
  validConv,
  atomicWriteJson, withLock, vacantClaimForConv,
  recordBirth, readBirth, clearBirth, spawnsOf, closePeer, treeOf,
  roleArtifacts, retireRole,
};
