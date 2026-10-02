/**
 * Agent command router tests (quick 261001-wzs, D11 site #14).
 *
 * Asserts the built artifact `gsd-core/bin/lib/agent-command-router.cjs`, which
 * `npm run build:lib` emits from `src/agent-command-router.cts`: the unknown-failure
 * fallthrough to the optional decision model. Only an `unknown-failure` with a non-empty
 * body may consult the model; a sentinel hit, an empty body, or any abstain leaves the
 * deterministic result unchanged.
 */
'use strict';
process.env.GSD_TEST_MODE = '1';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { cleanup, TEST_ENV_BASE } = require('./helpers.cjs');
const { runNode } = require('./helpers/process-seam.cjs');
const { PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');

const ROOT = path.join(__dirname, '..');
const LIB = path.join(ROOT, 'gsd-core', 'bin', 'lib');
const TOOLS = path.join(ROOT, 'gsd-core', 'bin', 'gsd-tools.cjs');
const router = require(path.join(LIB, 'agent-command-router.cjs'));

const LINE = 'decided-by: decision-model (conf 0.93, backend openai-letter)';
const UNKNOWN_BODY = 'the provider says this account is out of credits for today';

/** A call-counting fake decide that validates the D18 request shape and answers `answer`. */
function fakeDecide(answer, backend = 'openai-letter') {
  const calls = [];
  const fn = (request) => {
    calls.push(request);
    return { backend, model: 'fake', results: request.requests.map((r) => ({ id: r.id, answers: { failure: answer } })) };
  };
  fn.calls = calls;
  return fn;
}

describe('agent-command-router: decision-model fallthrough (261001-o30 D11 site #14)', () => {
  test('WR-03: a model quota-exceeded answer is only a suggestion; the class stays unknown-failure', () => {
    assert.equal(typeof router.classifyAgentFailureWithModel, 'function');
    assert.deepEqual(router.classifyAgentFailure(UNKNOWN_BODY), { class: 'unknown-failure' });
    const decide = fakeDecide({ status: 'ok', choice: 'quota-exceeded', confidence: 0.93 });
    const out = router.classifyAgentFailureWithModel(UNKNOWN_BODY, { decide });
    assert.deepEqual(out, { class: 'unknown-failure', model_suggestion: { class: 'quota-exceeded', decided_by: LINE } });
    assert.equal(decide.calls.length, 1);
    assert.equal(decide.calls[0].requests.length, 1);
    const req = decide.calls[0].requests[0];
    assert.equal(req.state, UNKNOWN_BODY);
    assert.deepEqual(Object.keys(req.questions), ['failure']);
    assert.equal(req.questions.failure.type, 'choice');
    assert.deepEqual(Object.keys(req.questions.failure.criteria), ['quota-exceeded', 'other']);
  });

  test('WR-03: a model suggestion carries no sentinel or retry-after, so nothing in the quota path keys on it', () => {
    const body = `${UNKNOWN_BODY}\nretry-after: 30`;
    const decide = fakeDecide({ status: 'ok', choice: 'quota-exceeded', confidence: 0.93 });
    assert.deepEqual(router.classifyAgentFailureWithModel(body, { decide }), {
      class: 'unknown-failure', model_suggestion: { class: 'quota-exceeded', decided_by: LINE },
    });
  });

  test('the request state is the full body verbatim, with no trimming or truncation', () => {
    const body = `  ${'ünïcode '.repeat(800)}\n\n  `;
    const decide = fakeDecide({ status: 'ok', choice: 'other', confidence: 0.99 });
    router.classifyAgentFailureWithModel(body, { decide });
    assert.equal(decide.calls[0].requests[0].state, body);
  });

  test('a sentinel hit never consults the model and deep-equals the deterministic result', () => {
    for (const body of ['429 retry-after: 45', 'You have hit the rate limit', 'classifyHandoffIfNeeded is not defined']) {
      const decide = fakeDecide({ status: 'ok', choice: 'other', confidence: 0.99 });
      assert.deepEqual(router.classifyAgentFailureWithModel(body, { decide }), router.classifyAgentFailure(body));
      assert.equal(decide.calls.length, 0, body);
    }
  });

  test('an empty, whitespace-only, null or undefined body never consults the model', () => {
    for (const body of ['', '   \n\t ', null, undefined]) {
      const decide = fakeDecide({ status: 'ok', choice: 'quota-exceeded', confidence: 0.99 });
      assert.deepEqual(router.classifyAgentFailureWithModel(body, { decide }), { class: 'unknown-failure' });
      assert.equal(decide.calls.length, 0);
    }
  });

  test('other, abstain, null, garbage and malformed responses all leave unknown-failure', () => {
    const unknown = { class: 'unknown-failure' };
    const answers = [
      { status: 'ok', choice: 'other', confidence: 0.99 },
      { status: 'abstain', reason: 'low-confidence', confidence: 0.4 },
      { status: 'ok', choice: 'classify-handoff-bug', confidence: 0.99 },
      { status: 'ok', choice: 7, confidence: 0.99 },
      { status: 'ok', answer: 'yes', confidence: 0.99 },
      'quota-exceeded',
      null,
      42,
    ];
    for (const a of answers) {
      assert.deepEqual(router.classifyAgentFailureWithModel(UNKNOWN_BODY, { decide: fakeDecide(a) }), unknown);
    }
    const responses = [
      null, undefined, 'x', 7, {}, { results: null }, { results: [] }, { results: [{}] },
      { results: [{ id: 'other', answers: { failure: { status: 'ok', choice: 'quota-exceeded', confidence: 1 } } }] },
      { results: [{ id: '__proto__', answers: { failure: { status: 'ok', choice: 'quota-exceeded', confidence: 1 } } }] },
      { results: [{ id: 'f0', answers: null }] },
      { results: [{ id: 'f0' }] },
    ];
    for (const r of responses) {
      assert.deepEqual(router.classifyAgentFailureWithModel(UNKNOWN_BODY, { decide: () => r }), unknown);
    }
  });

  test('decide null (capability inactive) returns the deterministic result without a call', () => {
    assert.deepEqual(router.classifyAgentFailureWithModel(UNKNOWN_BODY, { decide: null }), { class: 'unknown-failure' });
  });

  test('exactly one decide call per classification', () => {
    const decide = fakeDecide({ status: 'ok', choice: 'quota-exceeded', confidence: 0.93 });
    router.classifyAgentFailureWithModel(UNKNOWN_BODY, { decide });
    assert.equal(decide.calls.length, 1);
  });

  test('FAILURE_QUESTION is a frozen choice with the two fixed criteria', () => {
    assert.ok(Object.isFrozen(router.FAILURE_QUESTION));
    assert.equal(router.FAILURE_QUESTION.type, 'choice');
    assert.deepEqual(Object.keys(router.FAILURE_QUESTION.criteria), ['quota-exceeded', 'other']);
  });
});

describe('agent-command-router: query agent.classify-failure stays deterministic off or unreachable (261001-o30 D11)', () => {
  function classifyIn(t, decisionModel, body) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-agent-dm-'));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-agent-home-'));
    t.after(() => { cleanup(dir); cleanup(home); });
    fs.mkdirSync(path.join(dir, '.planning'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.planning', 'config.json'), JSON.stringify({ decision_model: decisionModel }));
    const r = runNode([TOOLS, 'query', 'agent.classify-failure', '--', body], {
      cwd: dir,
      env: { ...process.env, ...TEST_ENV_BASE, HOME: home, USERPROFILE: home, GSD_HOME: home },
      timeoutMs: PROBE_TIMEOUT_MS,
    });
    return { r, dir };
  }

  test('decision_model disabled prints exactly { class: unknown-failure }', (t) => {
    const { r, dir } = classifyIn(t, { enabled: false }, UNKNOWN_BODY);
    assert.equal(r.exitCode, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), { class: 'unknown-failure' });
    assert.equal(fs.existsSync(path.join(dir, '.gsd-trace.jsonl')), false);
  });

  test('decision_model enabled against a failing backend prints the identical payload, and the backend was reached', async (t) => {
    const { startLetterStub, makeDecisionProject, runNodeAsync } = require('./helpers/decision-model-stub.cjs');
    const off = classifyIn(t, { enabled: false }, UNKNOWN_BODY);
    const stub = await startLetterStub(() => ({ status: 500, body: 'no' }));
    t.after(() => stub.close());
    const p = makeDecisionProject({ decision_model: { enabled: true, model: 'fake-model', base_url: stub.url, timeout_ms: 2000 } });
    t.after(() => p.cleanup());
    const on = await runNodeAsync([TOOLS, 'query', 'agent.classify-failure', '--', UNKNOWN_BODY],
      { cwd: p.dir, env: { ...p.env, ...TEST_ENV_BASE }, timeout: PROBE_TIMEOUT_MS });
    assert.equal(on.code, 0, on.stderr);
    assert.equal(stub.hits, 1, 'the enabled run reached the backend, so the model path is wired through decideSync');
    assert.equal(on.stdout, off.r.stdout);
    assert.deepEqual(JSON.parse(on.stdout), { class: 'unknown-failure' });
  });

  test('privacy (real path): an answered classification writes no .gsd-trace.jsonl, and no file outside a configured log_path', async (t) => {
    const { startLetterStub, makeDecisionProject, runNodeAsync, listFiles } = require('./helpers/decision-model-stub.cjs');
    const stub = await startLetterStub(() => 'quota-exceeded');
    t.after(() => stub.close());
    for (const logPath of [undefined, 'logs/decisions.jsonl']) {
      const dm = { enabled: true, model: 'fake-model', base_url: stub.url, timeout_ms: 5000, ...(logPath ? { log_path: logPath } : {}) };
      const p = makeDecisionProject({ decision_model: dm });
      t.after(() => p.cleanup());
      const before = { dir: listFiles(p.dir), home: listFiles(p.home) };
      const r = await runNodeAsync([TOOLS, 'query', 'agent.classify-failure', '--', UNKNOWN_BODY],
        { cwd: p.dir, env: { ...p.env, ...TEST_ENV_BASE }, timeout: PROBE_TIMEOUT_MS });
      assert.equal(r.code, 0, r.stderr);
      assert.equal(JSON.parse(r.stdout).model_suggestion.class, 'quota-exceeded', 'the answer came back through the real engine');
      assert.deepEqual(listFiles(p.dir).filter((f) => !before.dir.includes(f)), logPath ? [logPath] : [], 'no trace file; only the opted-in log');
      assert.deepEqual(listFiles(p.home), before.home, 'nothing is written under HOME / GSD_HOME');
    }
  });

  test('WR-03: with provider_escalation configured, a model quota answer still takes the unknown path (no escalation)', async (t) => {
    const { startLetterStub } = require('./helpers/decision-model-stub.cjs');
    const stub = await startLetterStub(() => 'quota-exceeded');
    t.after(() => stub.close());
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-agent-esc-'));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-agent-esc-home-'));
    t.after(() => { cleanup(dir); cleanup(home); });
    fs.mkdirSync(path.join(dir, '.planning'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.planning', 'config.json'), JSON.stringify({
      decision_model: { enabled: true, model: 'fake-model', base_url: stub.url, timeout_ms: 5000 },
      dynamic_routing: { enabled: true, provider_escalation: ['other-provider/model-x'], max_escalations: 1 },
    }));
    const env = { ...process.env, ...TEST_ENV_BASE, HOME: home, USERPROFILE: home, GSD_HOME: home };
    // Async: the stub answers from this process's event loop, which a sync spawn would block.
    const { execFile } = require('node:child_process');
    const tools = (args) => new Promise((resolve) => {
      execFile(process.execPath, [TOOLS, 'query', ...args], { cwd: dir, env, timeout: PROBE_TIMEOUT_MS, encoding: 'utf8' },
        (err, stdout, stderr) => resolve({ exitCode: err ? err.code : 0, stdout, stderr }));
    });
    const r = await tools(['agent.classify-failure', '--', UNKNOWN_BODY]);
    assert.equal(r.exitCode, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(stub.hits, 1, 'the model was consulted once through the real engine');
    assert.equal(out.class, 'unknown-failure', 'Step 7.1 (and its 7.1a escalation) is entered only on class quota-exceeded');
    assert.equal(out.model_suggestion.class, 'quota-exceeded');
    assert.match(out.model_suggestion.decided_by, /^decided-by: decision-model \(conf \d\.\d\d, backend openai-letter\)$/);
    assert.equal('sentinel' in out, false);
    // Positive control: this config really does escalate a quota-exceeded class, so the test is not vacuous.
    const quota = JSON.parse((await tools(['resolve-execution', 'gsd-executor', '--attempt', '1', '--failure-class', 'quota-exceeded'])).stdout);
    assert.equal(quota.escalation.escalated, true);
    const asClassified = JSON.parse((await tools(['resolve-execution', 'gsd-executor', '--attempt', '1', '--failure-class', out.class])).stdout);
    assert.equal(asClassified.escalation.escalated, false);
  });

  test('the existing quota sentinel case is unchanged', (t) => {
    const { r } = classifyIn(t, { enabled: false }, '429 retry-after: 45');
    assert.equal(r.exitCode, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), { class: 'quota-exceeded', sentinel: '429', retryAfterSeconds: 45 });
  });
});
