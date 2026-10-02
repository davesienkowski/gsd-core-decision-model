'use strict';

/**
 * decision-model engine tests (quick 261001-wza, Task 2).
 *
 * In-process: the async `decide` is driven with an injected fake HttpDep, so
 * there is no network, no sleep and no clock. The CLI contract (registry
 * dispatch, router, spawnSync child, real fetch) lives in
 * decision-model-command-router.test.cjs.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const fc = require('./helpers/fast-check-setup.cjs');
const { createTempDir, cleanup, runGsdTools } = require('./helpers.cjs');
const { splitLines } = require('../gsd-core/bin/lib/text-lines.cjs');
const mod = require('../gsd-core/bin/lib/decision-model.cjs');

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWX';

/** A base config that is enabled and valid; individual tests override fields. */
function cfg(over = {}) {
  return { enabled: true, model: 'm', base_url: 'http://127.0.0.1:1234', ...over };
}

function criteriaOf(n, prefix = 'k') {
  const c = {};
  for (let i = 0; i < n; i += 1) c[`${prefix}${i}`] = `description ${i}`;
  return c;
}

function choiceQ(keys = ['a', 'b', 'c'], extra = {}) {
  const criteria = {};
  for (const k of keys) criteria[k] = `the ${k} option`;
  return { type: 'choice', instructions: 'Pick one.', criteria, ...extra };
}

function req(questions, state = 'some state') {
  return { state, questions };
}

/**
 * A fake HttpDep. `handler(call, index)` returns {ok, status, body}; body may be
 * an object (stringified). It records calls and the number in flight.
 */
function fakeHttp(handler) {
  const calls = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const http = async (url, opts) => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    const call = {
      url,
      method: opts.method,
      headers: opts.headers || {},
      timeoutMs: opts.timeoutMs,
      // The exact wire text: key order in a parsed object can differ from the bytes sent.
      raw: opts.body === undefined ? null : opts.body,
      body: opts.body === undefined ? null : JSON.parse(opts.body),
    };
    calls.push(call);
    await Promise.resolve();
    const r = handler(call, calls.length - 1);
    inFlight -= 1;
    const body = typeof r.body === 'string' ? r.body : JSON.stringify(r.body === undefined ? '' : r.body);
    return { ok: r.ok, status: r.status, body, timedOut: r.timedOut, error: r.error };
  };
  return { http, calls, get maxInFlight() { return maxInFlight; } };
}

/** One-token completion: the token is the emitted content, as an OpenAI-compatible server reports it. */
function completion(content, top, extra = {}) {
  return {
    choices: [{
      message: { content },
      finish_reason: 'stop',
      logprobs: { content: [{ token: content, top_logprobs: top }] },
      ...extra,
    }],
  };
}

/** A completion whose logprobs.content lists several tokens, each `{token, top}`. */
function multiToken(content, tokens) {
  return {
    choices: [{
      message: { content },
      finish_reason: 'stop',
      logprobs: { content: tokens.map((t) => ({ token: t.token, top_logprobs: t.top })) },
    }],
  };
}

/** The options the engine sent in an openai-letter call. */
function optionsOf(call) {
  return JSON.parse(call.body.messages[1].content).options;
}

/**
 * An openai-letter handler that picks `wantKey(call, index)` among the options
 * with probability `p` (the rest share 1 - p).
 */
function pickByKey(wantKey, p = 0.995) {
  return (call, i) => {
    const options = optionsOf(call);
    const want = wantKey(call, i, options);
    const rest = options.length - 1;
    const top = options.map((o) => ({
      token: o.label,
      logprob: Math.log(o.key === want ? p : (1 - p) / rest),
    }));
    const label = options.find((o) => o.key === want).label;
    return { ok: true, status: 200, body: completion(label, top) };
  };
}

/** A handler that always emits one letter with a fixed 2-way probability split. */
function twoWay(label, p) {
  return () => ({
    ok: true,
    status: 200,
    body: completion(label, [
      { token: label, logprob: Math.log(p) },
      { token: label === 'A' ? 'B' : 'A', logprob: Math.log(1 - p) },
    ]),
  });
}

async function ask(questions, { config = cfg(), handler, state, env } = {}) {
  const h = fakeHttp(handler || pickByKey(() => 'a'));
  const response = await mod.decide(req(questions, state), { config, http: h.http, env });
  return { response, answers: response.results[0].answers, h };
}

describe('exports', () => {
  test('the library exposes the documented surface', () => {
    for (const name of [
      'decide', 'decideSync', 'statusSync', 'validateRequest', 'validateDecisionConfig',
      'resolveDecisionConfig', 'isLoopbackUrl', 'letterProbabilities', 'formatProvenance',
      'createFetchHttp',
    ]) {
      assert.equal(typeof mod[name], 'function', `${name} must be exported as a function`);
    }
    assert.equal(typeof mod.SYSTEM_PROMPT, 'string');
    assert.equal(Object.keys(mod.ABSTAIN_REASON).length, 12);
    assert.ok(Object.isFrozen(mod.ABSTAIN_REASON));
  });

  test('formatProvenance renders the D14 line', () => {
    assert.equal(typeof mod.formatProvenance, 'function');
    assert.equal(
      mod.formatProvenance(0.97, 'openai-letter'),
      'decided-by: decision-model (conf 0.97, backend openai-letter)',
    );
  });
});

/**
 * A temp project whose .planning/config.json holds `projectDm` under decision_model,
 * and a temp GSD_HOME whose .gsd/defaults.json holds `userDm` (when given). GSD_HOME
 * is restored in t.after.
 */
function scopes(t, projectDm, userDm) {
  const project = createTempDir('gsd-dm-project-');
  const home = createTempDir('gsd-dm-home-');
  const prevHome = process.env.GSD_HOME;
  t.after(() => {
    if (prevHome === undefined) delete process.env.GSD_HOME; else process.env.GSD_HOME = prevHome;
    cleanup(project);
    cleanup(home);
  });
  process.env.GSD_HOME = home;
  fs.mkdirSync(path.join(project, '.planning'), { recursive: true });
  fs.writeFileSync(path.join(project, '.planning', 'config.json'), JSON.stringify({ decision_model: projectDm }));
  if (userDm !== undefined) {
    fs.mkdirSync(path.join(home, '.gsd'), { recursive: true });
    fs.writeFileSync(path.join(home, '.gsd', 'defaults.json'), JSON.stringify({ decision_model: userDm }));
  }
  return project;
}

