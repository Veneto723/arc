#!/usr/bin/env node
// arc-progress: one download progress line, built the way pip builds its.
//
// WHAT WAS THERE. `curl -#`, which draws a row of '#' and a trailing percentage. It says how far
// along you are and nothing else — not how big the file is, not how fast it is moving, not how long
// is left. On a slow link that is indistinguishable from a hang, which is the one question a
// progress bar exists to answer.
//
// WHERE THE SHAPE COMES FROM. Read out of the two tools the operator named:
//   * pip (pip/_internal/cli/progress_bars.py) composes a FIXED COLUMN ORDER:
//         description -> bar -> "8.4/15.8 MB" -> "12.3 MB/s" -> "eta" -> "0:00:01"
//     Its bar glyphs (rich/progress_bar.py) are '━' complete, '╸' for the leading edge, '━' dimmed
//     for the remainder, and a '-' ASCII fallback. It refreshes 5x/second, NOT per chunk. When the
//     size is unknown it drops the bar entirely and shows spinner + bytes + speed + elapsed — a bar
//     with no denominator is a lie, so pip does not draw one.
//   * npm 11 ships NO download bar at all (`npm config get progress` -> false; gauge and npmlog are
//     gone from its tree). So there was nothing to copy there, and that is itself the lesson: the
//     bar has to earn its line or not be drawn.
//
// THE THREE THINGS THE OLD ONE GOT WRONG, each fixed here:
//   1. No denominator, no rate, no eta  ->  every column pip has, in pip's order.
//   2. Redrawn per chunk  ->  throttled to ~8/second. A line rewritten faster than the eye resolves
//      reads as flicker, and on Windows each write is a console round-trip.
//   3. Fixed width, so it wrapped  ->  the bar is sized from the REMAINING columns after the text,
//      and a wrapped progress line leaves a trail of half-drawn bars up the scrollback.
//
// ASCII IS THE FALLBACK, NOT THE DEFAULT — and that is a deliberate split from the statusbar rule.
// The statusbar must be pure ASCII because it renders in whatever terminal the operator happens to
// have. This line only ever draws on a TTY we can interrogate, so it uses '━' where the terminal
// says it can and degrades to '=' where it cannot.
'use strict';

const UNI = { full: '━', head: '╸', empty: '━' };
const ASCII = { full: '=', head: '>', empty: '-' };
const SPINNER = ['-', '\\', '|', '/'];        // pip's "line" spinner, same four frames
const MIN_BAR = 10;
const MAX_BAR = 40;
const FRAME_MS = 125;                          // ~8/s; pip uses 5/s, both are under the flicker floor

// 1.2 MB, 934 kB, 12 B — one decimal past kB, matching pip's DownloadColumn.
function fmtBytes(n) {
  if (!Number.isFinite(n) || n < 0) return '?';
  if (n < 1000) return `${Math.round(n)} B`;
  const units = ['kB', 'MB', 'GB', 'TB'];
  let v = n / 1000;
  let i = 0;
  while (v >= 1000 && i < units.length - 1) { v /= 1000; i++; }
  return `${v.toFixed(1)} ${units[i]}`;
}

