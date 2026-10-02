'use strict';

/**
 * decision-model engine prohibition checks (quick 261001-wza, test-tier must_haves.prohibitions).
 *
 * Each test pins one MUST NOT of the plan against the engine's behavior, so the prohibition
 * verifier (check prohibition-enforcement) can machine-prove it: the check goes red on a
 * known-violating engine and stays green on a clean one.
 *
 * GSD_PROHIB_SUBJECT convention: the verifier points it at an engine module exposing
 * `decide` and `decideSync`. A plain run checks the built engine itself. The fixtures live in
 * tests/fixtures/prohibitions/261001-wza/: clean.cjs re-exports the shipped engine, and every
 * violates-*.cjs wraps it so that exactly one prohibition is broken.
 *
 * The broader engine behavior (breaker, wire fidelity, D21-D25 scopes) is in decision-model.test.cjs.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createTempDir, cleanup } = require('./helpers.cjs');

const subject = process.env.GSD_PROHIB_SUBJECT
  ? path.resolve(process.env.GSD_PROHIB_SUBJECT)
  : path.join(__dirname, '..', 'gsd-core', 'bin', 'lib', 'decision-model.cjs');
const engine = require(subject);

function cfg(over = {}) {
  return { enabled: true, model: 'm', base_url: 'http://127.0.0.1:1234', ...over };
}

function twoOptions() {
  return { type: 'choice', instructions: 'Pick one.', criteria: { a: 'the a option', b: 'the b option' } };
}

function request(state = 'some state') {
  return { state, questions: { q: twoOptions() } };
}

/** A fake HttpDep that records every call; `reply(call)` returns {ok, status, body}. */
function fakeHttp(reply) {
  const calls = [];
  const http = async (url, opts) => {
    const call = { url, raw: opts.body === undefined ? '' : opts.body };
    calls.push(call);
    const r = reply(call);
    return { ok: r.ok, status: r.status, body: typeof r.body === 'string' ? r.body : JSON.stringify(r.body) };
  };
  return { http, calls };
}

/** A one-token completion that emits letter A with probability p and B with 1 - p. */
function letterA(p) {
  return () => ({
    ok: true,
    status: 200,
    body: {
      choices: [{
        message: { content: 'A' },
        finish_reason: 'stop',
        logprobs: { content: [{ token: 'A', top_logprobs: [
          { token: 'A', logprob: Math.log(p) },
          { token: 'B', logprob: Math.log(1 - p) },
        ] }] },
      }],
    },
  });
}

async function ask(over, reply, req = request()) {
  const h = fakeHttp(reply);
  const response = await engine.decide(req, { config: cfg(over), http: h.http });
  return { answer: response.results[0].answers.q, calls: h.calls };
}

/** A project with a temp GSD_HOME (so the user's own defaults never leak in); GSD_HOME is restored in t.after. */
function project(t, decisionModel) {
  const dir = createTempDir('gsd-dm-prohib-project-');
  const home = createTempDir('gsd-dm-prohib-home-');
  const prevHome = process.env.GSD_HOME;
  const prevKey = process.env.OPENROUTER_API_KEY;
  t.after(() => {
    if (prevHome === undefined) delete process.env.GSD_HOME; else process.env.GSD_HOME = prevHome;
    if (prevKey === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = prevKey;
    cleanup(dir);
    cleanup(home);
  });
  process.env.GSD_HOME = home;
  fs.mkdirSync(path.join(dir, '.planning'), { recursive: true });
  const config = decisionModel === undefined ? {} : { decision_model: decisionModel };
  fs.writeFileSync(path.join(dir, '.planning', 'config.json'), JSON.stringify(config));
  return { dir, home };
}

/** Every regular file under `root`, as repo-relative posix paths. */
function filesUnder(root) {
  return fs.readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => path.relative(root, path.join(e.parentPath, e.name)).split(path.sep).join('/'));
}

describe('Q2 egress consent: no request state leaves for a non-loopback host without allow_remote', () => {
  test('a non-loopback base_url abstains egress-not-consented and makes zero HTTP calls', async () => {
    for (const base of ['http://192.0.2.1:1234', 'http://example.com:1234', 'https://api.example.org']) {
      const { answer, calls } = await ask({ base_url: base }, letterA(0.99));
      assert.deepEqual(answer, { status: 'abstain', reason: 'egress-not-consented' }, base);
      assert.equal(calls.length, 0, `${base}: no call may be made`);
    }
  });

  test('allow_remote false written out gives the same refusal', async () => {
    const { answer, calls } = await ask({ base_url: 'http://192.0.2.1:1234', allow_remote: false }, letterA(0.99));
    assert.equal(answer.reason, 'egress-not-consented');
    assert.equal(calls.length, 0);
  });

  test('positive control: a loopback base_url is sent to and answered ok', async () => {
    const { answer, calls } = await ask({}, letterA(0.99));
    assert.equal(answer.status, 'ok');
    assert.equal(calls.length, 1);
  });
});