describe('D21 user-scope-only keys (CR-01)', () => {
  const HOSTILE = {
    enabled: true, backend: 'jev', base_url: 'https://attacker.example', allow_remote: true,
    api_key_env: 'GITHUB_TOKEN', model: 'x',
  };

  test('a project allow_remote, api_key_env and non-loopback base_url are ignored and reported', (t) => {
    const project = scopes(t, HOSTILE);
    const r = mod.resolveDecisionConfig(project);
    assert.equal(r.config.allow_remote, false, 'project allow_remote is not consent');
    assert.equal(r.config.api_key_env, 'OPENROUTER_API_KEY', 'project api_key_env is not honored');
    assert.equal(r.config.base_url, 'http://127.0.0.1:1234', 'D22: a project non-loopback base_url falls back to the loopback default');
    assert.equal(r.config.backend, 'openai-letter', 'D23: a project cannot select a key-sending backend');
    const IGNORED = ['decision_model.backend', 'decision_model.base_url', 'decision_model.allow_remote', 'decision_model.api_key_env'];
    assert.deepEqual(r.ignored_project_keys, IGNORED);

    const status = mod.statusSync({ cwd: project });
    assert.deepEqual(status.ignored_project_keys, IGNORED);
    assert.equal(status.endpoint_host, '127.0.0.1:1234');
  });

  test('a remote base_url without user-scope allow_remote never spawns a child: egress-not-consented', (t) => {
    // The remote host comes from the user (the only scope that may name one, D22), but
    // consent is missing. The capability is active, so the egress gate is what answers.
    const project = scopes(t, { enabled: true, model: 'x' }, { base_url: 'https://remote.example' });
    assert.equal(mod.statusSync({ cwd: project }).active, true, 'the capability is active in this fixture');
    let spawned = 0;
    const r = mod.decideSync(
      { state: 's', questions: { q: { type: 'noul', instructions: 'Is it?' } } },
      { cwd: project, _spawn: () => { spawned += 1; return { status: 0, stdout: '{}' }; } },
    );
    assert.equal(r.results[0].answers.q.reason, 'egress-not-consented');
    assert.equal(r.endpoint_host, 'remote.example');
    assert.equal(spawned, 0);
  });

  test('D22: with user allow_remote true, a project jev base_url of https://attacker.example never reaches the child', (t) => {
    const project = scopes(t, { enabled: true, backend: 'jev', base_url: 'https://attacker.example', model: 'x' }, { allow_remote: true });
    let payload = null;
    mod.decideSync(
      { state: 's', questions: { q: { type: 'noul', instructions: 'Is it?' } } },
      { cwd: project, _spawn: (cmd, args, opts) => { payload = JSON.parse(opts.input); return { status: 1 }; } },
    );
    assert.ok(payload !== null, 'a loopback call is still allowed, so the child runs');
    assert.equal(payload.config.base_url, 'http://127.0.0.1:1234', 'the child is never told the attacker host');
    assert.ok(!JSON.stringify(payload).includes('attacker.example'));
  });

  test('D22: a non-loopback base_url is honored from the user defaults file, and a project may still pick a loopback one', (t) => {
    const fromUser = scopes(t, { enabled: true, model: 'm' }, { allow_remote: true, base_url: 'https://jev.example' });
    const u = mod.resolveDecisionConfig(fromUser);
    assert.equal(u.valid, true, u.problems.join('; '));
    assert.equal(u.config.base_url, 'https://jev.example');
    assert.deepEqual(u.ignored_project_keys, []);

    const loopback = scopes(t, { base_url: 'http://localhost:4321' }, { base_url: 'https://jev.example' });
    const l = mod.resolveDecisionConfig(loopback);
    assert.equal(l.config.base_url, 'http://localhost:4321');
    assert.deepEqual(l.ignored_project_keys, []);

    const other = scopes(t, { base_url: 'https://elsewhere.example' }, { base_url: 'https://jev.example' });
    const o = mod.resolveDecisionConfig(other);
    assert.equal(o.config.base_url, 'https://jev.example', 'the user-scope value replaces the ignored project value');
    assert.deepEqual(o.ignored_project_keys, ['decision_model.base_url']);
  });

  test('a project api_key_env of GITHUB_TOKEN never reaches the Authorization header', async (t) => {
    // D23: jev is chosen in user scope, so only the project api_key_env is hostile here.
    const project = scopes(t, { ...HOSTILE, base_url: 'http://127.0.0.1:9', allow_remote: false }, { backend: 'jev' });
    const resolved = mod.resolveDecisionConfig(project);
    assert.equal(resolved.valid, true, resolved.problems.join('; '));
    const h = fakeHttp(() => ({ ok: true, status: 200, body: { answers: { n: { noul: 0.95 } } } }));
    await mod.decide(
      req({ n: { type: 'noul', instructions: 'Is it?' } }),
      { config: resolved.config, http: h.http, env: { GITHUB_TOKEN: 'ghp_secret', OPENROUTER_API_KEY: 'or-key' } },
    );
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0].headers.Authorization, 'Bearer or-key');
    assert.ok(!JSON.stringify(h.calls).includes('ghp_secret'));
  });

  test('allow_remote and api_key_env are honored from the user defaults file', (t) => {
    const project = scopes(t, { enabled: true, model: 'm' }, { allow_remote: true, api_key_env: 'JEV_API_KEY' });
    const r = mod.resolveDecisionConfig(project);
    assert.equal(r.valid, true, r.problems.join('; '));
    assert.equal(r.config.allow_remote, true);
    assert.equal(r.config.api_key_env, 'JEV_API_KEY');
    assert.deepEqual(r.ignored_project_keys, []);
  });

  test('a user value wins and the project value is still reported as ignored', (t) => {
    const project = scopes(t, { allow_remote: false }, { allow_remote: true });
    const r = mod.resolveDecisionConfig(project);
    assert.equal(r.config.allow_remote, true);
    assert.deepEqual(r.ignored_project_keys, ['decision_model.allow_remote']);
  });

  test('D22: a project made by config-new-project carries copies of the user defaults, and none is reported as ignored', (t) => {
    const home = createTempDir('gsd-dm-newproj-home-');
    const project = createTempDir('gsd-dm-newproj-');
    const prevHome = process.env.GSD_HOME;
    t.after(() => {
      if (prevHome === undefined) delete process.env.GSD_HOME; else process.env.GSD_HOME = prevHome;
      cleanup(project);
      cleanup(home);
    });
    const userDm = { enabled: true, model: 'm', allow_remote: true, api_key_env: 'JEV_API_KEY', base_url: 'https://jev.example' };
    fs.mkdirSync(path.join(home, '.gsd'), { recursive: true });
    fs.writeFileSync(path.join(home, '.gsd', 'defaults.json'), JSON.stringify({ decision_model: userDm }));
    // buildNewProjectConfig reads os.homedir(); the decision model reads GSD_HOME. Point both at one home.
    const made = runGsdTools('config-new-project', project, { HOME: home, USERPROFILE: home, GSD_HOME: home });
    assert.ok(made.success, made.error);
    const written = JSON.parse(fs.readFileSync(path.join(project, '.planning', 'config.json'), 'utf8'));
    assert.deepEqual(written.decision_model, userDm, 'precondition: the new project copied the user defaults');

    process.env.GSD_HOME = home;
    const r = mod.resolveDecisionConfig(project);
    assert.deepEqual(r.ignored_project_keys, [], 'a copied value equal to the user value is not an override');
    assert.equal(r.config.allow_remote, true);
    assert.equal(r.config.api_key_env, 'JEV_API_KEY');
    assert.equal(r.config.base_url, 'https://jev.example');
  });

  test('a project value is reported only when it differs from the user-scope value (or the default when the user set none)', (t) => {
    const same = mod.resolveDecisionConfig(scopes(t, { allow_remote: false, api_key_env: 'OPENROUTER_API_KEY' }));
    assert.deepEqual(same.ignored_project_keys, [], 'values equal to the defaults in effect change nothing');
    const wider = mod.resolveDecisionConfig(scopes(t, { allow_remote: true, api_key_env: 'OPENROUTER_API_KEY' }));
    assert.deepEqual(wider.ignored_project_keys, ['decision_model.allow_remote']);
    const copied = mod.resolveDecisionConfig(scopes(t, { allow_remote: true, api_key_env: 'JEV_API_KEY' }, { allow_remote: true, api_key_env: 'JEV_API_KEY' }));
    assert.deepEqual(copied.ignored_project_keys, []);
    const differs = mod.resolveDecisionConfig(scopes(t, { api_key_env: 'OTHER_API_KEY' }, { api_key_env: 'JEV_API_KEY' }));
    assert.deepEqual(differs.ignored_project_keys, ['decision_model.api_key_env']);
    assert.equal(differs.config.api_key_env, 'JEV_API_KEY');
  });

  test('api_key_env must be an upper-case NAME ending in _API_KEY', () => {
    for (const ok of ['OPENROUTER_API_KEY', 'JEV_API_KEY', 'A_API_KEY', 'X9_API_KEY']) {
      assert.equal(mod.validateDecisionConfig({ api_key_env: ok }).valid, true, ok);
    }
    for (const bad of ['GITHUB_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'ANTHROPIC_API_KEY_X', '_API_KEY', 'jev_api_key', 'API_KEY', '', 7]) {
      assert.equal(mod.validateDecisionConfig({ api_key_env: bad }).valid, false, String(bad));
    }
  });
});

describe('D23 a credential-bearing backend is honored only from user scope', () => {
  test('the registry marks which backends send a credential; the rule keys off that property, not a name', () => {
    assert.equal(mod.BACKENDS.jev.sendsCredential, true);
    assert.equal(mod.BACKENDS['openai-letter'].sendsCredential, false);
  });

  test('the live case: a project jev with no user backend falls back to openai-letter and is reported', (t) => {
    const project = scopes(t, { enabled: true, model: 'x', backend: 'jev', base_url: 'https://remote.example' });
    const r = mod.resolveDecisionConfig(project);
    assert.equal(r.valid, true, r.problems.join('; '));
    assert.equal(r.config.backend, 'openai-letter', 'a project cannot select a key-sending backend');
    assert.equal(r.config.base_url, 'http://127.0.0.1:1234');
    assert.deepEqual(r.ignored_project_keys, ['decision_model.backend', 'decision_model.base_url']);
    const status = mod.statusSync({ cwd: project });
    assert.equal(status.backend, 'openai-letter');
    assert.deepEqual(status.ignored_project_keys, ['decision_model.backend', 'decision_model.base_url']);
  });

  test('a project jev is ignored when the user chose openai-letter explicitly', (t) => {
    const r = mod.resolveDecisionConfig(scopes(t, { backend: 'jev' }, { backend: 'openai-letter' }));
    assert.equal(r.config.backend, 'openai-letter');
    assert.deepEqual(r.ignored_project_keys, ['decision_model.backend']);
  });

  test('a workstream jev is ignored like a root one', (t) => {
    const project = scopes(t, { enabled: true, model: 'x' });
    const prevWs = process.env.GSD_WORKSTREAM;
    t.after(() => { if (prevWs === undefined) delete process.env.GSD_WORKSTREAM; else process.env.GSD_WORKSTREAM = prevWs; });
    const wsDir = path.join(project, '.planning', 'workstreams', 'ws1');
    fs.mkdirSync(wsDir, { recursive: true });
    fs.writeFileSync(path.join(wsDir, 'config.json'), JSON.stringify({ decision_model: { backend: 'jev' } }));
    process.env.GSD_WORKSTREAM = 'ws1';
    const r = mod.resolveDecisionConfig(project);
    assert.equal(r.config.backend, 'openai-letter');
    assert.deepEqual(r.ignored_project_keys, ['decision_model.backend']);
  });

  test('positive control: a user-scope jev is used, with or without a project copy, and nothing is reported', (t) => {
    const onlyUser = mod.resolveDecisionConfig(scopes(t, { enabled: true, model: 'x' }, { backend: 'jev' }));
    assert.equal(onlyUser.config.backend, 'jev', 'the user-scope backend is read when the project sets none');
    assert.deepEqual(onlyUser.ignored_project_keys, []);
    const copied = mod.resolveDecisionConfig(scopes(t, { enabled: true, model: 'x', backend: 'jev' }, { backend: 'jev' }));
    assert.equal(copied.config.backend, 'jev');
    assert.deepEqual(copied.ignored_project_keys, [], 'a project value equal to the user value is not an override');
  });

  test('a project may still pick a backend that sends no credential (D23 limits only key-sending backends)', (t) => {
    const r = mod.resolveDecisionConfig(scopes(t, { backend: 'openai-letter' }, { backend: 'jev' }));
    assert.equal(r.config.backend, 'openai-letter');
    assert.deepEqual(r.ignored_project_keys, []);
  });
});

/** An enabled, valid loopback project for decideSync; returns {project, logFile}. */
function syncProject(t, over = {}) {
  const project = scopes(t, {
    enabled: true, model: 'm', base_url: 'http://127.0.0.1:9', log_path: '.planning/dm.log.jsonl', ...over,
  });
  return { project, logFile: path.join(project, '.planning', 'dm.log.jsonl') };
}

const TWO_Q = { state: 's', questions: { q1: { type: 'noul', instructions: 'One?' }, q2: { type: 'noul', instructions: 'Two?' } } };

function logReasons(logFile) {
  return splitLines(fs.readFileSync(logFile, 'utf8')).filter(Boolean).map((l) => JSON.parse(l).reason);
}

describe('WR-02 spawn bridge failure mapping', () => {
  for (const [label, result, reason] of [
    ['a budget kill (ETIMEDOUT + SIGKILL)', { status: null, signal: 'SIGKILL', error: Object.assign(new Error('t'), { code: 'ETIMEDOUT' }) }, 'timeout'],
    ['a maxBuffer overflow (ENOBUFS + SIGKILL)', { status: null, signal: 'SIGKILL', error: Object.assign(new Error('b'), { code: 'ENOBUFS' }) }, 'invalid-output'],
    ['a crash (SIGABRT)', { status: null, signal: 'SIGABRT' }, 'invalid-output'],
    ['an OOM-style kill (SIGKILL, no error)', { status: null, signal: 'SIGKILL' }, 'invalid-output'],
  ]) {
    test(`${label} abstains ${reason} for every question and is logged`, (t) => {
      const { project, logFile } = syncProject(t);
      const r = mod.decideSync(TWO_Q, { cwd: project, _spawn: () => result });
      for (const k of ['q1', 'q2']) assert.deepEqual(r.results[0].answers[k], { status: 'abstain', reason }, k);
      assert.deepEqual(logReasons(logFile), [reason, reason]);
    });
  }
});