// 0:00:07 — pip's TimeRemainingColumn shape. Anything past a day is not worth a digit.
function fmtEta(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '-:--:--';
  if (sec > 86400 * 2) return '-:--:--';
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h}:${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

// The bar itself. `head` is what makes it read as MOVING rather than as a filled block: the leading
// cell is drawn differently from the body, so a stalled transfer looks different from a slow one.
function bar(frac, width, ascii) {
  const g = ascii ? ASCII : UNI;
  const w = Math.max(1, width);
  const f = Math.max(0, Math.min(1, frac));
  const filled = Math.floor(f * w);
  if (filled >= w) return g.full.repeat(w);
  const head = filled < w ? g.head : '';
  return g.full.repeat(filled) + head + g.empty.repeat(Math.max(0, w - filled - head.length));
}

// The whole line, as a pure function of the numbers — so the layout is testable with no terminal.
// `total` null means "size unknown": no bar, because a bar with no denominator is a lie. That is
// pip's own rule, and it is the difference between "we do not know" and "we are at 0%".
function render(o) {
  const { label = '', done = 0, total = null, rate = null, elapsed = 0, columns = 80, ascii = false, frame = 0 } = o || {};
  const speed = rate != null && rate > 0 ? `${fmtBytes(rate)}/s` : '';

  if (total == null) {
    const bits = [label, SPINNER[frame % SPINNER.length], fmtBytes(done), speed, fmtEta(elapsed / 1000)];
    return bits.filter(Boolean).join('  ');
  }

  const amount = `${fmtBytes(done)}/${fmtBytes(total)}`;
  const eta = rate != null && rate > 0 ? `eta ${fmtEta((total - done) / rate)}` : 'eta -:--:--';

  // SHED COLUMNS BEFORE SHEDDING THE BAR. The first cut dropped the bar whenever the fixed text did
  // not leave MIN_BAR behind, which meant a 60-column pane got no bar at all — the one element the
  // line exists for, sacrificed to keep an eta. pip narrows by dropping its rightmost columns, so
  // walk the same ladder: eta goes first, then the rate, then the label. Only if there is still no
  // room does the bar go, and by then the line is text and honest about it.
  const ladders = [
    [amount, speed, eta],
    [amount, speed],
    [amount],
  ];
  for (const parts of ladders) {
    for (const lbl of [label, '']) {
      const tail = parts.filter(Boolean).join('  ');
      const fixed = (lbl ? lbl.length + 2 : 0) + tail.length + 2;
      const room = columns - fixed - 1;
      if (room >= MIN_BAR) {
        const width = Math.min(MAX_BAR, room);
        return [lbl, bar(done / total, width, ascii), tail].filter(Boolean).join('  ');
      }
    }
  }
  // Nothing fits a bar. The number still has to fit the PANE, though — the last line here used to
  // return label+amount unchecked, which overflowed at 20 columns and wrapped, which is the exact
  // failure the whole ladder exists to prevent.
  const withLabel = [label, amount].filter(Boolean).join('  ');
  if (withLabel.length < columns) return withLabel;
  if (amount.length < columns) return amount;
  return amount.slice(0, Math.max(0, columns - 1));
}

// Can this terminal draw the box-drawing glyphs? Windows Terminal and VS Code can; a raw conhost
// window on a legacy code page cannot, and there it prints mojibake that never erases cleanly.
function asciiOnly(env) {
  const e = env || process.env;
  if (e.ARC_PROGRESS_ASCII) return true;
  return !(e.WT_SESSION || e.TERM_PROGRAM || e.WSL_DISTRO_NAME);
}

// The live bar. Silent and inert whenever there is no TTY to draw on — a progress line in a piped
// log or a CI job is thousands of \r-separated fragments nobody can read.
function Bar(label, opts) {
  const o = opts || {};
  const out = o.stream || process.stderr;      // stderr, so stdout stays pipeable
  const on = !o.quiet && !!out.isTTY;
  const ascii = o.ascii != null ? o.ascii : asciiOnly(o.env);
  const started = o.now ? o.now() : Date.now();
  const now = o.now || (() => Date.now());
  let last = 0;
  let frame = 0;
  let done = 0;
  let total = o.total != null ? o.total : null;
  let drawn = false;

  function paint(force) {
    if (!on) return;
    const t = now();
    if (!force && t - last < FRAME_MS) return;
    last = t;
    const elapsed = t - started;
    const rate = elapsed > 250 ? done / (elapsed / 1000) : null;
    const line = render({ label, done, total, rate, elapsed, columns: out.columns || 80, ascii, frame: frame++ });
    out.write('\r\x1b[K' + line);              // \r then erase-to-end: a shorter line must not leave tail
    drawn = true;
  }

  return {
    setTotal(n) { total = Number.isFinite(n) && n > 0 ? n : null; },
    tick(bytes) { done += bytes; paint(false); },
    // The final frame is FORCED, so the line always ends at 100% rather than at whatever the last
    // throttled sample happened to be. Then one newline, so following output starts clean.
    stop(ok) {
      if (!on) return;
      if (ok && total != null) done = total;
      paint(true);
      if (drawn) out.write('\n');
    },
    get enabled() { return on; },
  };
}

module.exports = { fmtBytes, fmtEta, bar, render, asciiOnly, Bar, FRAME_MS, MIN_BAR, MAX_BAR, SPINNER };