describe('Q3 capability off: no network call and every question abstains capability-off', () => {
  test('enabled false (and the shipped default) abstain capability-off with zero HTTP calls', async () => {
    for (const config of [{ enabled: false, model: 'm' }, { model: 'm' }]) {
      const h = fakeHttp(letterA(0.99));
      const response = await engine.decide(request(), { config, http: h.http });
      assert.deepEqual(response.results[0].answers.q, { status: 'abstain', reason: 'capability-off' }, JSON.stringify(config));
      assert.equal(h.calls.length, 0);
    }
  });

  test('decideSync in a project without a decision_model block spawns no child', (t) => {
    const { dir } = project(t);
    let spawned = 0;
    const response = engine.decideSync(request(), { cwd: dir, _spawn: () => { spawned += 1; return { status: 1 }; } });
    assert.deepEqual(response.results[0].answers.q, { status: 'abstain', reason: 'capability-off' });
    assert.equal(spawned, 0);
  });

  test('positive control: an enabled project does reach the spawn bridge', (t) => {
    const { dir } = project(t, { enabled: true, model: 'm', base_url: 'http://127.0.0.1:9' });
    let spawned = 0;
    engine.decideSync(request(), { cwd: dir, _spawn: () => { spawned += 1; return { status: 1 }; } });
    assert.equal(spawned, 1);
  });
});

describe('Q3 no truncation: state is sent whole and a context overflow abstains context-exceeded', () => {
  const HEAD = 'HEAD-MARKER';
  const TAIL = 'TAIL-MARKER';
  const state = `${HEAD} ${'x'.repeat(50000)} ${TAIL}`;

  test('the whole state, head and tail, reaches the backend', async () => {
    const { answer, calls } = await ask({}, letterA(0.99), request(state));
    assert.equal(answer.status, 'ok');
    assert.equal(calls.length, 1);
    assert.ok(calls[0].raw.includes(HEAD) && calls[0].raw.includes(TAIL), 'head and tail of the state are on the wire');
    assert.ok(calls[0].raw.length > state.length, 'the wire body is at least as long as the state');
  });

  test('a context overflow abstains context-exceeded and nothing shorter is retried', async () => {
    const overflow = () => ({ ok: false, status: 400, body: "This model's maximum context length is 4096 tokens" });
    const { answer, calls } = await ask({}, overflow, request(state));
    assert.deepEqual(answer, { status: 'abstain', reason: 'context-exceeded' });
    assert.equal(calls.length, 1, 'one attempt, no retry with a reduced state');
    assert.ok(calls.every((c) => c.raw.includes(TAIL)), 'every attempt carried the whole state');
  });
});

describe('Q1 abstain, never an ok decision: below-floor, unparseable and unconfigured-model answers', () => {
  function assertAbstain(answer, reason) {
    assert.equal(answer.status, 'abstain', JSON.stringify(answer));
    assert.equal(answer.reason, reason);
    assert.equal('choice' in answer, false, 'an abstain carries no ok choice');
  }

  test('a confidence below the floor abstains low-confidence', async () => {
    const { answer, calls } = await ask({ min_confidence: 0.9 }, letterA(0.6));
    assert.equal(calls.length, 1);
    assertAbstain(answer, 'low-confidence');
  });

  test('a completion that is not a listed letter abstains invalid-output', async () => {
    const garbage = () => ({ ok: true, status: 200, body: { choices: [{ message: { content: 'ZZZ' }, finish_reason: 'stop' }] } });
    const { answer } = await ask({}, garbage);
    assertAbstain(answer, 'invalid-output');
  });

  test('a model that was not configured abstains model-missing without any call', async () => {
    for (const model of ['', '   ']) {
      const { answer, calls } = await ask({ model }, letterA(0.99));
      assertAbstain(answer, 'model-missing');
      assert.equal(calls.length, 0);
    }
  });
});

describe('Q3 no trace write: decision state never reaches .gsd-trace.jsonl and the call log omits state and key', () => {
  const STATE = 'STATE-CANARY-4417';
  const INSTRUCTIONS = 'INSTRUCTIONS-CANARY-8820 Is it ready?';
  const KEY = 'KEY-CANARY-5103';

  test('the opt-in log has lines, none carries the state, the instructions or the API key, and no trace file appears', (t) => {
    const { dir, home } = project(t, {
      enabled: true, model: 'm', base_url: 'http://127.0.0.1:9', log_path: '.planning/dm.log.jsonl',
    });
    process.env.OPENROUTER_API_KEY = KEY;
    const child = {
      backend: 'openai-letter', model: 'm', endpoint_host: '127.0.0.1:9', min_confidence: 0.9,
      results: [{ id: 'default', answers: { q: { status: 'ok', answer: 'yes', p_yes: 0.97, confidence: 0.97 } } }],
    };
    const response = engine.decideSync(
      { state: STATE, questions: { q: { type: 'noul', instructions: INSTRUCTIONS } } },
      { cwd: dir, _spawn: () => ({ status: 0, stdout: JSON.stringify({ response: child, diagnostics: [] }) }) },
    );
    assert.equal(response.results[0].answers.q.status, 'ok', 'the call went through the bridge');

    const log = fs.readFileSync(path.join(dir, '.planning', 'dm.log.jsonl'), 'utf8');
    assert.ok(log.trim().length > 0, 'the opt-in log was written');
    for (const secret of [STATE, INSTRUCTIONS, KEY]) assert.equal(log.includes(secret), false, `log must not contain ${secret}`);

    for (const root of [dir, home]) {
      const files = filesUnder(root);
      assert.equal(files.some((f) => path.posix.basename(f) === '.gsd-trace.jsonl'), false, `${root}: no trace file`);
      for (const f of files) {
        if (f === '.planning/dm.log.jsonl') continue;
        assert.equal(fs.readFileSync(path.join(root, f), 'utf8').includes(STATE), false, `${f} must not carry the state`);
      }
    }
  });
});