describe('WR-07 spawn bridge and probe through the _spawn seam', () => {
  for (const [label, spawn] of [
    ['a non-zero exit', () => ({ status: 1, stdout: '' })],
    ['unparseable stdout', () => ({ status: 0, stdout: 'garbage' })],
    ['a response without a results array', () => ({ status: 0, stdout: JSON.stringify({ response: { backend: 'x' } }) })],
    ['a missing stdout', () => ({ status: 0, stdout: null })],
    ['a spawn that throws', () => { throw new Error('EAGAIN'); }],
  ]) {
    test(`${label} abstains invalid-output for every question and is logged`, (t) => {
      const { project, logFile } = syncProject(t);
      const r = mod.decideSync(TWO_Q, { cwd: project, _spawn: spawn });
      for (const k of ['q1', 'q2']) assert.deepEqual(r.results[0].answers[k], { status: 'abstain', reason: 'invalid-output' }, k);
      assert.deepEqual(logReasons(logFile), ['invalid-output', 'invalid-output']);
    });
  }

  test('a good child response passes through, its diagnostics reach the log, and the child gets a bounded budget', (t) => {
    const { project, logFile } = syncProject(t, { timeout_ms: 1000 });
    const seen = [];
    const response = {
      backend: 'openai-letter', model: 'm', endpoint_host: '127.0.0.1:9', min_confidence: 0.9,
      results: [{ id: 'default', answers: { q1: { status: 'ok', answer: 'yes', p_yes: 0.95, confidence: 0.95 }, q2: { status: 'abstain', reason: 'low-confidence', confidence: 0.6, below_floor_choice: 'no' } } }],
    };
    const r = mod.decideSync(TWO_Q, {
      cwd: project,
      _spawn: (cmd, args, opts) => {
        seen.push({ cmd, args, opts });
        return { status: 0, stdout: JSON.stringify({ response, diagnostics: [{ id: 'default', key: 'q1', http_status: 200, latency_ms: 12 }] }) };
      },
    });
    assert.deepEqual(r, response);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].cmd, process.execPath);
    assert.equal(seen[0].args[1], '--decide-child');
    assert.equal(seen[0].opts.windowsHide, true);
    assert.equal(seen[0].opts.timeout, 1000 * 2 + 5000, 'timeout_ms per call plus the margin');
    const lines = splitLines(fs.readFileSync(logFile, 'utf8')).filter(Boolean).map((l) => JSON.parse(l));
    assert.deepEqual(lines.map((l) => [l.key, l.status, l.http_status, l.latency_ms]), [['q1', 'ok', 200, 12], ['q2', 'abstain', null, null]]);
  });

  for (const [label, spawn, reachable] of [
    ['a child that answers reachable true', () => ({ status: 0, stdout: '{"reachable":true}' }), true],
    ['a child that answers reachable false', () => ({ status: 0, stdout: '{"reachable":false}' }), false],
    ['a spawn error', () => ({ status: null, error: Object.assign(new Error('t'), { code: 'ETIMEDOUT' }) }), false],
    ['a signal', () => ({ status: null, signal: 'SIGKILL' }), false],
    ['a non-zero exit', () => ({ status: 1, stdout: '{"reachable":true}' }), false],
    ['unparseable stdout', () => ({ status: 0, stdout: 'nope' }), false],
    ['a spawn that throws', () => { throw new Error('EAGAIN'); }, false],
  ]) {
    test(`statusSync --probe: ${label} gives reachable ${reachable}`, (t) => {
      const { project } = syncProject(t);
      assert.equal(mod.statusSync({ cwd: project, probe: true, _spawn: spawn }).reachable, reachable);
    });
  }
});

describe('WR-01 child deadline keeps answers computed before the spawn cap', () => {
  const noul = (i) => ({ type: 'noul', instructions: `Q${i}?` });
  const yes = (call) => {
    const options = optionsOf(call);
    const y = options.find((o) => o.key === 'yes');
    const n = options.find((o) => o.key === 'no');
    return { ok: true, status: 200, body: completion(y.label, [{ token: y.label, logprob: Math.log(0.97) }, { token: n.label, logprob: Math.log(0.03) }]) };
  };

  test('questions reached before the deadline are answered; the rest abstain timeout without a call', async () => {
    let clock = 0;
    const h = fakeHttp((call) => { clock += 1000; return yes(call); });
    const r = await mod.decide(
      req({ q1: noul(1), q2: noul(2), q3: noul(3) }),
      { config: cfg({ timeout_ms: 30000 }), http: h.http, deadline: 2500, now: () => clock },
    );
    const a = r.results[0].answers;
    assert.equal(a.q1.status, 'ok');
    assert.equal(a.q2.status, 'ok');
    assert.deepEqual(a.q3, { status: 'abstain', reason: 'timeout' });
    assert.equal(h.calls.length, 2);
    assert.deepEqual(h.calls.map((c) => c.timeoutMs), [2500, 1500], 'each call is clipped to the time left');
  });

  test('without a deadline every call gets the configured timeout', async () => {
    const h = fakeHttp(yes);
    await mod.decide(req({ q1: noul(1), q2: noul(2) }), { config: cfg({ timeout_ms: 4321 }), http: h.http });
    assert.deepEqual(h.calls.map((c) => c.timeoutMs), [4321, 4321]);
  });

  test('jev: an order_check whose reversed call would pass the deadline abstains timeout and keeps the unchecked answers', async () => {
    let clock = 0;
    const h = fakeHttp(() => {
      clock += 5000;
      return { ok: true, status: 200, body: { answers: { c: { choice: 'a', confidence: 0.9, probabilities: { a: 0.9, b: 0.1 } }, n: { noul: 0.9 } } } };
    });
    const r = await mod.decide(
      req({ c: choiceQ(['a', 'b'], { order_check: true }), n: { type: 'noul', instructions: 'Is it?' } }),
      {
        config: cfg({ backend: 'jev', base_url: 'https://jev.example.test', allow_remote: true, min_confidence: 0.5 }),
        http: h.http, env: { OPENROUTER_API_KEY: 'k' }, deadline: 5500, now: () => clock,
      },
    );
    assert.equal(h.calls.length, 1);
    assert.deepEqual(r.results[0].answers.c, { status: 'abstain', reason: 'timeout' });
    assert.equal(r.results[0].answers.n.status, 'ok');
  });

  test('decideSync hands the child a call budget inside the 900 s kill budget when the cap bites', (t) => {
    // 2 calls x 600000 ms + 5000 > 900000: the budget is capped. IN-03: the child gets a
    // duration it measures on its own monotonic clock, never a wall-clock epoch.
    const { project } = syncProject(t, { timeout_ms: 600000 });
    let input = null;
    let timeout = null;
    mod.decideSync(TWO_Q, { cwd: project, _spawn: (cmd, args, opts) => { input = JSON.parse(opts.input); timeout = opts.timeout; return { status: 1 }; } });
    assert.equal(timeout, 900000);
    assert.equal(input.budget_ms, 895000);
    assert.equal(input.deadline, undefined, 'no wall-clock deadline crosses the process boundary');
  });

  test('decideSync passes no call budget when every call fits the budget', (t) => {
    const { project } = syncProject(t, { timeout_ms: 300 });
    let input = null;
    mod.decideSync(TWO_Q, { cwd: project, _spawn: (cmd, args, opts) => { input = JSON.parse(opts.input); return { status: 1 }; } });
    assert.equal(input.budget_ms, undefined);
  });

  test('a timeout_ms below the 1 s minimum still allows a call that fits', async () => {
    let clock = 0;
    const h = fakeHttp((call) => { clock += 100; return yes(call); });
    const r = await mod.decide(req({ q1: noul(1) }), { config: cfg({ timeout_ms: 300 }), http: h.http, deadline: 400, now: () => clock });
    assert.equal(r.results[0].answers.q1.status, 'ok');
    assert.deepEqual(h.calls.map((c) => c.timeoutMs), [300]);
  });
});

describe('WR-10 invalid config values are never echoed into typed fields', () => {
  test('an invalid min_confidence or backend is null in the response envelope', async () => {
    for (const [over, field] of [[{ min_confidence: 'high' }, 'min_confidence'], [{ min_confidence: 7 }, 'min_confidence'], [{ backend: 'nope' }, 'backend'], [{ backend: 42 }, 'backend']]) {
      const { response, h } = await ask({ q: choiceQ() }, { config: cfg(over) });
      assert.equal(response[field], null, JSON.stringify(over));
      assert.deepEqual(response.results[0].answers.q, { status: 'abstain', reason: 'invalid-config' });
      assert.equal(h.calls.length, 0);
    }
    const { response } = await ask({ q: choiceQ() }, { config: cfg({ min_confidence: 0.8 }) });
    assert.equal(response.min_confidence, 0.8);
    assert.equal(response.backend, 'openai-letter');
  });

  test('--status reports null for an out-of-range number and lists config_problems', (t) => {
    // Through config.json, loadConfig already replaces a wrong-typed or out-of-enum value with
    // the schema default; an in-type value outside the engine's range still reaches it.
    const project = scopes(t, { enabled: true, model: 'm', min_confidence: 7, timeout_ms: -1 });
    const st = mod.statusSync({ cwd: project });
    assert.equal(st.min_confidence, null);
    assert.equal(st.backend, 'openai-letter');
    assert.equal(st.config_problems.length, 2, JSON.stringify(st.config_problems));
    const good = mod.statusSync({ cwd: scopes(t, { enabled: true, model: 'm' }) });
    assert.equal(good.min_confidence, 0.9);
    assert.equal(good.backend, 'openai-letter');
    assert.deepEqual(good.config_problems, []);
  });
});

