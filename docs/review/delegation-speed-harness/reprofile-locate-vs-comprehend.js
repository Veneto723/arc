'use strict';
// reprofile-locate-vs-comprehend.js — splits the worker's fused ORIENT phase (firstTool -> delegate)
// into LOCATE (reach the owning file) vs COMPREHEND (the tail after the file is known), and classifies
// whether each delegate packet carried a COMPREHENDED root-cause. Tests code's #94 axis 1 from the
// 5 surviving warm-delegated worker transcripts — zero re-run. Read-only.
const fs = require('fs'), os = require('os'), path = require('path');

function findTr(conv) {
  if (!conv) return null;
  const pr = path.join(os.homedir(), '.claude', 'arc-profiles');
  const bases = [path.join(os.homedir(), '.claude', 'projects')];
  try { for (const p of fs.readdirSync(pr)) bases.push(path.join(pr, p, 'projects')); } catch {}
  for (const b of bases) { let ds = []; try { ds = fs.readdirSync(b); } catch { continue; } for (const d of ds) { const f = path.join(b, d, conv + '.jsonl'); if (fs.existsSync(f)) return f; } }
  return null;
}
function entries(fp) {
  const out = [];
  if (!fp) return out;
  for (const l of fs.readFileSync(fp, 'utf8').split('\n')) {
    if (!l.trim()) continue; let j; try { j = JSON.parse(l); } catch { continue; }
    const ts = j.timestamp ? Date.parse(j.timestamp) : null;
    const content = Array.isArray(j.message && j.message.content) ? j.message.content : [];
    out.push({ ts, content });
  }
  return out;
}
// The file an owner actually edited (first src Edit/Write target) — the routing TARGET.
function ownerEditedFile(conv) {
  for (const e of entries(findTr(conv))) for (const x of e.content) {
    if (x && x.type === 'tool_use' && /Edit|Write/.test(x.name)) {
      const f = (x.input && (x.input.file_path || x.input.path)) || '';
      if (/src[\\/]/i.test(f)) return path.basename(f);
    }
  }
  return null;
}
const base = (f) => (f || '').replace(/\\/g, '/').split('/').pop();
const s = (a, b) => (a != null && b != null) ? +((b - a) / 1000).toFixed(1) : null;

const rows = fs.readFileSync(path.join(__dirname, 'results.jsonl'), 'utf8').split('\n').filter(Boolean).map(JSON.parse);
const warm = rows.filter((r) => r.mode === 'warm' && r.delegated && r.t_done);

const LOC = []; // locate fractions
console.log('LOCATE vs COMPREHEND within the worker orient phase (warm delegated). times in seconds.\n');
for (const r of warm) {
  const t_start = Date.parse(r.t_start);
  const owners = (r.owner_windows || []).filter((o) => o.ownedEdits > 0);
  const targets = owners.map((o) => ({ role: o.role, file: ownerEditedFile(o.conv) })).filter((t) => t.file);
  const es = entries(findTr(r.worker_conv));
  let firstTool = null, firstLocate = null, delegate = null, wroteDiag = false;
  let fileKnown = null;            // first worker touch (grep hit OR Read) of ANY owner-edited file
  let readsBeforeKnown = 0, readsAfterKnown = 0, grepCount = 0;
  let packet = '';
  for (const e of es) {
    for (const x of e.content) {
      if (!x || x.type !== 'tool_use') continue;
      const nm = x.name, ts = e.ts;
      const f = (x.input && (x.input.file_path || x.input.path)) || '';
      const cmd = (x.input && x.input.command) || '';
      const isSearch = /Grep|Glob/.test(nm) || /\b(grep|rg|findstr|ls|dir|glob)\b/i.test(cmd);
      const isSrcRead = nm === 'Read' && /src[\\/]|test[\\/]/i.test(f);
      const touchesTarget = targets.some((t) => (f && base(f) === t.file) || (cmd && cmd.includes(t.file)) || (isSearch && targets.some((tt) => cmd.includes(tt.file.replace(/\.\w+$/, '')))));
      if (delegate) continue;                                   // only count pre-delegate activity
      if (!firstTool) firstTool = ts;
      if (isSearch) { grepCount++; if (!firstLocate) firstLocate = ts; }
      if (isSrcRead && !firstLocate) firstLocate = ts;
      if ((isSearch || isSrcRead || (nm === 'Read')) && touchesTarget && !fileKnown) fileKnown = ts;
      if (isSrcRead) { (fileKnown ? readsAfterKnown++ : readsBeforeKnown++); }
      if (/Write/.test(nm) && /\.md$/i.test(f)) wroteDiag = true;
      const dm = /\barc(?:\.cmd)?\s+delegate\s+\S+\s+([\s\S]+)/i.exec(cmd) || /\barc(?:\.cmd)?\s+note\s+\S+.*?(?:request)?\s+([\s\S]+)/i.exec(cmd);
      if (/\barc(?:\.cmd)?\s+(delegate|note)\b/i.test(cmd) && !delegate) { delegate = ts; if (dm) packet = dm[1]; }
    }
  }
  const orient = s(firstTool, delegate);
  const locate = s(firstTool, fileKnown);
  const tail = s(fileKnown, delegate);
  const locFrac = (locate != null && orient) ? +(locate / orient).toFixed(2) : null;
  // comprehension in the PACKET: line-refs / root-cause language / named invariant
  const hasLineRef = /\b\w+\.(js|ts):\d+/.test(packet);
  const hasRootCause = /SETTLED|root cause|because|invariant|uncapped|returns|delayFor|MAX_|off.by|does not|is not/i.test(packet);
  const comprehendedPacket = hasLineRef || (hasRootCause && packet.length > 120);
  console.log(`--- ${r.mode} N=${r.N} [${r.areas.join(',')}] targets=${targets.map((t) => t.role + ':' + t.file).join(', ') || '(none resolved)'}`);
  console.log(`  orient(firstTool->delegate): ${orient}s | LOCATE(->file known): ${locate}s (${locFrac != null ? Math.round(locFrac * 100) + '%' : '?'}) | COMPREHEND tail: ${tail}s`);
  console.log(`  greps: ${grepCount} | src-reads before file-known: ${readsBeforeKnown} | after: ${readsAfterKnown} | wrote diagnosis .md: ${wroteDiag}`);
  console.log(`  packet: lineRef=${hasLineRef} rootCauseLang=${hasRootCause} len=${packet.length} => COMPREHENDED HAND-OFF: ${comprehendedPacket}`);
  console.log(`  packet head: ${packet.slice(0, 140).replace(/\s+/g, ' ')}\n`);
  if (locFrac != null) LOC.push(locFrac);
}
const med = (a) => a.length ? a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)] : null;
console.log(`MEDIAN locate-fraction of orient (n=${LOC.length}): ${med(LOC) != null ? Math.round(med(LOC) * 100) + '%' : '-'}  (low => cheap locate + long comprehend tail => code's axis 1 holds; high => locate itself is the cost => axis 1 fails)`);
