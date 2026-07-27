const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { adapters } = require('../conformance/adapters');
const { assertConformantTrace } = require('../conformance/v1/reducer');

const root = path.resolve(__dirname, '..');
const workflowSource = fs.readFileSync(path.join(root, 'workflows', 'round.js'), 'utf8')
  .replace(/^export const meta/m, 'const meta');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

async function runRound(findingFactory, verdictFactory, args = {}) {
  const angles = [
    { lens: 'one', question: 'q1' },
    { lens: 'two', question: 'q2' },
    { lens: 'three', question: 'q3' },
  ];

  const agent = async (_prompt, options) => {
    if (options.label === 'diverge') return { angles };
    if (options.label.startsWith('investigate:')) return findingFactory(options.label);
    if (options.label.startsWith('skeptic:')) return verdictFactory(options.label);
    throw new Error(`unexpected agent label: ${options.label}`);
  };
  const pipeline = async (items, investigate, verify) => Promise.all(
    items.map(async (item) => verify(await investigate(item), item)),
  );
  const execute = new AsyncFunction('args', 'agent', 'pipeline', 'phase', 'log', workflowSource);
  return execute({
    brief: 'Test brief',
    direction: 'Test direction',
    limiter: 'Test limiter',
    ...args,
  }, agent, pipeline, () => {}, () => {});
}

const keepVerdict = () => ({
  grounded: true,
  onBrief: true,
  novel: false,
  redundant: false,
  significance: 2,
  verdict: 'keep',
  note: 'supported',
});

test('collector rejects empty and malformed citations despite a keep verdict', async () => {
  const result = await runRound(() => ({
    claim: 'Unsupported claim',
    evidence: ['A model says this is evidence'],
    sources: ['not-a-url'],
    limitations: ['Unknown'],
    incremental: true,
  }), keepVerdict);

  assert.equal(result.clean, true);
  assert.equal(result.dry, true);
  assert.equal(result.roundFindings.length, 0);
  assert.equal(result.judged, 3);
  assert.deepEqual(assertConformantTrace(result.trace), {
    attempted: 3,
    judged: 3,
    failed: 0,
    clean: true,
    dry: true,
    roundFailed: false,
    kept: [],
    unverified: [],
    escalations: [],
  });
});

test('collector preserves auditable fields and clamps significance', async () => {
  const result = await runRound(() => ({
    claim: 'Supported claim',
    evidence: ['The official documentation states the behavior'],
    sources: [' https://example.com/docs ', 'https://example.com/docs'],
    limitations: ['Applies only to the documented version'],
    incremental: true,
  }), keepVerdict, { escalateBar: 9, now: '2026-07-25T12:00:00.000Z' });

  assert.equal(result.dry, false);
  assert.equal(result.roundFindings.length, 3);
  assert.equal(result.roundFindings[0].significance, 1);
  assert.deepEqual(result.roundFindings[0].sources, ['https://example.com/docs']);
  assert.deepEqual(result.roundFindings[0].evidence, ['The official documentation states the behavior']);
  assert.deepEqual(result.roundFindings[0].limitations, ['Applies only to the documented version']);
  // `new Date()` is unavailable in the Workflow sandbox, so the stamp must arrive via args.
  assert.equal(result.roundFindings[0].verifiedAt, '2026-07-25T12:00:00.000Z');
  assert.equal(result.roundFindings[0].evidenceAudit.status, 'missing');
  assert.equal(result.escalate.length, 3);
  assert.equal(adapters.get('claude').toTrace(result), result.trace);
  assert.deepEqual(assertConformantTrace(result.trace).escalations, ['angle-1', 'angle-2', 'angle-3']);
});

// ---- regression guards for the "silent fake-dry" class of bug -------------------------
// Lived failure: the Workflow sandbox exposes no `URL` global, the ReferenceError was
// swallowed as "invalid source", every finding failed the support check, and the round
// reported `dry: true` — "found nothing" — while the skeptic had approved all of them.
// Plain Node HAS `URL` and `Date`, so the suite could never see it. These tests remove
// those globals the way the sandbox does.

async function runRoundWithoutGlobals(findingFactory, verdictFactory, args = {}) {
  const angles = [
    { lens: 'one', question: 'q1' },
    { lens: 'two', question: 'q2' },
    { lens: 'three', question: 'q3' },
  ];
  const agent = async (_prompt, options) => {
    if (options.label === 'diverge') return { angles };
    if (options.label.startsWith('investigate:')) return findingFactory(options.label);
    if (options.label.startsWith('skeptic:')) return verdictFactory(options.label);
    throw new Error(`unexpected agent label: ${options.label}`);
  };
  const pipeline = async (items, investigate, verify) => Promise.all(
    items.map(async (item) => verify(await investigate(item), item)),
  );
  // shadow the sandbox-forbidden globals inside the workflow's own scope
  const execute = new AsyncFunction(
    'args', 'agent', 'pipeline', 'phase', 'log', 'URL', 'Date',
    workflowSource,
  );
  return execute(
    { brief: 'Test brief', direction: 'Test direction', limiter: 'Test limiter', ...args },
    agent, pipeline, () => {}, () => {},
    undefined, undefined,
  );
}