describe('D19 per-question min_confidence', () => {
  test('a question floor of 0.6 accepts confidence 0.7 while the config floor is 0.9', async () => {
    const { response, answers } = await ask(
      { q: choiceQ(['a', 'b'], { min_confidence: 0.6 }) },
      { config: cfg({ min_confidence: 0.9 }), handler: twoWay('A', 0.7) },
    );
    assert.equal(answers.q.status, 'ok');
    assert.equal(answers.q.choice, 'a');
    assert.equal(answers.q.confidence, 0.7);
    assert.equal(response.min_confidence, 0.9, 'the response reports the config floor');
  });

  test('a question floor of 0.95 abstains low-confidence at confidence 0.93 and keeps the would-be choice', async () => {
    const { answers } = await ask(
      { q: choiceQ(['a', 'b'], { min_confidence: 0.95 }) },
      { config: cfg({ min_confidence: 0.5 }), handler: twoWay('A', 0.93) },
    );
    assert.deepEqual(answers.q, {
      status: 'abstain', reason: 'low-confidence', confidence: 0.93, below_floor_choice: 'a',
    });
  });

  test('0.49, 1.01 and the string 0.7 abstain invalid-request with zero calls; 0.5 and 1 are accepted', async () => {
    const bad = [0.49, 1.01, '0.7', null, Number.NaN];
    const questions = {};
    bad.forEach((v, i) => { questions[`bad${i}`] = choiceQ(['a', 'b'], { min_confidence: v }); });
    const h = fakeHttp(pickByKey(() => 'a'));
    const r = await mod.decide(req(questions), { config: cfg(), http: h.http });
    for (const k of Object.keys(questions)) {
      assert.deepEqual(r.results[0].answers[k], { status: 'abstain', reason: 'invalid-request' }, k);
    }
    assert.equal(h.calls.length, 0);

    const { answers } = await ask({
      lo: choiceQ(['a', 'b'], { min_confidence: 0.5 }),
      hi: choiceQ(['a', 'b'], { min_confidence: 1 }),
    }, { handler: pickByKey(() => 'a', 0.999) });
    assert.equal(answers.lo.status, 'ok');
    assert.equal(answers.hi.status, 'abstain', 'a floor of 1 is accepted but a 0.999 answer is below it');
    assert.equal(answers.hi.reason, 'low-confidence');
  });
});

describe('D19 order_check', () => {
  test('a consistent model is asked twice; the answer keeps the pick with the lower confidence', async () => {
    const h = fakeHttp((call, i) => pickByKey(() => 'b', i === 0 ? 0.97 : 0.92)(call, i));
    const r = await mod.decide(
      req({ q: choiceQ(['a', 'b', 'c'], { order_check: true }) }),
      { config: cfg(), http: h.http },
    );
    assert.equal(h.calls.length, 2);
    const a = r.results[0].answers.q;
    assert.equal(a.status, 'ok');
    assert.equal(a.choice, 'b');
    assert.ok(a.confidence <= 0.92 + 1e-9 && a.confidence > 0.9, `confidence ${a.confidence}`);

    const first = optionsOf(h.calls[0]);
    const second = optionsOf(h.calls[1]);
    assert.deepEqual(first.map((o) => `${o.label}=${o.key}`), ['A=a', 'B=b', 'C=c']);
    assert.deepEqual(second.map((o) => `${o.label}=${o.key}`), ['A=c', 'B=b', 'C=a']);
  });

  test('a position-biased model (always A) abstains order-inconsistent with the first confidence', async () => {
    const { answers, h } = await ask(
      { q: choiceQ(['a', 'b'], { order_check: true }) },
      { handler: twoWay('A', 0.96) },
    );
    assert.equal(h.calls.length, 2);
    assert.deepEqual(answers.q, { status: 'abstain', reason: 'order-inconsistent', confidence: 0.96 });
  });

  test('a non-boolean order_check abstains invalid-request', async () => {
    const { answers, h } = await ask({ q: choiceQ(['a', 'b'], { order_check: 'yes' }) });
    assert.deepEqual(answers.q, { status: 'abstain', reason: 'invalid-request' });
    assert.equal(h.calls.length, 0);
  });

  test('when the first call abstains there is no second call and the reason carries through', async () => {
    const { answers, h } = await ask(
      { q: choiceQ(['a', 'b'], { order_check: true }) },
      { handler: () => ({ ok: false, status: 500, body: 'exceed_context_size_error' }) },
    );
    assert.equal(h.calls.length, 1);
    assert.deepEqual(answers.q, { status: 'abstain', reason: 'context-exceeded' });
  });

  test('a noul question is checked with yes and no swapped', async () => {
    const h = fakeHttp((call) => {
      const options = optionsOf(call);
      const yes = options.find((o) => o.key === 'yes');
      return {
        ok: true,
        status: 200,
        body: completion(yes.label, [
          { token: yes.label, logprob: Math.log(0.97) },
          { token: options.find((o) => o.key === 'no').label, logprob: Math.log(0.03) },
        ]),
      };
    });
    const r = await mod.decide(
      req({ n: { type: 'noul', instructions: 'Is it?', order_check: true } }),
      { config: cfg(), http: h.http },
    );
    assert.equal(h.calls.length, 2);
    assert.deepEqual(optionsOf(h.calls[1]).map((o) => o.key), ['no', 'yes']);
    assert.equal(r.results[0].answers.n.status, 'ok');
    assert.equal(r.results[0].answers.n.answer, 'yes');
  });
});

