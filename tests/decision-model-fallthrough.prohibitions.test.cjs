'use strict';

/**
 * Decision-model code-site prohibition checks (quick 261001-wzs, test-tier must_haves.prohibitions).
 *
 * Each describe pins one MUST NOT of the plan against the five code sites (edge probe, UI
 * consideration probe, assumption-delta, learnings copy, agent failure classifier), so the
 * prohibition verifier (check prohibition-enforcement) can machine-prove it: the check goes red on a
 * known-violating site set and stays green on the shipped one.
 *
 * GSD_PROHIB_SUBJECT convention: the verifier points it at a module exporting
 * `{ edge, ui, delta, learnings, agent }`, each carrying that site's `...WithModel` entry point
 * (edge/ui: proposeCoverageWithDecisionModel, delta: detectAssumptionDeltaWithModel,
 * learnings: copyWithSameAsSuggestions, agent: classifyAgentFailureWithModel). A plain run checks the
 * built sites themselves. Fixtures live in tests/fixtures/prohibitions/261001-wzs/: clean.cjs
 * re-exports the shipped sites and every violates-*.cjs wraps them so that one prohibition is broken.
 *
 * Per-site behavior (batching, caps, budgets, answer parsing) is in each site's own test file and in
 * decision-model-fallthrough.test.cjs.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { createTempDir, cleanup } = require('./helpers.cjs');
const { runNode } = require('./helpers/process-seam.cjs');
const { PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');

const LIB = path.join(__dirname, '..', 'gsd-core', 'bin', 'lib');
const subjectPath = process.env.GSD_PROHIB_SUBJECT
  ? path.resolve(process.env.GSD_PROHIB_SUBJECT)
  : path.join(__dirname, 'fixtures', 'prohibitions', '261001-wzs', 'clean.cjs');
const sites = require(subjectPath);
// Setup and inspection always use the shipped modules, never the subject.
const realLearnings = require(path.join(LIB, 'learnings.cjs'));
const realEdge = require(path.join(LIB, 'edge-probe.cjs'));
const realUi = require(path.join(LIB, 'ui-consideration-probe.cjs'));
const realDelta = require(path.join(LIB, 'assumption-delta.cjs'));
const realAgent = require(path.join(LIB, 'agent-command-router.cjs'));

const STATE = 'STATE-CANARY-6021';
const RESP = 'RESP-CANARY-3318';
const PROVENANCE = /^decided-by: decision-model \(conf \d\.\d\d, backend [^)\s]+\)$/;

// A zero-hit requirement (no regex cue), a regex-labelled one, and the other sites' inputs.
const ZERO_HIT = `uno dos tres ${STATE}`;
const REGEX_HIT = 'Round the total amount to two decimal places';
const DELTA_MISS = `Soportar un segundo proveedor de identidad para los clientes ${STATE}`;
const DELTA_HIT = 'Add a second authentication method.';
const FAILURE_UNKNOWN = `the provider says this account is out of credits for today ${STATE}`;
const FAILURE_SENTINEL = '429 retry-after: 45';
const SEED = {
  source_project: 'other',
  context: 'Retry policy for flaky network calls',
  learning: 'Retry network calls with exponential backoff and jitter',
};
const NEAR_MISS = (marker = '') => `# Learnings\n\n## Lessons\n\n### Network retries\nWhen a remote request fails, wait longer before each new attempt and add randomness ${marker}\n`;

/** The answer to one question: yes for noul, the first listed option for choice. */
function pickFirst(q) {
  if (q.type === 'noul') return { status: 'ok', answer: 'yes', p_yes: 0.97, confidence: 0.97, note: RESP };
  return { status: 'ok', choice: Object.keys(q.criteria)[0], confidence: 0.97, note: RESP };
}

/** A call-recording fake decide; `pick(question, key)` chooses each answer. */
function fakeDecide(pick = pickFirst) {
  const calls = [];
  const decide = (request) => {
    calls.push(request);
    return {
      backend: 'openai-letter',
      model: RESP,
      endpoint_host: '127.0.0.1:1234',
      min_confidence: 0.9,
      results: request.requests.map((r) => ({
        id: r.id,
        answers: Object.fromEntries(Object.entries(r.questions).map(([k, q]) => [k, pick(q, k)])),
      })),
    };
  };
  decide.calls = calls;
  return decide;
}

/** project/, home/ and store/ under one temp root, removed in t.after. */
function sandbox(t) {
  const root = createTempDir('gsd-dmf-prohib-');
  t.after(() => cleanup(root));
  const dirs = { root, project: path.join(root, 'project'), home: path.join(root, 'home'), store: path.join(root, 'store') };
  for (const d of [dirs.project, dirs.home, dirs.store]) fs.mkdirSync(d, { recursive: true });
  return dirs;
}

