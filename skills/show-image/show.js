#!/usr/bin/env node
// show-image/show.js — open an image in the human's default viewer.
//
// Reading an image shows it to the MODEL only; the user never sees it, and Claude
// Code cannot render images inline (graphics escape sequences are rejected). This
// is the only way to actually put an image in front of the person.
//
// Usage:  node show.js <path-to-image> [--dry]
//   --dry   print the command that WOULD run, without opening anything.
//
// Cross-platform, zero dependencies. Windows: `start` · macOS: `open` · Linux: `xdg-open`.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.avif', '.tif', '.tiff', '.ico', '.pdf']);

function fail(msg, code = 1) { process.stderr.write(`[show-image] ${msg}\n`); process.exit(code); }

const args = process.argv.slice(2);
const dry = args.includes('--dry');
const target = args.filter((a) => a !== '--dry')[0];

if (!target) fail('usage: node show.js <path-to-image> [--dry]');

const file = path.resolve(target);
if (!fs.existsSync(file)) fail(`no such file: ${file}`);
let st; try { st = fs.statSync(file); } catch (e) { fail(`cannot stat ${file}: ${e.message}`); }
if (st.isDirectory()) fail(`that's a directory, not an image: ${file}`);
if (st.size === 0) fail(`file is empty (0 bytes): ${file}`);

const ext = path.extname(file).toLowerCase();
if (!IMAGE_EXT.has(ext)) {
  process.stderr.write(`[show-image] warning: "${ext || '(no extension)'}" isn't a known image type — opening anyway.\n`);
}

// Pick the OS's "open with default app" command.
const plat = os.platform();
let cmd, cmdArgs;
if (plat === 'win32') { cmd = process.env.ComSpec || 'cmd.exe'; cmdArgs = ['/d', '/s', '/c', 'start', '', file]; }
else if (plat === 'darwin') { cmd = 'open'; cmdArgs = [file]; }
else { cmd = 'xdg-open'; cmdArgs = [file]; }

// Headless check: on Linux with no display there IS no viewer — say so plainly
// instead of failing cryptically, and still give the human the path.
if (plat !== 'win32' && plat !== 'darwin' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
  process.stdout.write(
    `[show-image] no graphical display (headless/SSH) — cannot open a viewer.\n` +
    `[show-image] image is at: ${file}\n` +
    `[show-image] Tell the user the path; if it's a QR, consider rendering it as text instead.\n`);
  process.exit(0);
}

// Send a desktop toast, reusing cl-kit's notifier if installed (Windows WinRT toast
// with icon; macOS osascript; Linux notify-send). Returns how it was sent, or null.
// `launchUri` makes the toast CLICKABLE — a file:/// URI opens the image in its
// default app, so nothing steals focus until the human actually clicks.
function desktopNotify(title, body, launchUri) {
  const scripts = path.join(os.homedir(), '.claude', 'scripts');
  // kind 'image' has no state icon on purpose — the toast's logo IS a thumbnail of
  // the actual image (logoUri), which says far more than any generic glyph.
  try {
    require(path.join(scripts, 'cl-notify.js'))
      .toast(title, body, 'image', undefined, launchUri, { logoUri: launchUri });
    return 'cl-notify toast (thumbnail preview · click it to open)';
  } catch {}
  try { if (require(path.join(scripts, 'cl-platform.js')).notify(title, body)) return 'desktop notification (not clickable — open the path yourself)'; } catch {}
  return null;
}

// CL_SHOW_IMAGE modes — the human decides how intrusive this is allowed to be:
//   open   (default) pop the image in the OS viewer      — steals focus
//   notify           desktop toast + print the path      — NO window, no focus steal
//   off              print the path only                 — never opens anything
const MODE = (process.env.CL_SHOW_IMAGE || 'open').toLowerCase();

if (MODE === 'off') {
  process.stdout.write(
    `[show-image] CL_SHOW_IMAGE=off — not opening a window.\n` +
    `[show-image] image is at: ${file}\n` +
    `[show-image] Give the user this path so they can open it themselves.\n`);
  process.exit(0);
}

if (MODE === 'notify') {
  const kb0 = Math.max(1, Math.round(st.size / 1024));
  const fileUri = require('url').pathToFileURL(file).href; // file:///C:/... (properly encoded)
  const how = dry
    ? `(dry: would toast, click-target ${fileUri})`
    : desktopNotify('Claude has an image for you', `${path.basename(file)} · ${kb0} KB — click to open`, fileUri);
  process.stdout.write(
    `[show-image] CL_SHOW_IMAGE=notify — no window opened (focus not stolen).\n` +
    `[show-image] ${how ? `alerted via ${how}` : 'no notifier available — tell the user directly'}\n` +
    `[show-image] image is at: ${file}\n` +
    `[show-image] Tell the user the image is ready and give them this path.\n`);
  process.exit(0);
}

if (dry) { process.stdout.write(`[show-image] DRY RUN — would run: ${cmd} ${cmdArgs.join(' ')}\n`); process.exit(0); }

const r = spawnSync(cmd, cmdArgs, { stdio: 'ignore', windowsHide: true, timeout: 15_000 });
if (r.error) fail(`failed to launch viewer (${cmd}): ${r.error.message}`);
if (r.status !== 0 && plat !== 'win32') fail(`viewer exited ${r.status} — no default image handler? path: ${file}`);

const kb = Math.max(1, Math.round(st.size / 1024));
process.stdout.write(`[show-image] opened ${path.basename(file)} (${kb} KB) in the default viewer — the user can see it now.\n`);