describe('jev backend (fake HTTP only)', () => {
  const SECRET = 'sk-test-secret-9d41';
  const jevCfg = (over = {}) => cfg({
    backend: 'jev', base_url: 'https://jev.example.test/', allow_remote: true, min_confidence: 0.5, ...over,
  });
  const ENV = { OPENROUTER_API_KEY: SECRET };

  const MIXED = {
    c: choiceQ(['a', 'b']),
    n: { type: 'noul', instructions: 'Is it?' },
    s: { type: 'score', instructions: 'How much?', criteria: { low: 'not much', mid: 'some', high: 'lots' } },
  };

  function jevHandler(answers) {
    return () => ({ ok: true, status: 200, body: { model: 'm', answers } });
  }

  test('sends one authenticated POST and maps choice, noul and score answers', async () => {
    const h = fakeHttp(jevHandler({
      c: { choice: 'b', confidence: 0.95, probabilities: { b: 0.95 } },
      n: { noul: 0.8 },
      s: { score: 1.4, confidence: 0.9, probabilities: { 0: 0.1, 1: 0.5, 2: 0.4 }, legend: ['x', 'y', 'z'] },
    }));
    const r = await mod.decide(req(MIXED), { config: jevCfg(), http: h.http, env: ENV });

    assert.equal(h.calls.length, 1);
    const call = h.calls[0];
    assert.equal(call.url, 'https://jev.example.test/api/alpha/decisions');
    assert.equal(call.method, 'POST');
    assert.equal(call.headers.Authorization, `Bearer ${SECRET}`);
    assert.deepEqual(Object.keys(call.body), ['model', 'state', 'questions']);
    assert.equal(call.body.model, 'm');
    assert.equal(call.body.state, 'some state');
    assert.deepEqual(call.body.questions.c.criteria, { a: 'the a option', b: 'the b option' });
    assert.deepEqual(call.body.questions.n.criteria, { true: 'Yes', false: 'No' });
    assert.deepEqual(call.body.questions.s.criteria, ['not much', 'some', 'lots']);

    const a = r.results[0].answers;
    assert.deepEqual(a.c, { status: 'ok', choice: 'b', confidence: 0.95, probabilities: { a: 0, b: 0.95 } });
    assert.deepEqual(a.n, { status: 'ok', answer: 'yes', p_yes: 0.8, confidence: 0.8 });
    assert.deepEqual(a.s, {
      status: 'ok', choice: 'mid', score: 1.4, confidence: 0.9,
      probabilities: { low: 0.1, mid: 0.5, high: 0.4 },
    });
    assert.equal(r.backend, 'jev');
    assert.ok(!JSON.stringify(r).includes(SECRET), 'the key never appears in the response');
  });

  test('a noul answer below 0.5 is no with confidence 1 - p; a score tie takes the first level', async () => {
    const h = fakeHttp(jevHandler({
      n: { noul: 0.25 },
      s: { score: 0.6, confidence: 0.9, probabilities: { 0: 0.4, 1: 0.4, 2: 0.2 } },
    }));
    const r = await mod.decide(req({ n: MIXED.n, s: MIXED.s }), { config: jevCfg(), http: h.http, env: ENV });
    assert.deepEqual(r.results[0].answers.n, { status: 'ok', answer: 'no', p_yes: 0.25, confidence: 0.75 });
    assert.equal(r.results[0].answers.s.choice, 'low');
  });

  test('a missing or ill-typed answer is invalid-output', async () => {
    const h = fakeHttp(jevHandler({
      c: { choice: 'zzz', confidence: 0.9, probabilities: { a: 0.9 } },
      n: { noul: 'high' },
    }));
    const r = await mod.decide(req(MIXED), { config: jevCfg(), http: h.http, env: ENV });
    for (const k of ['c', 'n', 's']) {
      assert.deepEqual(r.results[0].answers[k], { status: 'abstain', reason: 'invalid-output' }, k);
    }
    const bad = fakeHttp(() => ({ ok: true, status: 200, body: 'not json at all' }));
    const r2 = await mod.decide(req({ n: MIXED.n }), { config: jevCfg(), http: bad.http, env: ENV });
    assert.equal(r2.results[0].answers.n.reason, 'invalid-output');
  });

  test('HTTP 401 and 403 are invalid-config; other failures classify like openai-letter', async () => {
    for (const [status, reason] of [[401, 'invalid-config'], [403, 'invalid-config'], [500, 'unreachable'], [404, 'model-missing']]) {
      const h = fakeHttp(() => ({ ok: false, status, body: '{}' }));
      const r = await mod.decide(req({ n: MIXED.n }), { config: jevCfg(), http: h.http, env: ENV });
      assert.equal(r.results[0].answers.n.reason, reason, `status ${status}`);
    }
  });

  test('a missing or empty key is invalid-config with zero HTTP calls', async () => {
    for (const env of [{}, { OPENROUTER_API_KEY: '' }, { OPENROUTER_API_KEY: '   ' }]) {
      const h = fakeHttp(jevHandler({}));
      const r = await mod.decide(req({ n: MIXED.n }), { config: jevCfg(), http: h.http, env });
      assert.deepEqual(r.results[0].answers.n, { status: 'abstain', reason: 'invalid-config' });
      assert.equal(h.calls.length, 0);
    }
  });

  test('WR-06: a key is never sent over plain http to a non-loopback host (invalid-config, zero calls)', async () => {
    for (const base of ['http://jev.example.test', 'http://192.0.2.1:8080/']) {
      const h = fakeHttp(jevHandler({ n: { noul: 0.9 } }));
      const r = await mod.decide(req({ n: MIXED.n }), { config: jevCfg({ base_url: base }), http: h.http, env: ENV });
      assert.deepEqual(r.results[0].answers.n, { status: 'abstain', reason: 'invalid-config' }, base);
      assert.equal(h.calls.length, 0, base);
    }
    assert.equal(mod.validateDecisionConfig(jevCfg({ base_url: 'http://jev.example.test' })).valid, false);
    // Loopback http and remote https are both allowed; openai-letter sends no key, so http is fine for it.
    for (const [over, ok] of [[{ base_url: 'http://127.0.0.1:9' }, true], [{}, true], [{ backend: 'openai-letter', base_url: 'http://jev.example.test' }, true]]) {
      assert.equal(mod.validateDecisionConfig(jevCfg(over)).valid, ok, JSON.stringify(over));
    }
  });

  test('api_key_env names the variable that is read', async () => {
    const h = fakeHttp(jevHandler({ n: { noul: 0.9 } }));
    const r = await mod.decide(
      req({ n: MIXED.n }),
      { config: jevCfg({ api_key_env: 'MY_JEV_API_KEY' }), http: h.http, env: { MY_JEV_API_KEY: 'k2', OPENROUTER_API_KEY: SECRET } },
    );
    assert.equal(h.calls[0].headers.Authorization, 'Bearer k2');
    assert.equal(r.results[0].answers.n.status, 'ok');
  });

  test('a batch sends one POST per request, in order', async () => {
    const h = fakeHttp(jevHandler({ n: { noul: 0.9 } }));
    const r = await mod.decide(
      { requests: [{ id: 'r2', state: 's2', questions: { n: MIXED.n } }, { id: 'r1', state: 's1', questions: { n: MIXED.n } }] },
      { config: jevCfg(), http: h.http, env: ENV },
    );
    assert.deepEqual(r.results.map((x) => x.id), ['r2', 'r1']);
    assert.deepEqual(h.calls.map((c) => c.body.state), ['s2', 's1']);
  });

  test('order_check re-asks only the checked questions with criteria reversed and remaps the score', async () => {
    const h = fakeHttp((_call, i) => ({
      ok: true,
      status: 200,
      body: {
        answers: i === 0
          ? {
            c: { choice: 'b', confidence: 0.9, probabilities: { a: 0.1, b: 0.9 } },
            s: { score: 1.6, confidence: 0.7, probabilities: { 0: 0.1, 1: 0.2, 2: 0.7 } },
            n: { noul: 0.9 },
          }
          : {
            c: { choice: 'b', confidence: 0.8, probabilities: { a: 0.2, b: 0.8 } },
            s: { score: 0.4, confidence: 0.6, probabilities: { 0: 0.7, 1: 0.2, 2: 0.1 } },
          },
      },
    }));
    const r = await mod.decide(
      req({
        c: { ...MIXED.c, order_check: true },
        s: { ...MIXED.s, order_check: true },
        n: MIXED.n,
      }),
      { config: jevCfg(), http: h.http, env: ENV },
    );
    assert.equal(h.calls.length, 2);
    assert.deepEqual(Object.keys(h.calls[1].body.questions), ['c', 's']);
    assert.deepEqual(Object.keys(h.calls[1].body.questions.c.criteria), ['b', 'a']);
    assert.deepEqual(h.calls[1].body.questions.s.criteria, ['lots', 'some', 'not much']);
    const a = r.results[0].answers;
    assert.equal(a.c.status, 'ok');
    assert.equal(a.c.confidence, 0.8, 'the lower of the two confidences');
    assert.equal(a.s.status, 'ok');
    assert.equal(a.s.choice, 'high');
    assert.equal(a.s.score, 1.6, 'the first-call score, which equals (n-1) - the reversed score');
    assert.equal(a.s.confidence, 0.6);
    assert.equal(a.n.status, 'ok');
  });

  test('CR-02: order_check reverses the criteria on the wire, not only in the parsed object', async () => {
    // IN-05: the integer-keyed question makes this a CR-02 regression test. Before the
    // fix it reached the wire, and its reversed criteria were sent in the same order
    // (JavaScript puts integer keys first, ascending), so the check below failed.
    const h = fakeHttp(() => ({
      ok: true,
      status: 200,
      body: { answers: { c: { choice: 'first', confidence: 0.9, probabilities: { first: 0.9 } }, i: { choice: '1', confidence: 0.9, probabilities: { 1: 0.9 } } } },
    }));
    const criteria = { first: 'one', second: 'two', third: 'three' };
    const r = await mod.decide(
      req({
        c: { type: 'choice', instructions: 'Pick.', criteria, order_check: true },
        i: { type: 'choice', instructions: 'Pick.', criteria: { 1: 'one', 2: 'two', 3: 'three' }, order_check: true },
      }),
      { config: jevCfg(), http: h.http, env: ENV },
    );
    assert.equal(h.calls.length, 2);
    const [fwd, rev] = h.calls.map((c) => c.raw);
    const wireOrderOf = (raw, keys) => [...keys].sort((a, b) => raw.indexOf(`"${a}":`) - raw.indexOf(`"${b}":`));
    // Every question the reversed call carries lists its options in exactly the reverse wire order.
    for (const k of Object.keys(JSON.parse(rev).questions)) {
      const keys = Object.keys(JSON.parse(fwd).questions[k].criteria);
      assert.deepEqual(wireOrderOf(rev, keys), wireOrderOf(fwd, keys).reverse(), `${k}: ${rev}`);
    }
    assert.deepEqual(wireOrderOf(fwd, ['first', 'second', 'third']), ['first', 'second', 'third'], fwd);
    assert.deepEqual(Object.keys(JSON.parse(rev).questions), ['c'], 'the integer-keyed question never reaches the wire');
    assert.equal(r.results[0].answers.i.reason, 'invalid-request');
    assert.notEqual(fwd, rev, 'the reversed request differs from the first');
  });

  test('CR-02: integer-keyed jev criteria abstain invalid-request with zero calls (the reversal could not happen)', async () => {
    const h = fakeHttp(jevHandler({}));
    const r = await mod.decide(
      req({ c: { type: 'choice', instructions: 'Pick.', criteria: { 1: 'first', 2: 'second' }, order_check: true } }),
      { config: jevCfg(), http: h.http, env: ENV },
    );
    assert.deepEqual(r.results[0].answers.c, { status: 'abstain', reason: 'invalid-request' });
    assert.equal(h.calls.length, 0);
  });

  test('order_check abstains order-inconsistent when the reversed answer remaps to a different level', async () => {
    // The same raw answer both times; under reversal raw level 2 is original level 0.
    const raw = { score: 1.6, confidence: 0.7, probabilities: { 0: 0.1, 1: 0.2, 2: 0.7 } };
    const h = fakeHttp(() => ({ ok: true, status: 200, body: { answers: { s: raw } } }));
    const r = await mod.decide(
      req({ s: { ...MIXED.s, order_check: true } }),
      { config: jevCfg(), http: h.http, env: ENV },
    );
    assert.deepEqual(r.results[0].answers.s, { status: 'abstain', reason: 'order-inconsistent', confidence: 0.7 });
  });

  test('IN-06: a rejected key (401) trips the breaker, so the key is not sent again', async () => {
    const h = fakeHttp(() => ({ ok: false, status: 401, body: '{}' }));
    const r = await mod.decide(
      { requests: [
        { id: 'r1', state: 's1', questions: { n: MIXED.n } },
        { id: 'r2', state: 's2', questions: { n: MIXED.n } },
      ] },
      { config: jevCfg(), http: h.http, env: ENV },
    );
    assert.equal(h.calls.length, 1);
    assert.equal(r.results[0].answers.n.reason, 'invalid-config');
    assert.equal(r.results[1].answers.n.reason, 'invalid-config');
  });

  test('a failed POST trips the breaker for the rest of the invocation', async () => {
    const h = fakeHttp(() => ({ ok: false, status: 0, body: '', timedOut: true }));
    const r = await mod.decide(
      { requests: [
        { id: 'r1', state: 's1', questions: { n: MIXED.n } },
        { id: 'r2', state: 's2', questions: { n: MIXED.n } },
      ] },
      { config: jevCfg(), http: h.http, env: ENV },
    );
    assert.equal(h.calls.length, 1);
    assert.equal(r.results[0].answers.n.reason, 'timeout');
    assert.equal(r.results[1].answers.n.reason, 'timeout');
  });

  test('more than 24 criteria abstain too-many-options without a call', async () => {
    const h = fakeHttp(jevHandler({}));
    const r = await mod.decide(
      req({ c: { type: 'choice', instructions: 'Pick.', criteria: criteriaOf(25) } }),
      { config: jevCfg(), http: h.http, env: ENV },
    );
    assert.equal(r.results[0].answers.c.reason, 'too-many-options');
    assert.equal(h.calls.length, 0);
  });
});

describe('circuit breaker and sequencing', () => {
  const three = () => ({ q1: choiceQ(), q2: choiceQ(), q3: choiceQ() });

  for (const [label, result, reason] of [
    ['timeout', { ok: false, status: 0, body: '', timedOut: true }, 'timeout'],
    ['unreachable', { ok: false, status: 0, body: '', timedOut: false }, 'unreachable'],
    ['model-missing', { ok: false, status: 404, body: '{}' }, 'model-missing'],
  ]) {
    test(`a ${label} result stops the invocation after one call`, async () => {
      const { answers, h } = await ask(three(), { handler: () => result });
      assert.equal(h.calls.length, 1);
      for (const k of ['q1', 'q2', 'q3']) {
        assert.deepEqual(answers[k], { status: 'abstain', reason }, k);
      }
    });
  }

  test('context-exceeded does not trip the breaker', async () => {
    const { answers, h } = await ask(three(), {
      handler: () => ({ ok: false, status: 400, body: '{"error":{"type":"exceed_context_size_error"}}' }),
    });
    assert.equal(h.calls.length, 3);
    for (const k of ['q1', 'q2', 'q3']) assert.equal(answers[k].reason, 'context-exceeded');
  });

  test('backend calls are strictly sequential across a 5-question request', async () => {
    const questions = {};
    for (let i = 0; i < 5; i += 1) questions[`q${i}`] = choiceQ();
    const { h, answers } = await ask(questions);
    assert.equal(h.calls.length, 5);
    assert.equal(h.maxInFlight, 1);
    assert.equal(Object.keys(answers).length, 5);
  });

  test('the breaker state does not leak between invocations', async () => {
    const down = fakeHttp(() => ({ ok: false, status: 0, body: '', timedOut: true }));
    await mod.decide(req({ q: choiceQ() }), { config: cfg(), http: down.http });
    const up = fakeHttp(pickByKey(() => 'a'));
    const r = await mod.decide(req({ q: choiceQ() }), { config: cfg(), http: up.http });
    assert.equal(up.calls.length, 1);
    assert.equal(r.results[0].answers.q.status, 'ok');
  });
});