/** Every regular file under root: posix relative path to its sha256. */
function snapshot(root) {
  const out = new Map();
  for (const e of fs.readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (!e.isFile()) continue;
    const full = path.join(e.parentPath, e.name);
    out.set(path.relative(root, full).split(path.sep).join('/'), crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex'));
  }
  return out;
}

/** Seed the learnings store and write the near-miss lesson the copy will import (its text carries the state canary). */
function seedLearnings(dirs, marker) {
  realLearnings.learningsWrite(SEED, { storeDir: dirs.store });
  fs.writeFileSync(path.join(dirs.project, 'LEARNINGS.md'), NEAR_MISS(marker), 'utf8');
}

/** Run all five sites against an injected decide, on a project seeded by seedLearnings. */
function runAllSites(dirs, decide) {
  const base = { cwd: dirs.project, decide };
  return {
    edge: sites.edge.proposeCoverageWithDecisionModel([{ id: 'R1', text: REGEX_HIT }, { id: 'R2', text: ZERO_HIT }], base),
    ui: sites.ui.proposeCoverageWithDecisionModel([{ id: 'E2', text: ZERO_HIT }], base),
    delta: sites.delta.detectAssumptionDeltaWithModel(DELTA_MISS, undefined, base),
    learnings: sites.learnings.copyWithSameAsSuggestions(dirs.project, { ...base, storeDir: dirs.store, sourceProject: 'app' }),
    agent: sites.agent.classifyAgentFailureWithModel(FAILURE_UNKNOWN, base),
  };
}

/** Every model-proposed label, suggestion, signal or class found in the five outputs. */
function proposals(outs) {
  const found = [];
  for (const item of outs.edge.items) for (const l of (item.model_proposal || { labels: [] }).labels) found.push(['edge label', l]);
  for (const item of outs.ui.items) for (const l of (item.model_proposal || { labels: [] }).labels) found.push(['ui label', l]);
  for (const s of outs.delta.signals) if (s.proposed_by === 'decision-model') found.push(['delta signal', s]);
  for (const s of outs.learnings.same_as_suggestions || []) found.push(['same-as suggestion', s]);
  if (outs.agent.model_suggestion) found.push(['failure class', outs.agent.model_suggestion]);
  return found;
}

describe('Q1 provenance: no model proposal is emitted without its decided-by line', () => {
  test('every label, suggestion, signal and class from every site carries the locked decided-by line', (t) => {
    const dirs = sandbox(t);
    seedLearnings(dirs, STATE);
    const outs = runAllSites(dirs, fakeDecide());
    const found = proposals(outs);
    assert.deepEqual(
      [...new Set(found.map(([kind]) => kind))].sort(),
      ['delta signal', 'edge label', 'failure class', 'same-as suggestion', 'ui label'],
      'every site produced a model proposal, so the check is not vacuous',
    );
    for (const [kind, p] of found) {
      assert.equal(typeof p.decided_by, 'string', `${kind} has no decided_by`);
      assert.match(p.decided_by, PROVENANCE, kind);
    }
  });
});

describe('Q2 no persistence: nothing sent to or returned by the model is written to any file', () => {
  test('a run with a model leaves no trace file, no changed file and no extra store field; the response text is nowhere on disk', (t) => {
    const dirs = sandbox(t);
    seedLearnings(dirs, STATE);
    const before = snapshot(dirs.root);
    const outs = runAllSites(dirs, fakeDecide());
    const after = snapshot(dirs.root);
    assert.ok(proposals(outs).length >= 5, 'the model answered at every site');

    const added = [...after.keys()].filter((p) => !before.has(p));
    const changed = [...after.keys()].filter((p) => before.has(p) && before.get(p) !== after.get(p));
    const removed = [...before.keys()].filter((p) => !after.has(p));
    assert.deepEqual(changed, [], 'no existing file changed');
    assert.deepEqual(removed, [], 'no existing file was removed');
    assert.equal([...after.keys()].some((p) => path.posix.basename(p) === '.gsd-trace.jsonl'), false, 'no .gsd-trace.jsonl anywhere');
    assert.equal(added.length, outs.learnings.created, 'the only new files are the learnings the copy itself created');
    for (const p of added) {
      assert.match(p, /^store\/[^/]+\.json$/);
      const keys = Object.keys(JSON.parse(fs.readFileSync(path.join(dirs.root, p), 'utf8'))).sort();
      assert.deepEqual(keys, ['content_hash', 'context', 'date', 'id', 'learning', 'source_project', 'tags'], 'a stored learning gains no decision field');
    }
    for (const p of after.keys()) {
      assert.equal(fs.readFileSync(path.join(dirs.root, p), 'utf8').includes(RESP), false, `${p} must not carry the model response`);
    }
  });
});

describe('Q2 human control: the model is never the final word', () => {
  test('edge and UI probes: a proposal is an added annotation; every deterministic row is untouched and nothing is resolved', () => {
    const cases = [
      ['edge', sites.edge, realEdge, [{ id: 'R1', text: REGEX_HIT }, { id: 'R2', text: ZERO_HIT }], 'R1'],
      ['ui', sites.ui, realUi, [{ id: 'E1', text: 'A login form with an email field' }, { id: 'E2', text: ZERO_HIT }], 'E1'],
    ];
    for (const [name, site, real, input, hitId] of cases) {
      const decide = fakeDecide();
      const base = real.analyzeCoverage(input, []);
      const out = site.proposeCoverageWithDecisionModel(input, { decide });
      assert.equal(decide.calls.length, 1, name);
      assert.equal(decide.calls[0].requests.some((r) => r.state.includes(input[0].text)), false, `${name}: a regex-classified item is never put to the model`);
      assert.ok(out.items.some((i) => i.model_proposal !== undefined), `${name}: the model did annotate the zero-hit row`);
      assert.equal(out.items.length, base.items.length, `${name}: no row added or dropped`);
      out.items.forEach((item, i) => {
        const { model_proposal: _proposal, ...rest } = item;
        assert.deepEqual(rest, base.items[i], `${name}: row ${i} equals the deterministic row`);
      });
      assert.deepEqual(out.coverage, base.coverage, `${name}: coverage numbers are the deterministic ones`);
      assert.ok(out.items.filter((i) => i.requirement_id === hitId).every((i) => i.model_proposal === undefined), name);
    }
  });

  test('assumption-delta: a regex detection is never overridden, and a model signal only adds', () => {
    const none = fakeDecide(() => ({ status: 'ok', choice: 'none', confidence: 0.97 }));
    assert.deepEqual(sites.delta.detectAssumptionDeltaWithModel(DELTA_HIT, undefined, { decide: none }), realDelta.detectAssumptionDelta(DELTA_HIT));
    assert.equal(none.calls.length, 0, 'a regex hit is not put to the model');
    assert.deepEqual(sites.delta.detectAssumptionDeltaWithModel(DELTA_MISS, undefined, { decide: none }), realDelta.detectAssumptionDelta(DELTA_MISS));

    const added = sites.delta.detectAssumptionDeltaWithModel(DELTA_MISS, undefined, { decide: fakeDecide() });
    const base = realDelta.detectAssumptionDelta(DELTA_MISS);
    assert.equal(base.detected, false);
    assert.equal(added.signals.length, 1);
    assert.equal(added.signals[0].proposed_by, 'decision-model');
    assert.deepEqual(added.terms, base.terms);
  });

  test('agent failure: a sentinel match is untouched, and a model suggestion never changes the class', () => {
    const quota = fakeDecide(() => ({ status: 'ok', choice: 'quota-exceeded', confidence: 0.97 }));
    for (const body of [FAILURE_SENTINEL, 'You have hit the rate limit', 'classifyHandoffIfNeeded is not defined']) {
      assert.deepEqual(sites.agent.classifyAgentFailureWithModel(body, { decide: quota }), realAgent.classifyAgentFailure(body), body);
    }
    assert.equal(quota.calls.length, 0, 'a sentinel match is not put to the model');
    const out = sites.agent.classifyAgentFailureWithModel(FAILURE_UNKNOWN, { decide: quota });
    assert.equal(out.class, 'unknown-failure', 'the deterministic class stands');
    assert.equal(out.model_suggestion.class, 'quota-exceeded', 'the suggestion is carried beside it');
    assert.equal('sentinel' in out, false, 'a model answer is not a sentinel match');
  });

  test('learnings: a same-as answer never merges, deletes or skips a learning', (t) => {
    const dirs = sandbox(t);
    const seed = realLearnings.learningsWrite(SEED, { storeDir: dirs.store });
    const seedBytes = fs.readFileSync(path.join(dirs.store, `${seed.id}.json`), 'utf8');
    fs.writeFileSync(path.join(dirs.project, 'LEARNINGS.md'), NEAR_MISS(), 'utf8');
    const decide = fakeDecide();
    const opts = { cwd: dirs.project, storeDir: dirs.store, sourceProject: 'app', decide };

    const first = sites.learnings.copyWithSameAsSuggestions(dirs.project, opts);
    assert.equal(first.same_as_suggestions.length, 1, 'the model said yes, so the suggestion exists');
    assert.deepEqual({ total: first.total, created: first.created, skipped: first.skipped }, { total: 1, created: 1, skipped: 0 }, 'the new learning is created, not skipped');
    const ids = realLearnings.learningsList({ storeDir: dirs.store }).map((r) => r.id);
    assert.equal(ids.length, 2, 'both learnings are in the store');
    assert.ok(ids.includes(seed.id), 'the suggested duplicate was not deleted or merged away');
    assert.equal(fs.readFileSync(path.join(dirs.store, `${seed.id}.json`), 'utf8'), seedBytes, 'the older learning is byte-identical');

    const calls = decide.calls.length;
    const second = sites.learnings.copyWithSameAsSuggestions(dirs.project, opts);
    assert.deepEqual(second, { total: 1, created: 0, skipped: 1 }, 'an exact duplicate is still skipped and counted as before');
    assert.equal(decide.calls.length, calls, 'and never put to the model');
  });
});

describe('Q1 consent: an inactive capability loads no engine, spawns no child and makes no network call', () => {
  /** Runs every site WITHOUT an injected decide in a subprocess that records engine loads, spawns and network use. */
  function runInactiveProbe(t, decisionModel) {
    const dirs = sandbox(t);
    fs.mkdirSync(path.join(dirs.project, '.planning'), { recursive: true });
    fs.writeFileSync(path.join(dirs.project, '.planning', 'config.json'), JSON.stringify({ decision_model: decisionModel }));
    fs.writeFileSync(path.join(dirs.project, 'LEARNINGS.md'), NEAR_MISS(), 'utf8');
    realLearnings.learningsWrite(SEED, { storeDir: dirs.store });
    const script = `
      const cp = require('node:child_process');
      const http = require('node:http');
      const https = require('node:https');
      const net = require('node:net');
      const hits = { spawns: [], network: 0 };
      for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
        const orig = cp[name];
        cp[name] = function patched(...a) {
          hits.spawns.push([a[0], ...(Array.isArray(a[1]) ? a[1] : [])].join(' '));
          return orig.apply(this, a);
        };
      }
      for (const [obj, names] of [[http, ['request', 'get']], [https, ['request', 'get']], [net, ['connect', 'createConnection']]]) {
        for (const name of names) {
          const orig = obj[name];
          obj[name] = function patched(...a) { hits.network += 1; return orig.apply(this, a); };
        }
      }
      const realFetch = globalThis.fetch;
      globalThis.fetch = function patched(...a) { hits.network += 1; return realFetch.apply(this, a); };

      const sites = require(process.env.SITES_SUBJECT);
      const cwd = process.cwd();
      sites.edge.proposeCoverageWithDecisionModel([{ id: 'R2', text: 'uno dos tres' }], { cwd });
      sites.ui.proposeCoverageWithDecisionModel([{ id: 'E2', text: 'uno dos tres' }], { cwd });
      sites.delta.detectAssumptionDeltaWithModel('Soportar un segundo proveedor de identidad', undefined, { cwd });
      sites.learnings.copyWithSameAsSuggestions(cwd, { cwd, storeDir: process.env.PROBE_STORE, sourceProject: 'app' });
      sites.agent.classifyAgentFailureWithModel('the provider says this account is out of credits', { cwd });
      const loaded = Object.keys(require.cache).filter((k) => /[\\\\/]decision-model\\.cjs$/.test(k));
      process.stdout.write(JSON.stringify({ loaded, spawns: hits.spawns, network: hits.network }));
    `;
    const r = runNode(['-e', script], {
      cwd: dirs.project,
      timeoutMs: PROBE_TIMEOUT_MS * 4,
      env: {
        ...process.env,
        HOME: dirs.home, USERPROFILE: dirs.home, GSD_HOME: dirs.home,
        SITES_SUBJECT: subjectPath, PROBE_STORE: dirs.store,
      },
    });
    assert.equal(r.exitCode, 0, r.stderr);
    const seen = JSON.parse(r.stdout);
    // The capability gate itself reads the project config, and the config loader runs one
    // `git check-ignore` for that. It is the gate's own cost, not a decision-model call, so it is
    // set aside; any other child process (the engine child above all) is reported.
    return { loaded: seen.loaded, children: seen.spawns.filter((c) => !/^git check-ignore /.test(c)), network: seen.network };
  }

  test('with decision_model.enabled false, all five sites run with no engine load, no spawn and no network call', (t) => {
    assert.deepEqual(runInactiveProbe(t, { enabled: false, model: 'm' }), { loaded: [], children: [], network: 0 });
  });

  test('with no decision_model block at all (the shipped default) the result is the same', (t) => {
    assert.deepEqual(runInactiveProbe(t, undefined), { loaded: [], children: [], network: 0 });
  });

  test('positive control: an enabled project does load the engine and spawn its child, so the probe can see them', (t) => {
    const seen = runInactiveProbe(t, { enabled: true, model: 'm', base_url: 'http://127.0.0.1:9', timeout_ms: 1000 });
    assert.equal(seen.loaded.length, 1, 'the engine is loaded once the capability is active');
    assert.ok(seen.children.some((c) => c.includes('--decide-child')), 'the engine child is spawned once the capability is active');
  });
});
