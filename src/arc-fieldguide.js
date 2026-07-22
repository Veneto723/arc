// arc-fieldguide: a peer-written, project-scoped shared LESSONS file — the one surface that carries a
// hard-won gotcha BETWEEN peers. Not doctrine (CLAUDE.md), not a role's duty (a charter), not the
// operator's own memory: a trap that cost a peer a turn and is not already written down in the code,
// CLAUDE.md, or git. Lives at `.arc/fieldguide.md` beside `roles/` — so it travels with the board via
// `arc export`/`arc import` (see arc-sync.stageBoardInto) and NEVER by git (the `.arc/` self-ignore
// covers it). One line per lesson, attributed; delete stale ones by hand.
//
// Deliberately DISCIPLINED (research #284, operator-endorsed with a caveat): it overlaps the operator
// memory and risks the note-count noise the board prices against, so it earns its place only for the
// lesson a peer would otherwise RE-PAY. If a trap is stable, it belongs in CLAUDE.md; the field guide
// is for the project-specific gotcha CLAUDE.md would not carry.
'use strict';

const fs = require('fs');
const path = require('path');

// `.arc/fieldguide.md` at the board root — same `.arc/` dir arc-duty puts `roles/` in, so it lands in
// the exported bundle and stays out of git the same way.
const GUIDE_REL = path.join('.arc', 'fieldguide.md');
function guidePath(board) { return path.join(board.root, GUIDE_REL); }
function guideRel() { return GUIDE_REL.replace(/\\/g, '/'); }

const HEADER =
  '# field guide — hard-won lessons, one line each\n' +
  '\n' +
  'Peer-written, project-scoped. A trap that cost a turn and is NOT already in the code, CLAUDE.md, or\n' +
  'git history. One `- ` line per lesson; prune a stale one by deleting its whole line. Travels with the\n' +
  'board (arc export/import), never git. Add one:  `arc fieldguide "<the lesson>"`\n' +
  '\n';

// The lesson lines ("- " bullets) from arbitrary guide text — header and blanks dropped. Pure, so the
// import merge (arc-sync) can parse a staged guide without a board.
function parse(text) {
  const out = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const m = raw.match(/^- (.+)$/);
    if (m) out.push(m[1].trim());
  }
  return out;
}
// Every lesson line, in file order.
function lessons(board) {
  try { return parse(fs.readFileSync(guidePath(board), 'utf8')); } catch { return []; }
}
// Render a full guide file from a header + lesson lines (used by the import union-merge).
function render(lessonLines) { return HEADER + lessonLines.map((l) => `- ${l}\n`).join(''); }

// The comparable BODY of a lesson — strip our "  — <who>" attribution so a re-add by a different peer
// is caught as a duplicate. Anchored on the DOUBLE space, NOT " — ": appendLesson collapses every
// lesson body to single spaces, so a body can never contain "  — ", but the attribution always does.
// A naive " — " strip ate a body that merely ENDS in "— <text>" (a common shape) off the RAW new text
// — which has no attribution yet — and falsely called it a duplicate, dropping a distinct lesson
// (audit #296). This reduces the raw new text (no attribution) and a stored line (attribution) to the
// SAME body, so the comparison is consistent and a body's own em-dash is preserved on both sides.
function core(line) { return String(line).replace(/\s{2,}—.*$/, '').replace(/\s+/g, ' ').trim().toLowerCase(); }

// Append a one-line lesson, attributed to `who`. Collapses whitespace to keep it ONE line, skips an
// exact-core duplicate, creates the file with the header when absent. Returns { ok, added, reason }.
function appendLesson(board, who, text) {
  const line = String(text || '').replace(/\s+/g, ' ').trim();
  if (!line) return { ok: false, reason: 'empty' };
  if (lessons(board).some((l) => core(l) === core(line))) return { ok: false, reason: 'duplicate' };
  const entry = `- ${line}  — ${String(who || 'someone')}\n`;
  try {
    fs.mkdirSync(path.dirname(guidePath(board)), { recursive: true });
    let cur = ''; try { cur = fs.readFileSync(guidePath(board), 'utf8'); } catch {}
    if (!cur) fs.writeFileSync(guidePath(board), HEADER + entry);
    else fs.appendFileSync(guidePath(board), cur.endsWith('\n') ? entry : '\n' + entry);
    return { ok: true, added: line };
  } catch (e) { return { ok: false, reason: String(e && e.message) }; }
}

// A compact block for auto-delivery (the /arc-role claim context): the lessons, capped so a long guide
// never floods a claim. Returns '' when there is nothing to show, so the caller can omit the section.
const INJECT_MAX_LESSONS = 8;
const INJECT_MAX_CHARS = 900;
function injectBlock(board) {
  const all = lessons(board);
  if (!all.length) return '';
  const show = all.slice(-INJECT_MAX_LESSONS);                 // newest lessons are the most likely live
  let body = show.map((l) => '  · ' + l).join('\n');
  if (body.length > INJECT_MAX_CHARS) body = body.slice(0, INJECT_MAX_CHARS - 1) + '…';
  const more = all.length > show.length ? ` (+${all.length - show.length} more — \`arc fieldguide\`)` : '';
  return `field guide — lessons peers left here${more}:\n${body}`;
}

module.exports = { guidePath, guideRel, GUIDE_REL, HEADER, parse, lessons, render, appendLesson, injectBlock, core };