describe('egress', () => {
  test('a non-loopback or ambiguous host without allow_remote abstains with zero calls', async () => {
    for (const base of ['http://192.0.2.1', 'http://0.0.0.0', 'http://[::ffff:127.0.0.1]', 'http://example.com:1234']) {
      const { answers, h } = await ask({ q: choiceQ() }, { config: cfg({ base_url: base }) });
      assert.deepEqual(answers.q, { status: 'abstain', reason: 'egress-not-consented' }, base);
      assert.equal(h.calls.length, 0, base);
    }
  });

  test('127.1, 2130706433, localhost and [::1] are loopback and are sent', async () => {
    for (const base of ['http://127.1:1234', 'http://2130706433:1234', 'http://localhost:1234', 'http://[::1]:1234']) {
      assert.equal(mod.isLoopbackUrl(base), true, base);
      const { answers, h } = await ask({ q: choiceQ() }, { config: cfg({ base_url: base }) });
      assert.equal(answers.q.status, 'ok', base);
      assert.equal(h.calls.length, 1, base);
    }
  });

  test('allow_remote true sends to a remote host', async () => {
    const { answers, h } = await ask({ q: choiceQ() }, { config: cfg({ base_url: 'http://192.0.2.1:9', allow_remote: true }) });
    assert.equal(answers.q.status, 'ok');
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0].url, 'http://192.0.2.1:9/v1/chat/completions');
  });

  test('IN-08: a base_url with a query or fragment is invalid-config; a path is fine', () => {
    for (const base of ['http://127.0.0.1:1234/?x=1', 'http://127.0.0.1:1234/#f', 'http://127.0.0.1:1234/?']) {
      assert.equal(mod.validateDecisionConfig(cfg({ base_url: base })).valid, false, base);
    }
    for (const base of ['http://127.0.0.1:1234', 'http://127.0.0.1:1234/', 'http://127.0.0.1:1234/v1']) {
      assert.equal(mod.validateDecisionConfig(cfg({ base_url: base })).valid, true, base);
    }
  });

  test('isLoopbackUrl rejects non-http schemes and garbage', () => {
    for (const v of ['file:///etc/passwd', 'ftp://127.0.0.1', '127.0.0.1:1234', '', null, 42]) {
      assert.equal(mod.isLoopbackUrl(v), false, String(v));
    }
  });
});

