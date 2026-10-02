/**
 * Decision-model fallthrough seam tests (quick 261001-wzs, D11/D14/D18).
 *
 * Asserts the built artifact `gsd-core/bin/lib/decision-model-fallthrough.cjs`, which
 * `npm run build:lib` emits from `src/decision-model-fallthrough.cts`: the capability gate that
 * runs before the engine is loaded, the own-property-safe answer lookup, the locked provenance
 * line and the engine-throw fallback. Site behavior lives in each site's own test file.
 */
'use strict';
process.env.GSD_TEST_MODE = '1';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { cleanup } = require('./helpers.cjs');
const { runNode } = require('./helpers/process-seam.cjs');
const { PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');

const LIB = path.join(__dirname, '..', 'gsd-core', 'bin', 'lib');
const seam = require(path.join(LIB, 'decision-model-fallthrough.cjs'));

/** A temp project whose .planning/config.json carries only decision_model, plus a temp GSD_HOME. */
function makeProject(t, decisionModel) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-dmf-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-dmf-home-'));
  t.after(() => { cleanup(dir); cleanup(home); });
  fs.mkdirSync(path.join(dir, '.planning'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.planning', 'config.json'), JSON.stringify({ decision_model: decisionModel }));
  return { dir, home };
}

describe('decision-model-fallthrough: constants', () => {
  test('the capability id and batch cap match the engine', () => {
    const engine = require(path.join(LIB, 'decision-model.cjs'));
    assert.equal(seam.DECISION_MODEL_CAPABILITY_ID, engine.CAPABILITY_ID);
    assert.equal(seam.MAX_BATCH_QUESTIONS, 256);
  });
});

describe('decision-model-fallthrough: resolveDecide gate', () => {
  test('returns null when the capability is off in the project config', (t) => {
    const { dir, home } = makeProject(t, { enabled: false });
    const prev = process.env.GSD_HOME;
    process.env.GSD_HOME = home;
    t.after(() => { if (prev === undefined) delete process.env.GSD_HOME; else process.env.GSD_HOME = prev; });
    assert.equal(seam.resolveDecide(dir), null);
  });

  test('an inactive project never loads the engine module (subprocess require.cache check)', (t) => {
    const { dir, home } = makeProject(t, { enabled: false });
    const script = `
      const ep = require(${JSON.stringify(path.join(LIB, 'edge-probe.cjs'))});
      const report = ep.proposeCoverageWithDecisionModel([{ id: 'R2', text: 'uno dos tres' }], { cwd: process.cwd() });
      const loaded = Object.keys(require.cache).filter((k) => /[\\\\/]decision-model\\.cjs$/.test(k));
      process.stdout.write(JSON.stringify({ loaded, items: report.items.length, annotated: report.items.some((i) => 'model_proposal' in i) }));
    `;
    const r = runNode(['-e', script], {
      cwd: dir, timeoutMs: PROBE_TIMEOUT_MS,
      env: { ...process.env, HOME: home, USERPROFILE: home, GSD_HOME: home },
    });
    assert.equal(r.exitCode, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), { loaded: [], items: 1, annotated: false });
    assert.equal(r.stderr, '');
  });

  test('an active capability yields a function without calling the engine', () => {
    let loaded = 0;
    const decide = seam.resolveDecide('/tmp/x', {
      isActive: (id, cwd) => { assert.equal(id, 'decision-model'); assert.equal(cwd, '/tmp/x'); return true; },
      loadEngine: () => { loaded += 1; return { decideSync: () => ({ ok: true }) }; },
    });
    assert.equal(typeof decide, 'function');
    assert.equal(loaded, 0, 'the engine is required only when the DecideFn is called');
    assert.deepEqual(decide({ requests: [] }), { ok: true });
    assert.equal(loaded, 1);
  });

  test('a throwing capability check is treated as inactive', () => {
    assert.equal(seam.resolveDecide('/tmp/x', { isActive: () => { throw new Error('x'); } }), null);
  });

  test('an engine throw gives null and exactly one stderr line starting "decision-model: call failed"', () => {
    const decide = seam.resolveDecide('/tmp/x', {
      isActive: () => true,
      loadEngine: () => ({ decideSync: () => { throw new Error('boom'); } }),
    });
    const writes = [];
    const orig = process.stderr.write;
    process.stderr.write = (chunk) => { writes.push(String(chunk)); return true; };
    let out;
    try { out = decide({ requests: [] }); } finally { process.stderr.write = orig; }
    assert.equal(out, null);
    assert.equal(writes.length, 1);
    assert.match(writes[0], /^decision-model: call failed \(boom\); continuing without it\n$/);
  });

  test('resolveSiteDecide honours an injected function, an explicit null, and otherwise resolves via the gate', () => {
    const fn = () => null;
    assert.equal(seam.resolveSiteDecide({ decide: fn }), fn);
    assert.equal(seam.resolveSiteDecide({ decide: null }), null);
  });
});

describe('decision-model-fallthrough: answersFor / okYes / okChoice', () => {
  const response = {
    results: [
      { id: 'a', answers: { q: { status: 'ok', answer: 'yes' } } },
      { id: '__proto__', answers: { q: 1 } },
      { id: 'constructor', answers: { q: 1 } },
      { id: 'prototype', answers: { q: 1 } },
      { id: 'bad', answers: 'text' },
      { id: 'arr', answers: [] },
    ],
  };

  test('finds an own answers object by id', () => {
    assert.deepEqual(seam.answersFor(response, 'a'), { q: { status: 'ok', answer: 'yes' } });
  });

  test('ignores the pollution ids, non-object answers and unusable responses', () => {
    for (const id of ['__proto__', 'constructor', 'prototype', 'bad', 'arr', 'missing']) {
      assert.equal(seam.answersFor(response, id), null, id);
    }
    for (const r of [null, undefined, 'x', 3, [], {}, { results: 'x' }, { results: [null, 4] }]) {
      assert.equal(seam.answersFor(r, 'a'), null);
    }
  });

  test('answerOf is own-property only', () => {
    assert.equal(seam.answerOf({ q: 1 }, 'q'), 1);
    assert.equal(seam.answerOf({}, 'toString'), undefined);
    assert.equal(seam.answerOf({ q: 1 }, '__proto__'), undefined);
    assert.equal(seam.answerOf(null, 'q'), undefined);
  });

  test('okYes and okChoice accept only status ok', () => {
    assert.equal(seam.okYes({ status: 'ok', answer: 'yes' }), true);
    assert.equal(seam.okYes({ status: 'ok', answer: 'no' }), false);
    assert.equal(seam.okYes({ status: 'abstain', answer: 'yes' }), false);
    assert.equal(seam.okYes(null), false);
    assert.equal(seam.okChoice({ status: 'ok', choice: 'x' }), 'x');
    assert.equal(seam.okChoice({ status: 'abstain', reason: 'low-confidence', choice: 'x' }), null);
    assert.equal(seam.okChoice({ status: 'ok', choice: 7 }), null);
    assert.equal(seam.okChoice('x'), null);
  });
});

describe('decision-model-fallthrough: decidedBy', () => {
  test('formats the locked D14 line with two-decimal confidence and the response backend', () => {
    assert.equal(
      seam.decidedBy({ status: 'ok', confidence: 0.97 }, { backend: 'openai-letter' }),
      'decided-by: decision-model (conf 0.97, backend openai-letter)',
    );
    assert.equal(
      seam.decidedBy({ status: 'ok', confidence: 0.9 }, { backend: 'jev' }),
      'decided-by: decision-model (conf 0.90, backend jev)',
    );
    assert.equal(
      seam.decidedBy({ status: 'ok', confidence: 0.934 }, { backend: 'jev' }),
      'decided-by: decision-model (conf 0.93, backend jev)',
    );
  });

  test('a missing backend reads unknown', () => {
    for (const r of [{}, null, { backend: '' }, { backend: 4 }]) {
      assert.equal(seam.decidedBy({ confidence: 0.5 }, r), 'decided-by: decision-model (conf 0.50, backend unknown)');
    }
  });
});

describe('decision-model-fallthrough: per-site wall budget (CR-01)', () => {
  const noul = { type: 'noul', instructions: 'Yes or no?' };
  const item = (i) => ({ id: `r${i}`, state: `s${i}`, questions: { a: noul, b: noul, c: noul, d: noul, e: noul } });
  const ok = { status: 'ok', answer: 'yes', p_yes: 0.97, confidence: 0.97 };
  const answersOf = (r, a) => Object.fromEntries(Object.keys(r.questions).map((k) => [k, a]));

  /** A fake clock plus a decide that costs `costMs` per call and answers every question with `answer(i)`. */
  function clocked(costMs, answer = () => ok) {
    let t = 0;
    const calls = [];
    const decide = (request, limits) => {
      calls.push({ request, limits, at: t });
      t += costMs;
      const r = request.requests[0];
      return { backend: 'openai-letter', results: [{ id: r.id, answers: answersOf(r, answer(calls.length - 1)) }] };
    };
    return { decide, calls, now: () => t };
  }

  test('the budget is 60000 ms; a test-mode env value may only lower it', () => {
    assert.equal(seam.SITE_WALL_BUDGET_MS, 60000);
    assert.equal(seam.siteBudgetMs({}), 60000);
    assert.equal(seam.siteBudgetMs({ GSD_DECISION_MODEL_SITE_BUDGET_MS: '5000' }), 60000, 'ignored outside GSD_TEST_MODE');
    assert.equal(seam.siteBudgetMs({ GSD_TEST_MODE: '1', GSD_DECISION_MODEL_SITE_BUDGET_MS: '5000' }), 5000);
    for (const raw of ['600000', '0', '-5', '1e4', 'abc', '']) {
      assert.equal(seam.siteBudgetMs({ GSD_TEST_MODE: '1', GSD_DECISION_MODEL_SITE_BUDGET_MS: raw }), 60000, raw);
    }
  });

  test('one call per item, in order, each with the remaining budget as its time limit', () => {
    const { decide, calls, now } = clocked(4000);
    const run = seam.decideWithinBudget(decide, { requests: [item(0), item(1), item(2)] }, { now });
    assert.deepEqual(calls.map((c) => c.request.requests.map((r) => r.id)), [['r0'], ['r1'], ['r2']]);
    assert.deepEqual(calls.map((c) => c.limits.timeoutMs), [60000, 56000, 52000]);
    assert.equal(run.asked, 3);
    assert.equal(run.outOfTime, false);
    assert.deepEqual(run.response.results.map((r) => r.id), ['r0', 'r1', 'r2']);
    assert.equal(run.response.backend, 'openai-letter');
  });

  test('no item starts unless its conservative estimate fits in what is left (3 s a question, 9 s cold start)', () => {
    const { decide, calls, now } = clocked(4000);
    const requests = Array.from({ length: 20 }, (_, i) => item(i));
    const run = seam.decideWithinBudget(decide, { requests }, { now });
    // Items start at 0, 4, ... 44 s; at 48 s only 12 s remain, under the 15 s a 5-question item needs.
    assert.equal(run.asked, 12);
    assert.equal(run.outOfTime, true);
    assert.equal(calls[calls.length - 1].at, 44000);
    assert.deepEqual(run.response.results.map((r) => r.id), requests.slice(0, 12).map((r) => r.id));
    let reads = 0;
    const late = () => (reads++ === 0 ? 0 : 36001); // 23999 ms left when the first item would start
    const first = seam.decideWithinBudget(clocked(1).decide, { requests: [item(0)] }, { now: late });
    assert.equal(first.asked, 0, 'a cold first item needs 9 s plus 3 s a question');
    assert.equal(first.outOfTime, true);
    assert.equal(first.response, null);
  });

  test('a timeout abstain stops the pass as out of time; an unreachable one stops it quietly', () => {
    const timeout = clocked(1000, () => ({ status: 'abstain', reason: 'timeout' }));
    const t = seam.decideWithinBudget(timeout.decide, { requests: [item(0), item(1)] }, { now: timeout.now });
    assert.equal(t.asked, 1);
    assert.equal(t.outOfTime, true);
    const down = clocked(1000, () => ({ status: 'abstain', reason: 'unreachable' }));
    const u = seam.decideWithinBudget(down.decide, { requests: [item(0), item(1)] }, { now: down.now });
    assert.equal(u.asked, 1);
    assert.equal(u.outOfTime, false);
    const low = clocked(1000, () => ({ status: 'abstain', reason: 'low-confidence' }));
    assert.equal(seam.decideWithinBudget(low.decide, { requests: [item(0), item(1)] }, { now: low.now }).asked, 2);
  });

  test('a null or answerless response stops the pass and is not merged', () => {
    for (const bad of [null, 'x', {}, { results: [{ id: 'other', answers: {} }] }]) {
      const calls = [];
      const run = seam.decideWithinBudget((req) => { calls.push(req); return bad; }, { requests: [item(0), item(1)] }, { now: () => 0 });
      assert.equal(calls.length, 1, JSON.stringify(bad));
      assert.equal(run.response, null);
      assert.equal(run.outOfTime, false);
    }
  });

  test('resolveDecide bounds the engine child by the time limit through decideSync\'s spawn option', () => {
    // Fixture values, not subprocess bounds: the engine's own budget cap and a caller limit below it.
    const ENGINE_BUDGET_MS = 900000;
    const LIMIT_MS = 5000;
    const seen = [];
    const spawned = [];
    const decide = seam.resolveDecide('/tmp/x', {
      isActive: () => true,
      loadEngine: () => ({ decideSync: (request, opts) => { seen.push(opts); return opts._spawn ? opts._spawn('node', ['child'], { timeout: ENGINE_BUDGET_MS, windowsHide: true, input: 'x' }) : null; } }),
      spawn: (cmd, args, options) => { spawned.push({ cmd, args, options }); return { status: 0 }; },
    });
    decide({ requests: [] });
    assert.deepEqual(seen[0], { cwd: '/tmp/x' }, 'no limit: the engine budget is used as is');
    decide({ requests: [] }, { timeoutMs: LIMIT_MS });
    assert.equal(typeof seen[1]._spawn, 'function');
    assert.equal(spawned.length, 1);
    assert.ok(spawned[0].options.timeout > 0 && spawned[0].options.timeout <= LIMIT_MS, String(spawned[0].options.timeout));
    assert.equal(spawned[0].options.windowsHide, true);
    assert.equal(spawned[0].options.input, 'x');
    assert.deepEqual([spawned[0].cmd, spawned[0].args], ['node', ['child']]);
  });
});
