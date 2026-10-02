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

  test('resolveSiteDecide honours an injected function, an explicit null, and otherwise resolves via the gate', (t) => {
    const fn = () => null;
    assert.equal(seam.resolveSiteDecide({ decide: fn }), fn);
    assert.equal(seam.resolveSiteDecide({ decide: null }), null);
    // IN-07: the undefined-decide branch goes through the real gate for opts.cwd.
    const { dir, home } = makeProject(t, { enabled: false });
    const prev = process.env.GSD_HOME;
    process.env.GSD_HOME = home;
    t.after(() => { if (prev === undefined) delete process.env.GSD_HOME; else process.env.GSD_HOME = prev; });
    assert.equal(seam.resolveSiteDecide({ cwd: dir }), null);
    const on = makeProject(t, { enabled: true, model: 'fake-model' });
    assert.equal(typeof seam.resolveSiteDecide({ cwd: on.dir }), 'function', 'an enabled project resolves to a decide function');
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

  test('IN-03: an answer with no finite confidence reads conf n/a, never a fake 0.00', () => {
    for (const answer of [{ status: 'ok' }, { status: 'ok', confidence: 'high' }, { status: 'ok', confidence: NaN }, null]) {
      assert.equal(seam.decidedBy(answer, { backend: 'openai-letter' }), 'decided-by: decision-model (conf n/a, backend openai-letter)');
    }
    assert.equal(seam.decidedBy({ status: 'ok', confidence: 0 }, { backend: 'jev' }), 'decided-by: decision-model (conf 0.00, backend jev)');
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

  /** A decide that records its calls and answers every question of every item with `answer(item index)`. */
  function recorder(answer = () => ok) {
    const calls = [];
    const decide = (request, limits) => {
      calls.push({ request, limits });
      return { backend: 'openai-letter', results: request.requests.map((r, i) => ({ id: r.id, answers: answersOf(r, answer(i)) })) };
    };
    return { decide, calls };
  }
  const timeoutAbstain = { status: 'abstain', reason: 'timeout' };

  test('the budget is 60000 ms; a test-mode env value may only lower it', () => {
    assert.equal(seam.SITE_WALL_BUDGET_MS, 60000);
    assert.equal(seam.siteBudgetMs({}), 60000);
    assert.equal(seam.siteBudgetMs({ GSD_DECISION_MODEL_SITE_BUDGET_MS: '5000' }), 60000, 'ignored outside GSD_TEST_MODE');
    assert.equal(seam.siteBudgetMs({ GSD_TEST_MODE: '1', GSD_DECISION_MODEL_SITE_BUDGET_MS: '5000' }), 5000);
    for (const raw of ['600000', '0', '-5', '1e4', 'abc', '']) {
      assert.equal(seam.siteBudgetMs({ GSD_TEST_MODE: '1', GSD_DECISION_MODEL_SITE_BUDGET_MS: raw }), 60000, raw);
    }
  });

  test('one batched call carries every item in order, with the site budget as budgetMs', () => {
    const { decide, calls } = recorder();
    const requests = [item(0), item(1), item(2)];
    const run = seam.decideWithinBudget(decide, { requests });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].request, { requests });
    assert.deepEqual(calls[0].limits, { budgetMs: 60000 });
    assert.equal(run.asked, 3);
    assert.equal(run.outOfTime, false);
    assert.deepEqual(run.response.results.map((r) => r.id), ['r0', 'r1', 'r2']);
    assert.equal(run.response.backend, 'openai-letter');
    seam.decideWithinBudget(decide, { requests }, { budgetMs: 1234 });
    assert.deepEqual(calls[1].limits, { budgetMs: 1234 }, 'an explicit budget replaces the site budget');
  });

  test('an item with any timeout abstain is dropped whole and marks the pass out of time', () => {
    // r0 answered, r1 cut mid-item (first question answered, the rest timeout), r2 never reached.
    const { decide } = recorder(() => timeoutAbstain);
    const partial = (request) => ({
      backend: 'openai-letter',
      results: request.requests.map((r, i) => ({
        id: r.id,
        answers: i === 0 ? answersOf(r, ok) : i === 1 ? { a: ok, b: timeoutAbstain, c: timeoutAbstain, d: timeoutAbstain, e: timeoutAbstain } : answersOf(r, timeoutAbstain),
      })),
    });
    const run = seam.decideWithinBudget(partial, { requests: [item(0), item(1), item(2)] });
    assert.equal(run.asked, 3);
    assert.equal(run.outOfTime, true);
    assert.deepEqual(run.response.results.map((r) => r.id), ['r0'], 'only the complete item survives, so no half-labelled proposal');
    const none = seam.decideWithinBudget(decide, { requests: [item(0), item(1)] });
    assert.equal(none.response, null);
    assert.equal(none.outOfTime, true);
  });

  test('other abstains are complete answers: kept, and not out of time', () => {
    for (const reason of ['unreachable', 'low-confidence', 'model-missing']) {
      const { decide } = recorder(() => ({ status: 'abstain', reason }));
      const run = seam.decideWithinBudget(decide, { requests: [item(0), item(1)] });
      assert.equal(run.outOfTime, false, reason);
      assert.deepEqual(run.response.results.map((r) => r.id), ['r0', 'r1'], reason);
    }
  });

  test('an item missing a question answer is dropped, quietly', () => {
    const decide = (request) => ({ results: [{ id: 'r0', answers: { a: ok } }, { id: 'r1', answers: answersOf(request.requests[1], ok) }] });
    const run = seam.decideWithinBudget(decide, { requests: [item(0), item(1)] });
    assert.deepEqual(run.response.results.map((r) => r.id), ['r1']);
    assert.equal(run.outOfTime, false);
  });

  test('a null or answerless response is one call and is not merged', () => {
    for (const bad of [null, 'x', {}, { results: [{ id: 'other', answers: {} }] }]) {
      const calls = [];
      const run = seam.decideWithinBudget((req) => { calls.push(req); return bad; }, { requests: [item(0), item(1)] });
      assert.equal(calls.length, 1, JSON.stringify(bad));
      assert.equal(run.response, null);
      assert.equal(run.outOfTime, false);
    }
  });

  test('resolveDecide passes the budget to decideSync as budgetMs, and only a positive finite one', () => {
    const seen = [];
    const decide = seam.resolveDecide('/tmp/x', {
      isActive: () => true,
      loadEngine: () => ({ decideSync: (request, opts) => { seen.push(opts); return { ok: true }; } }),
    });
    decide({ requests: [] });
    decide({ requests: [] }, { budgetMs: 5000 });
    for (const bad of [0, -1, NaN, Infinity, '5000']) decide({ requests: [] }, { budgetMs: bad });
    assert.deepEqual(seen[0], { cwd: '/tmp/x' }, 'no budget: the engine budget is used as is');
    assert.deepEqual(seen[1], { cwd: '/tmp/x', budgetMs: 5000 }, 'exactly cwd and budgetMs: no spawn seam');
    for (const opts of seen.slice(2)) assert.deepEqual(opts, { cwd: '/tmp/x' }, 'an unusable budget is not passed');
  });
});