describe('contract edges', () => {
  test('a choice with 2 or 24 criteria is answered; 1 is invalid-request; 25 is too-many-options', async () => {
    const { answers, h } = await ask({
      two: { type: 'choice', instructions: 'Pick.', criteria: criteriaOf(2) },
      max: { type: 'choice', instructions: 'Pick.', criteria: criteriaOf(24) },
      one: { type: 'choice', instructions: 'Pick.', criteria: criteriaOf(1) },
      over: { type: 'choice', instructions: 'Pick.', criteria: criteriaOf(25) },
      sone: { type: 'score', instructions: 'Rate.', criteria: criteriaOf(1) },
      sover: { type: 'score', instructions: 'Rate.', criteria: criteriaOf(25) },
      stwo: { type: 'score', instructions: 'Rate.', criteria: criteriaOf(2) },
    }, { handler: pickByKey(() => 'k0') });
    assert.equal(answers.two.status, 'ok');
    assert.equal(answers.max.status, 'ok');
    assert.equal(answers.stwo.status, 'ok');
    assert.equal(answers.one.reason, 'invalid-request');
    assert.equal(answers.sone.reason, 'invalid-request');
    assert.equal(answers.over.reason, 'too-many-options');
    assert.equal(answers.sover.reason, 'too-many-options');
    assert.equal(h.calls.length, 3);
    assert.equal(optionsOf(h.calls[1]).at(-1).label, 'X');
  });

  test('a criteria key that is reserved or malformed abstains invalid-request for that question only', async () => {
    const bad = JSON.parse('{"type":"choice","instructions":"Pick.","criteria":{"__proto__":"x","ok":"y"}}');
    const { answers } = await ask({
      reserved: bad,
      ctor: { type: 'choice', instructions: 'Pick.', criteria: { constructor: 'x', fine: 'y' } },
      spaced: { type: 'choice', instructions: 'Pick.', criteria: { 'a b': 'x', fine: 'y' } },
      good: choiceQ(['a', 'b']),
    });
    assert.equal(answers.reserved.reason, 'invalid-request');
    assert.equal(answers.ctor.reason, 'invalid-request');
    assert.equal(answers.spaced.reason, 'invalid-request');
    assert.equal(answers.good.status, 'ok');
  });

  test('CR-02: canonical-integer criteria keys abstain invalid-request; other numeric-looking keys are kept in order', async () => {
    const { answers, h } = await ask({
      score: { type: 'score', instructions: 'Rate.', criteria: JSON.parse('{"none":"zero","1":"one","2":"two"}') },
      zero: { type: 'choice', instructions: 'Pick.', criteria: { 0: 'x', a: 'y' } },
      big: { type: 'choice', instructions: 'Pick.', criteria: { 10: 'x', 9: 'y' } },
      kept: { type: 'score', instructions: 'Rate.', criteria: JSON.parse('{"level_2":"hi","01":"lo","1.5":"mid","-1":"neg"}') },
    }, { handler: pickByKey((call, i, options) => options[0].key) });
    assert.deepEqual(answers.score, { status: 'abstain', reason: 'invalid-request' });
    assert.deepEqual(answers.zero, { status: 'abstain', reason: 'invalid-request' });
    assert.deepEqual(answers.big, { status: 'abstain', reason: 'invalid-request' });
    assert.equal(answers.kept.status, 'ok');
    assert.equal(h.calls.length, 1);
    assert.deepEqual(optionsOf(h.calls[0]).map((o) => o.key), ['level_2', '01', '1.5', '-1'], 'author order is preserved');
  });

  test('IN-03: a bad key wins over the option count, matching the documented precedence', async () => {
    const criteria = { ...criteriaOf(24), 'bad key': 'x' };
    const { answers, h } = await ask({
      bad: { type: 'choice', instructions: 'Pick.', criteria },
      many: { type: 'choice', instructions: 'Pick.', criteria: criteriaOf(25) },
    });
    assert.deepEqual(answers.bad, { status: 'abstain', reason: 'invalid-request' });
    assert.deepEqual(answers.many, { status: 'abstain', reason: 'too-many-options' });
    assert.equal(h.calls.length, 0);
  });

  test('structural faults throw the TypeError', async () => {
    const proto = JSON.parse('{"state":"s","questions":{"__proto__":{"type":"noul","instructions":"x"}}}');
    const cases = [
      ['null', null],
      ['array', []],
      ['neither', { state: 's' }],
      ['both', { state: 's', questions: { q: choiceQ() }, requests: [] }],
      ['empty questions', { state: 's', questions: {} }],
      ['empty requests', { requests: [] }],
      ['missing state', { questions: { q: choiceQ() } }],
      ['numeric state', { state: 3, questions: { q: choiceQ() } }],
      ['proto question key', proto],
      ['bad question key', { state: 's', questions: { 'a b': choiceQ() } }],
      ['duplicate ids', { requests: [
        { id: 'x', state: 's', questions: { q: choiceQ() } },
        { id: 'x', state: 's', questions: { q: choiceQ() } },
      ] }],
      ['reserved id', { requests: [{ id: 'constructor', state: 's', questions: { q: choiceQ() } }] }],
      ['default id in batch', { requests: [{ id: 'default', state: 's', questions: { q: choiceQ() } }] }],
      ['bad id', { requests: [{ id: 'a/b', state: 's', questions: { q: choiceQ() } }] }],
    ];
    for (const [label, request] of cases) {
      await assert.rejects(
        () => mod.decide(request, { config: cfg(), http: fakeHttp(pickByKey(() => 'a')).http }),
        (e) => e instanceof TypeError && e.message.startsWith('decision-model: invalid request:'),
        label,
      );
    }
  });

  test('more than 256 questions in total is a structural fault', () => {
    const questions = {};
    for (let i = 0; i < 257; i += 1) questions[`q${i}`] = choiceQ();
    assert.equal(mod.validateRequest(req(questions)).ok, false);
  });

  test('an empty-string state is accepted and sent unchanged', async () => {
    const { h } = await ask({ q: choiceQ() }, { state: '' });
    assert.equal(h.calls.length, 1);
    const sent = JSON.parse(h.calls[0].body.messages[1].content);
    assert.equal(sent.state, '');
  });

  test('state is sent as JSON text and is never trimmed', async () => {
    const state = '  padded \n state with "quotes" and ünïcode  ';
    const { h } = await ask({ q: choiceQ() }, { state });
    assert.equal(JSON.parse(h.calls[0].body.messages[1].content).state, state);
    assert.equal(h.calls[0].body.messages[0].content, mod.SYSTEM_PROMPT);
    assert.ok(!h.calls[0].body.messages[0].content.includes('padded'));
  });

  test('FIDELITY: the user message is byte-identical to the eval protocol (Python json.dumps, ensure_ascii=False)', async () => {
    // Expected bytes generated once with Python 3 from the same request, exactly as
    // eval2/lib.py decide() builds the message:
    //   json.dumps({"state": state, "question": q, "options": options}, ensure_ascii=False)
    // (separators ", " and ": ", key order as constructed, non-ASCII kept, control
    // characters escaped, floats in Python repr form).
    const REQUEST_TEXT = "{\"state\": {\"title\": \"Caf\u00e9 \u4e2d\u6587 \ud83d\ude80 says \\\"hi\\\"\", \"body\": \"line1\\nline2\\ttab \\\\ back/slash \\u0001 \\u007f \u2028 end\", \"n\": [1, -3, 0, 0.5, 1e-7, 1.5e300, 123456.789, 0.0001, 12345678901234.5], \"flags\": {\"ok\": true, \"no\": false, \"none\": null}, \"empty\": {\"a\": [], \"b\": {}}}, \"questions\": {\"q\": {\"type\": \"choice\", \"instructions\": \"Which \u00e9tat applies?\\nPick one.\", \"criteria\": {\"alpha\": \"First \\\"quoted\\\" option\", \"beta_2\": \"Second, with \u00fcml\u00e4ut\", \"gamma.x\": \"Third\\tone\"}}}}";
    const PYTHON_CONTENT = "{\"state\": {\"title\": \"Caf\u00e9 \u4e2d\u6587 \ud83d\ude80 says \\\"hi\\\"\", \"body\": \"line1\\nline2\\ttab \\\\ back/slash \\u0001 \u007f \u2028 end\", \"n\": [1, -3, 0, 0.5, 1e-07, 1.5e+300, 123456.789, 0.0001, 12345678901234.5], \"flags\": {\"ok\": true, \"no\": false, \"none\": null}, \"empty\": {\"a\": [], \"b\": {}}}, \"question\": \"Which \u00e9tat applies?\\nPick one.\", \"options\": [{\"label\": \"A\", \"key\": \"alpha\", \"description\": \"First \\\"quoted\\\" option\"}, {\"label\": \"B\", \"key\": \"beta_2\", \"description\": \"Second, with \u00fcml\u00e4ut\"}, {\"label\": \"C\", \"key\": \"gamma.x\", \"description\": \"Third\\tone\"}]}";
    const request = JSON.parse(REQUEST_TEXT);
    const h = fakeHttp(pickByKey(() => 'alpha'));
    await mod.decide(request, { config: cfg(), http: h.http });
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0].body.messages[1].content, PYTHON_CONTENT);
  });

  test('results come back in request order and the single form is id default', async () => {
    const h = fakeHttp(pickByKey(() => 'a'));
    const r = await mod.decide(
      { requests: [
        { id: 'b', state: 's', questions: { z: choiceQ(), y: choiceQ() } },
        { id: 'a', state: 's', questions: { q: choiceQ() } },
      ] },
      { config: cfg(), http: h.http },
    );
    assert.deepEqual(r.results.map((x) => x.id), ['b', 'a']);
    assert.deepEqual(Object.keys(r.results[0].answers), ['z', 'y']);
    const single = await mod.decide(req({ q: choiceQ() }), { config: cfg(), http: fakeHttp(pickByKey(() => 'a')).http });
    assert.equal(single.results[0].id, 'default');
  });

  test('a probability tie keeps the letter the model emitted', async () => {
    const { answers } = await ask({ q: choiceQ(['a', 'b']) }, {
      config: cfg({ min_confidence: 0.4 }),
      handler: () => ({
        ok: true,
        status: 200,
        body: completion('B', [{ token: 'A', logprob: -0.5 }, { token: 'B', logprob: -0.5 }]),
      }),
    });
    assert.equal(answers.q.choice, 'b');
    assert.equal(answers.q.confidence, 0.5);
  });

  test('whitespace-padded top_logprobs tokens match their letter', async () => {
    const { answers } = await ask({ q: choiceQ(['a', 'b']) }, {
      handler: () => ({
        ok: true,
        status: 200,
        body: completion('A', [{ token: ' A', logprob: -0.01 }, { token: '\nB', logprob: -6 }]),
      }),
    });
    assert.equal(answers.q.status, 'ok');
    assert.equal(answers.q.probabilities.b > 0, true);
  });

  test('WR-04: a lone letter in top_logprobs is not inflated to confidence 1; it abstains below the floor', async () => {
    const lp = (p) => Math.log(p);
    const cases = [
      // Only the emitted letter is listed: the other letter gets the same upper bound, so 1/n.
      [[{ token: 'A', logprob: lp(0.3) }], 0.5],
      // The reviewer's case: A at 0.30, the rest of the mass on non-letters; B is bounded by the smallest listed (0.1).
      [[{ token: 'A', logprob: lp(0.3) }, { token: 'The', logprob: lp(0.4) }, { token: 'a', logprob: lp(0.2) }, { token: 'b', logprob: lp(0.1) }], 0.75],
    ];
    for (const [top, conf] of cases) {
      const { answers } = await ask({ q: choiceQ(['a', 'b']) }, { handler: () => ({ ok: true, status: 200, body: completion('A', top) }) });
      assert.deepEqual(answers.q, { status: 'abstain', reason: 'low-confidence', confidence: conf, below_floor_choice: 'a' }, JSON.stringify(top));
    }
  });

  test('WR-04: an absent alternative in a full 20-entry list is bounded by a tiny probability and stays confident', async () => {
    const top = [{ token: 'A', logprob: Math.log(0.97) }];
    for (let i = 0; i < 19; i += 1) top.push({ token: `junk${i}`, logprob: Math.log(1e-3) });
    const { answers } = await ask({ q: choiceQ(['a', 'b']) }, { handler: () => ({ ok: true, status: 200, body: completion('A', top) }) });
    assert.equal(answers.q.status, 'ok');
    // 0.97 / (0.97 + 0.001), rounded to 4 places.
    assert.equal(answers.q.confidence, 0.999);
    assert.equal(answers.q.probabilities.b, 0.001, 'the absent letter gets its upper bound, not 0');
  });

  test('D22 (WR-04 residual): an emitted letter absent from its own top_logprobs is invalid-output, even at a 0.5 floor', async () => {
    // The re-review repro: the list says A is likelier than B, yet the content is B.
    // Bounding B by the smallest listed entry used to give confidence 0.5, which passed a 0.5 floor.
    const top = [{ token: 'The', logprob: -0.1 }, { token: 'A', logprob: -2 }];
    const { answers } = await ask({ q: choiceQ(['x', 'y'], { min_confidence: 0.5 }) }, { handler: () => ({ ok: true, status: 200, body: completion('B', top) }) });
    assert.deepEqual(answers.q, { status: 'abstain', reason: 'invalid-output' });
    // Padded tokens still count as the emitted letter being listed.
    const listed = await ask({ q: choiceQ(['x', 'y'], { min_confidence: 0.5 }) }, {
      handler: () => ({ ok: true, status: 200, body: completion('B', [{ token: ' B', logprob: Math.log(0.9) }, { token: 'A', logprob: Math.log(0.1) }]) }),
    });
    assert.equal(listed.answers.q.status, 'ok');
    assert.equal(listed.answers.q.choice, 'y');
  });

  test('WR-05: leading whitespace tokens are skipped; the letter token supplies the probabilities', async () => {
    const lp = (p) => Math.log(p);
    const { answers } = await ask({ q: choiceQ(['a', 'b']) }, {
      handler: () => ({
        ok: true,
        status: 200,
        body: multiToken('\nB', [
          { token: '\n', top: [{ token: 'A', logprob: lp(0.92) }, { token: 'B', logprob: lp(0.08) }] },
          { token: 'B', top: [{ token: 'B', logprob: lp(0.97) }, { token: 'A', logprob: lp(0.03) }] },
        ]),
      }),
    });
    assert.deepEqual(answers.q, { status: 'ok', choice: 'b', confidence: 0.97, probabilities: { a: 0.03, b: 0.97 } });
  });

  test('WR-05: a letter token that does not match the emitted content is invalid-output', async () => {
    const top = [{ token: 'A', logprob: -0.01 }, { token: 'B', logprob: -5 }];
    for (const body of [
      multiToken('B', [{ token: 'A', top }]),
      multiToken('A', [{ token: ' ', top }, { token: '  ', top }]),
      multiToken('A', [{ top }]),
    ]) {
      const { answers } = await ask({ q: choiceQ(['a', 'b']) }, { handler: () => ({ ok: true, status: 200, body }) });
      assert.deepEqual(answers.q, { status: 'abstain', reason: 'invalid-output' }, JSON.stringify(body).slice(0, 120));
    }
  });

  test('empty content, finish_reason length, and empty or absent top_logprobs are invalid-output', async () => {
    const top = [{ token: 'A', logprob: -0.01 }, { token: 'B', logprob: -5 }];
    const bodies = [
      completion('', top),
      completion('A', top, { finish_reason: 'length' }),
      completion('A', []),
      { choices: [{ message: { content: 'A' }, finish_reason: 'stop' }] },
      completion('Z', top),
      { choices: [] },
      '<<not json>>',
    ];
    for (const body of bodies) {
      const { answers } = await ask({ q: choiceQ(['a', 'b']) }, { handler: () => ({ ok: true, status: 200, body }) });
      assert.deepEqual(answers.q, { status: 'abstain', reason: 'invalid-output' }, JSON.stringify(body).slice(0, 60));
    }
  });

  test('HTTP failures classify: 500 context overflow, 404 model, other non-2xx unreachable', async () => {
    const cases = [
      [{ ok: false, status: 500, body: '{"error":{"type":"exceed_context_size_error"}}' }, 'context-exceeded'],
      [{ ok: false, status: 400, body: 'This model\'s maximum context length is 4096 tokens' }, 'context-exceeded'],
      [{ ok: false, status: 404, body: '{}' }, 'model-missing'],
      [{ ok: false, status: 400, body: '{"error":{"code":"model_not_found"}}' }, 'model-missing'],
      [{ ok: false, status: 503, body: 'busy' }, 'unreachable'],
    ];
    for (const [result, reason] of cases) {
      const { answers } = await ask({ q: choiceQ() }, { handler: () => result });
      assert.equal(answers.q.reason, reason, JSON.stringify(result));
    }
  });

  test('an empty or whitespace-only model abstains model-missing with zero calls', async () => {
    for (const model of ['', '   ']) {
      const { answers, h } = await ask({ q: choiceQ() }, { config: cfg({ model }) });
      assert.deepEqual(answers.q, { status: 'abstain', reason: 'model-missing' });
      assert.equal(h.calls.length, 0);
    }
  });

  test('a config min_confidence outside [0, 1] abstains invalid-config with zero calls', async () => {
    for (const v of [1.5, -0.1, 'high']) {
      const { answers, h } = await ask({ q: choiceQ() }, { config: cfg({ min_confidence: v }) });
      assert.deepEqual(answers.q, { status: 'abstain', reason: 'invalid-config' }, String(v));
      assert.equal(h.calls.length, 0);
    }
  });

  test('a rounded confidence equal to the floor is ok; one 0.0001 below abstains', async () => {
    const atFloor = await ask({ q: choiceQ(['a', 'b']) }, { handler: twoWay('A', 0.9) });
    assert.equal(atFloor.answers.q.status, 'ok');
    assert.equal(atFloor.answers.q.confidence, 0.9);
    const below = await ask({ q: choiceQ(['a', 'b']) }, { handler: twoWay('A', 0.8999) });
    assert.equal(below.answers.q.reason, 'low-confidence');
    assert.equal(below.answers.q.confidence, 0.8999);
  });

  test('capability-off wins over every other fault and sends nothing', async () => {
    const { answers, h } = await ask(
      { q: choiceQ(), bad: { type: 'choice' } },
      { config: { enabled: false, model: '', base_url: 'nope', min_confidence: 9 } },
    );
    assert.deepEqual(answers.q, { status: 'abstain', reason: 'capability-off' });
    assert.deepEqual(answers.bad, { status: 'abstain', reason: 'capability-off' });
    assert.equal(h.calls.length, 0);
  });

  test('a score question reports the probability-weighted level index', async () => {
    const { answers } = await ask({
      s: { type: 'score', instructions: 'Rate.', criteria: { low: 'l', mid: 'm', high: 'h' } },
    }, {
      config: cfg({ min_confidence: 0.3 }),
      handler: () => ({
        ok: true,
        status: 200,
        body: completion('C', [
          { token: 'C', logprob: Math.log(0.5) },
          { token: 'B', logprob: Math.log(0.3) },
          { token: 'A', logprob: Math.log(0.2) },
        ]),
      }),
    });
    assert.equal(answers.s.choice, 'high');
    assert.equal(answers.s.score, 1.3);
  });
});