test('round survives a sandbox with no URL global (the fake-dry bug)', async () => {
  const result = await runRoundWithoutGlobals(() => ({
    claim: 'Supported claim',
    evidence: ['The official documentation states the behavior'],
    sources: ['https://support.google.com/accounts/answer/114129'],
    limitations: ['Applies only to the documented version'],
    incremental: true,
  }), keepVerdict, { now: '2026-07-25T12:00:00.000Z' });

  // Before the fix this was dry:true / 0 findings — research silently thrown away.
  assert.equal(result.roundFindings.length, 3, 'valid https sources must survive without a URL global');
  assert.equal(result.dry, false);
  assert.equal(result.drySuspect, false);
  assert.deepEqual(result.roundFindings[0].sources, ['https://support.google.com/accounts/answer/114129']);
});

test('round does not touch Date (unavailable in the Workflow sandbox)', async () => {
  // Would throw "Date.now() / new Date() are unavailable in workflow scripts" at runtime.
  const result = await runRoundWithoutGlobals(() => ({
    claim: 'Supported claim',
    evidence: ['Documented behavior'],
    sources: ['https://example.com/docs'],
    limitations: ['Scoped'],
    incremental: true,
  }), keepVerdict, { now: '2026-07-25T12:00:00.000Z' });
  assert.equal(result.roundFindings[0].verifiedAt, '2026-07-25T12:00:00.000Z');
  assert.doesNotMatch(workflowSource, /new Date\(|Date\.now\(/,
    'round.js must never call Date — the sandbox shims it to throw');
});

test('a dry round proves itself: honest dry vs harness-eaten dry', async () => {
  // 1) Model genuinely returned junk sources -> honest drop, NOT flagged as suspect.
  const honest = await runRound(() => ({
    claim: 'Unsupported claim',
    evidence: ['A model says this is evidence'],
    sources: ['not-a-url'],
    limitations: ['Unknown'],
    incremental: true,
  }), keepVerdict);
  assert.equal(honest.dry, true);
  assert.equal(honest.drySuspect, false, 'junk sources from the model are an honest drop');
  assert.equal(honest.dropped.length, 3);
  assert.match(honest.dropped[0].reasons.join(','), /local:no-valid-source-url/);

  // 2) The skeptic killed everything -> honest dry, reason attributed to the skeptic.
  const killed = await runRound(() => ({
    claim: 'Supported claim',
    evidence: ['Documented'],
    sources: ['https://example.com/docs'],
    limitations: ['Scoped'],
    incremental: true,
  }), () => ({ ...keepVerdict(), verdict: 'kill' }));
  assert.equal(killed.dry, true);
  assert.equal(killed.drySuspect, false);
  assert.match(killed.dropped[0].reasons.join(','), /skeptic:kill/);

  // 3) The contradiction: url-shaped source that still normalizes to nothing -> SUSPECT.
  const suspect = await runRound(() => ({
    claim: 'Supported claim',
    evidence: ['Documented'],
    sources: ['https://'],
    limitations: ['Scoped'],
    incremental: true,
  }), keepVerdict);
  assert.equal(suspect.dry, true);
  assert.equal(suspect.drySuspect, true, 'url-shaped-but-unusable sources must raise drySuspect');
  assert.match(String(suspect.note), /SUSPECT DRY/);
  // THE PROOF MUST RIDE THE TRACE, not only the returned object. The trace is what an operator reads
  // back afterwards, and "dry: true" alone there is the bare assertion this machinery exists to
  // forbid — the returned copy is no help to anyone reconstructing a run from its trace.
  const done = suspect.trace[suspect.trace.length - 1];
  assert.equal(done.type, 'round.completed');
  assert.equal(done.data.drySuspect, true, 'a SUSPECT dry round must say so in its own trace');
  assert.ok(Array.isArray(done.data.dropped) && done.data.dropped.length > 0,
    'the trace must carry the per-finding drop reasons, not just the count');
  assert.match(String(done.data.dropped[0].reasons.join(',')), /local:no-valid-source-url/);
});

// LEVER 3 — a placeholder finding must not burn its angle. Observed: an investigator returned
// `claim:"test", evidence:["a"]`; the skeptic killed it correctly and the round's actual subject was
// spent. A stub is now rejected BEFORE the skeptic and counted as a LOST angle, never a judged one —
// counting it as judged is what lets a broken probe read as "we looked and found nothing".
test('lever 3: a placeholder finding is rejected before the skeptic and the angle is retryable', async () => {
  let skepticCalls = 0;
  const result = await runRound(
    (label) => label.endsWith('two')
      ? { claim: 'test', evidence: ['a'], sources: ['https://example.com/x'], limitations: ['none'], incremental: true }
      : { claim: 'A properly stated claim', evidence: ['The source supports the claim'], sources: ['https://example.com/docs'], limitations: ['Fixture'], incremental: true },
    () => { skepticCalls += 1; return keepVerdict(); },
    { roundId: 'stub-round' },
  );
  assert.equal(skepticCalls, 2, 'the stub angle must NOT spend a skeptic');
  assert.equal(result.judged, 2, 'a stub is not a judged angle');
  assert.equal(result.failed, 1, 'it is a LOST angle — the round must report thin coverage, not a clean dry');
  assert.equal(result.clean, false);
  assert.equal(result.stubbed.length, 1);
  assert.equal(result.stubbed[0].lens, 'two');
  assert.match(result.stubbed[0].reasons.join(','), /placeholder-claim/);
  assert.equal(result.roundFindings.length, 2, 'the healthy angles are unaffected');
  const failedTrace = result.trace.filter((e) => e.type === 'investigation.failed' && e.data.kind === 'stub');
  assert.equal(failedTrace.length, 1, 'the trace must name the stub, so the angle can be retried');
});

// LEVER 2 — gate at the CLAIM, not only the finding. Measured cost: a finding kept at 0.75 still
// carrying a quote the skeptic had just called likely-fabricated. Keep/kill on the whole finding is
// too blunt; a contradicted claim row is stripped, and a finding with nothing left is dropped.
test('lever 2: a contradicted claim is stripped from a kept finding, and gutting one drops it', async () => {
  const withClaims = (ids) => ({
    claim: 'A properly stated claim',
    evidence: ['The source supports the claim'],
    sources: ['https://example.com/docs'],
    limitations: ['Fixture'],
    incremental: true,
    claimEvidence: ids.map((id) => ({
      claimId: id, claim: `claim ${id}`,
      citations: [{ sourceUrl: 'https://example.com/docs', passage: `passage for ${id}` }],
    })),
  });
  // angle one: c1 contradicted, c2 fine -> STRIP c1, keep the finding
  // angle two: its only claim contradicted -> GUTTED, finding dropped
  // angle three: no claim rows at all -> untouched (legacy findings must still pass)
  const result = await runRound(
    (label) => label.endsWith('one') ? withClaims(['c1', 'c2'])
      : label.endsWith('two') ? withClaims(['c1'])
        : { claim: 'A properly stated claim', evidence: ['Supported'], sources: ['https://example.com/docs'], limitations: ['Fixture'], incremental: true },
    (label) => label.endsWith('three') ? keepVerdict() : ({
      ...keepVerdict(),
      claimChecks: [{ claimId: 'c1', relation: 'contradiction', rationale: 'the passage does not support it' }],
    }),
    { roundId: 'claim-gate-round' },
  );
  const lenses = result.roundFindings.map((f) => f.lens).sort();
  assert.deepEqual(lenses, ['one', 'three'], 'the gutted finding is dropped; the others survive');
  const one = result.roundFindings.find((f) => f.lens === 'one');
  assert.deepEqual(one.claimEvidence.map((c) => c.claimId), ['c2'], 'only the surviving claim ships');
  assert.deepEqual(one.strippedClaims, ['c1'], 'and what was removed is NAMED, never silently shortened');
  // the drop must prove itself, like every other drop in this engine
  const gutted = result.dropped.find((d) => d.lens === 'two');
  assert.ok(gutted, 'a claim-gated drop must appear in dropped[]');
  assert.match(gutted.reasons.join(','), /claim-gate:all-claims-contradicted/);
});

// LEVER 4 — the project's own settled conclusions must reach the people DOING the work. An angle was
// killed as redundant against a doc the investigator never saw and the skeptic found afterwards.
test('lever 4: priorWork reaches BOTH the planner and the investigator, not just the judge', async () => {
  const prompts = [];
  const angles = [{ lens: 'one', question: 'q1' }];
  const agent = async (prompt, options) => {
    prompts.push([options.label, prompt]);
    if (options.label === 'diverge') return { angles };
    if (options.label.startsWith('investigate:')) {
      return { claim: 'A properly stated claim', evidence: ['Supported'], sources: ['https://example.com/docs'], limitations: ['Fixture'], incremental: true };
    }
    return keepVerdict();
  };
  const pipeline = async (items, investigate, verify) => Promise.all(
    items.map(async (item) => verify(await investigate(item), item)),
  );
  const execute = new AsyncFunction('args', 'agent', 'pipeline', 'phase', 'log', workflowSource);
  await execute({
    brief: 'Test brief', direction: 'Test direction', limiter: 'Test limiter',
    roundId: 'prior-work-round', priorWork: 'maf-scan-2026-07-17.md: compaction blindness is settled',
  }, agent, pipeline, () => {}, () => {});
  const seenBy = (kind) => prompts.filter(([label]) => label.startsWith(kind)).map(([, p]) => p).join('\n');
  assert.match(seenBy('diverge'), /ALREADY SETTLED BY THIS PROJECT/, 'the planner must not propose a settled angle');
  assert.match(seenBy('diverge'), /compaction blindness is settled/);
  assert.match(seenBy('investigate:'), /ALREADY SETTLED BY THIS PROJECT/, 'the investigator must not re-derive it');
  assert.match(seenBy('investigate:'), /compaction blindness is settled/);
});

test('workflow trace preserves partial investigator and skeptic failures', async () => {
  const finding = (label) => label.endsWith('three') ? null : ({
    claim: `Supported claim from ${label}`,
    evidence: ['The source supports the claim'],
    sources: ['https://example.com/docs'],
    limitations: ['Fixture only'],
    incremental: true,
  });
  const verdict = (label) => label.endsWith('two') ? null : keepVerdict();
  const result = await runRound(finding, verdict, { roundId: 'partial-round' });

  assert.equal(result.clean, false);
  assert.equal(result.roundFailed, false);
  assert.equal(result.roundFindings.length, 1);
  assert.equal(result.unverified.length, 1);
  assert.deepEqual(assertConformantTrace(result.trace), {
    attempted: 3,
    judged: 1,
    failed: 2,
    clean: false,
    dry: false,
    roundFailed: false,
    kept: ['angle-1'],
    unverified: ['angle-2'],
    escalations: ['angle-1'],
  });
});

test('workflow trace distinguishes abort and total worker failure from dry rounds', async () => {
  const aborted = await runRound(() => null, () => null, { brief: '', roundId: 'no-brief' });
  assert.equal(aborted.error, 'no-brief');
  assert.deepEqual(assertConformantTrace(aborted.trace), {
    attempted: 0,
    judged: 0,
    failed: 1,
    clean: false,
    dry: false,
    roundFailed: true,
    kept: [],
    unverified: [],
    escalations: [],
  });

  const failed = await runRound(() => null, () => null, { roundId: 'all-workers-failed' });
  const projection = assertConformantTrace(failed.trace);
  assert.equal(failed.roundFailed, true);
  assert.equal(failed.dry, false);
  assert.equal(projection.roundFailed, true);
  assert.equal(projection.dry, false);
  assert.equal(projection.failed, 3);
});

test('claim-level evidence runs in audit mode without breaking legacy admission', async () => {
  const finding = () => ({
    claim: 'A material claim with localized support',
    evidence: ['The official source supports the material claim'],
    sources: ['https://example.com/primary'],
    limitations: ['Audit fixture only'],
    incremental: true,
    claimEvidence: [{
      claimId: 'c1',
      claim: 'The material claim is true.',
      citations: [{
        sourceUrl: 'https://example.com/primary',
        passage: 'A short exact passage supporting the material claim.',
        fetchedAt: '2026-07-13T00:00:00Z',
      }],
    }],
  });
  const entailed = () => ({
    ...keepVerdict(),
    claimChecks: [{ claimId: 'c1', relation: 'entailment', rationale: 'The passage supports c1.' }],
  });
  const passed = await runRound(finding, entailed);
  assert.equal(passed.roundFindings.length, 3);
  assert.deepEqual(passed.roundFindings[0].evidenceAudit, {
    mode: 'audit',
    status: 'pass',
    claims: 1,
    entailment: 1,
    neutral: 0,
    contradiction: 0,
    unchecked: 0,
    reasons: [],
  });
  assert.equal(passed.roundFindings[0].claimEvidence[0].citations[0].passage,
    'A short exact passage supporting the material claim.');

  const neutral = () => ({
    ...keepVerdict(),
    claimChecks: [{ claimId: 'c1', relation: 'neutral', rationale: 'The passage is related but insufficient.' }],
  });
  const review = await runRound(finding, neutral);
  assert.equal(review.roundFindings.length, 3);
  assert.equal(review.roundFindings[0].evidenceAudit.status, 'review');
  assert.equal(review.roundFindings[0].evidenceAudit.neutral, 1);
  assert.deepEqual(review.roundFindings[0].evidenceAudit.reasons, ['c1:neutral']);
});