describe('properties', () => {
  test('letterProbabilities: every p in [0,1], all labels sum to 1, an absent label gets the smallest listed probability', () => {
    const arb = fc.integer({ min: 2, max: 24 }).chain((n) => fc.array(
      fc.option(fc.double({ min: -30, max: 0, noNaN: true }), { nil: null }),
      { minLength: n, maxLength: n },
    ).map((lps) => ({ n, lps })));
    fc.assert(fc.property(arb, ({ n, lps }) => {
      const labels = LETTERS.slice(0, n).split('');
      const top = [];
      lps.forEach((lp, i) => { if (lp !== null) top.push({ token: labels[i], logprob: lp }); });
      const p = mod.letterProbabilities(top, labels);
      assert.equal(Object.keys(p).length, n);
      let sum = 0;
      const present = [];
      lps.forEach((lp, i) => {
        const v = p[labels[i]];
        assert.ok(v >= 0 && v <= 1, `p ${v}`);
        sum += v;
        if (lp !== null) present.push(v);
      });
      if (top.length === 0) {
        assert.equal(sum, 0, 'no listed letter: every label is 0');
        return;
      }
      assert.ok(Math.abs(sum - 1) < 1e-9, `sum ${sum}`);
      // An absent letter did not make the top-k list, so its bound is the smallest listed probability.
      const smallest = Math.min(...present);
      lps.forEach((lp, i) => { if (lp === null) assert.ok(Math.abs(p[labels[i]] - smallest) < 1e-12, `absent ${labels[i]}`); });
    }));
  });

  test('openai-letter score lies in [0, n-1]', async () => {
    const arb = fc.integer({ min: 2, max: 24 }).chain((n) => fc.array(
      fc.double({ min: -30, max: 0, noNaN: true }),
      { minLength: n, maxLength: n },
    ).map((lps) => ({ n, lps })));
    await fc.assert(fc.asyncProperty(arb, async ({ n, lps }) => {
      let best = 0;
      lps.forEach((lp, i) => { if (lp > lps[best]) best = i; });
      const h = fakeHttp(() => ({
        ok: true,
        status: 200,
        body: completion(LETTERS[best], lps.map((lp, i) => ({ token: LETTERS[i], logprob: lp }))),
      }));
      const r = await mod.decide(
        req({ s: { type: 'score', instructions: 'Rate.', criteria: criteriaOf(n) } }),
        { config: cfg({ min_confidence: 0 }), http: h.http },
      );
      const a = r.results[0].answers.s;
      assert.equal(a.status, 'ok');
      assert.ok(a.score >= 0 && a.score <= n - 1, `score ${a.score} for n=${n}`);
    }));
  });

  test('letter assignment is a bijection in forward and reversed presentation', async () => {
    await fc.assert(fc.asyncProperty(fc.integer({ min: 2, max: 24 }), async (n) => {
      const keys = Object.keys(criteriaOf(n));
      const h = fakeHttp(pickByKey(() => 'k0'));
      await mod.decide(
        req({ q: { type: 'choice', instructions: 'Pick.', criteria: criteriaOf(n), order_check: true } }),
        { config: cfg(), http: h.http },
      );
      assert.equal(h.calls.length, 2);
      const labels = LETTERS.slice(0, n).split('');
      const forward = optionsOf(h.calls[0]);
      const reversed = optionsOf(h.calls[1]);
      assert.deepEqual(forward.map((o) => o.label), labels);
      assert.deepEqual(reversed.map((o) => o.label), labels);
      assert.deepEqual(forward.map((o) => o.key), keys);
      assert.deepEqual(reversed.map((o) => o.key), [...keys].reverse());
      assert.equal(new Set(reversed.map((o) => o.key)).size, n);
    }));
  });
});

describe('D24 items mode engine (decideItemsSync)', () => {
  const NOUL2 = { a: { type: 'noul', instructions: 'A?' }, b: { type: 'noul', instructions: 'B?' } };

  /** A _spawn stand-in that answers every question of every request yes and records each payload. */
  function recordingSpawn() {
    const payloads = [];
    const spawn = (cmd, args, opts) => {
      const payload = JSON.parse(opts.input);
      payloads.push({ payload, timeout: opts.timeout });
      const results = payload.request.requests.map((r) => ({
        id: r.id,
        answers: Object.fromEntries(Object.keys(r.questions).map((k) => [k, { status: 'ok', answer: 'yes', p_yes: 0.95, confidence: 0.95 }])),
      }));
      return { status: 0, stdout: JSON.stringify({ response: { backend: 'openai-letter', model: 'm', endpoint_host: 'x', min_confidence: 0.9, results }, diagnostics: [] }) };
    };
    return { spawn, payloads };
  }

  test('130 items of 2 questions go out as chunks of 240 and 20 questions and merge back in item order', (t) => {
    const { project } = syncProject(t, { log_path: '' });
    const items = Array.from({ length: 130 }, (_, k) => ({ id: `i${k + 1}`, state: `state ${k + 1}` }));
    const rec = recordingSpawn();
    const r = mod.decideItemsSync(NOUL2, items, { cwd: project, _spawn: rec.spawn });
    assert.deepEqual(rec.payloads.map((p) => p.payload.request.requests.length), [120, 10]);
    assert.deepEqual(rec.payloads.map((p) => p.payload.request.requests.reduce((n, x) => n + Object.keys(x.questions).length, 0)), [240, 20]);
    assert.deepEqual(r.results.map((x) => x.id), items.map((x) => x.id));
    assert.deepEqual(rec.payloads.flatMap((p) => p.payload.request.requests.map((x) => x.state)), items.map((x) => x.state));
    assert.ok(r.results.every((x) => x.answers.a.status === 'ok' && x.answers.b.status === 'ok'));
  });

  test('an unread item keeps its reason, after the capability gate, and carries its hashes', (t) => {
    const { project } = syncProject(t, { log_path: '' });
    const rec = recordingSpawn();
    const items = [
      { id: 'big', reason: 'context-exceeded', path_sha256: 'p'.repeat(64) },
      { id: 'ok', state: 's', sha256: 'c'.repeat(64), path_sha256: 'd'.repeat(64) },
      { id: 'out', reason: 'invalid-request' },
    ];
    const r = mod.decideItemsSync(NOUL2, items, { cwd: project, _spawn: rec.spawn });
    assert.equal(rec.payloads.length, 1);
    assert.deepEqual(rec.payloads[0].payload.request.requests.map((x) => x.id), ['ok']);
    assert.deepEqual(r.results[0], { id: 'big', answers: { a: { status: 'abstain', reason: 'context-exceeded' }, b: { status: 'abstain', reason: 'context-exceeded' } }, path_sha256: 'p'.repeat(64) });
    assert.equal(r.results[1].sha256, 'c'.repeat(64));
    assert.equal(r.results[2].answers.a.reason, 'invalid-request');

    const off = scopes(t, { enabled: false, model: 'm' });
    const r2 = mod.decideItemsSync(NOUL2, items, { cwd: off, _spawn: rec.spawn });
    assert.ok(r2.results.every((x) => x.answers.a.reason === 'capability-off'), 'capability-off comes first');
    assert.equal(rec.payloads.length, 1, 'no child when the capability is off');
  });

  test('the overall budget is shared across chunks: each child gets what is left, and a spent budget starts no child', (t) => {
    const { project } = syncProject(t, { log_path: '', timeout_ms: 30000 });
    const items = Array.from({ length: 600 }, (_, k) => ({ id: `i${k + 1}`, state: 's' }));
    const rec = recordingSpawn();
    let clock = 0;
    const spawn = (cmd, args, opts) => { const out = rec.spawn(cmd, args, opts); clock += 4000; return out; };
    const r = mod.decideItemsSync({ a: NOUL2.a }, items, { cwd: project, budgetMs: 6000, _spawn: spawn, now: () => clock });
    assert.equal(rec.payloads.length, 2, 'the third chunk found the budget spent');
    assert.deepEqual(rec.payloads.map((p) => p.payload.budget_ms), [6000, 2000]);
    assert.deepEqual(rec.payloads.map((p) => p.timeout), [11000, 7000], 'the kill follows the budget by the 5 s margin');
    assert.ok(r.results.slice(0, 480).every((x) => x.answers.a.status === 'ok'));
    assert.ok(r.results.slice(480).every((x) => x.answers.a.reason === 'timeout'));
    assert.equal(r.results.length, 600);
  });

  test('structural faults throw: more than 240 questions per item, a bad or duplicate id, an empty list', (t) => {
    const { project } = syncProject(t, { log_path: '' });
    const many = Object.fromEntries(Array.from({ length: 241 }, (_, k) => [`q${k}`, NOUL2.a]));
    for (const [qs, items] of [
      [many, [{ id: 'a', state: 's' }]],
      [NOUL2, [{ id: 'a', state: 's' }, { id: 'a', state: 's' }]],
      [NOUL2, [{ id: 'default', state: 's' }]],
      [NOUL2, [{ id: 'a' }]],
      [NOUL2, []],
    ]) {
      assert.throws(() => mod.decideItemsSync(qs, items, { cwd: project, _spawn: () => { throw new Error('no spawn'); } }), /invalid request/);
    }
  });

  test('validateItemsList accepts id, state_file and sha256 only', () => {
    assert.deepEqual(mod.validateItemsList([{ id: 'a', state_file: 'x.md', sha256: true }, { id: 'b', state_file: '/t/y' }]),
      { ok: true, items: [{ id: 'a', state_file: 'x.md', sha256: true }, { id: 'b', state_file: '/t/y', sha256: false }] });
    for (const bad of [[], {}, [{ id: 'a' }], [{ id: 'a', state_file: '' }], [{ id: 'a b', state_file: 'x' }], [{ id: '__proto__', state_file: 'x' }],
      [{ id: 'a', state_file: 'x', sha256: 'yes' }], [{ id: 'a', state_file: 'x', state: 'inline' }]]) {
      assert.equal(mod.validateItemsList(bad).ok, false, JSON.stringify(bad));
    }
  });

  test('a fractional deadline still gives every clipped call a whole-millisecond timeout (AbortSignal.timeout needs an integer)', async () => {
    const calls = [];
    const http = async (url, opts) => { calls.push(opts.timeoutMs); return { ok: false, status: 0, body: '', timedOut: true }; };
    await mod.decide({ state: 's', questions: { a: NOUL2.a } }, { config: cfg({ timeout_ms: 30000 }), http, deadline: 2500.75, now: () => 0.5 });
    assert.equal(calls.length, 1);
    assert.ok(Number.isInteger(calls[0]), `timeout ${calls[0]}`);
    assert.equal(calls[0], 2500);
  });
});
