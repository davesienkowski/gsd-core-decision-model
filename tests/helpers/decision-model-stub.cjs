'use strict';
/**
 * A loopback OpenAI-compatible stub for the decision-model `openai-letter` backend
 * (quick 261001-wzs). Site tests use it to drive the REAL path (gsd-tools or a probe CLI,
 * the capability gate, decideSync, the engine child and HTTP) and to count what reached
 * the backend, so a test of "the model path is wired" or "the model is never consulted"
 * can actually fail.
 *
 * `pick(user, hit)` gets the parsed user message `{ state, question, options }` (options are
 * `{ label, key, description }`, noul keys are `yes` / `no`) and the 1-based hit number. It
 * returns:
 *   - an option KEY: the stub answers that option's letter with a confident top_logprobs list;
 *   - null: the stub never answers (a hanging backend);
 *   - { status, body }: a raw reply.
 * An unknown key answers 500.
 */
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');

function letterCompletion(letter, labels) {
  const top = [{ token: letter, logprob: -0.01 }];
  labels.filter((l) => l !== letter).forEach((l, i) => top.push({ token: l, logprob: -6 - i }));
  return {
    choices: [{
      message: { content: letter },
      finish_reason: 'stop',
      logprobs: { content: [{ token: letter, top_logprobs: top }] },
    }],
  };
}

/** Start the stub on 127.0.0.1:0. Resolves `{ url, hits, users, close }`. */
async function startLetterStub(pick) {
  const users = [];
  let hits = 0;
  const server = http.createServer((req, res) => {
    hits += 1;
    const hit = hits;
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let user = null;
      try {
        user = JSON.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')).messages[1].content);
      } catch { user = null; }
      users.push(user);
      const out = user === null ? { status: 400, body: 'bad request' } : pick(user, hit);
      if (out === null) return;
      if (typeof out === 'object') {
        res.writeHead(out.status, { 'content-type': 'application/json' });
        res.end(typeof out.body === 'string' ? out.body : JSON.stringify(out.body));
        return;
      }
      const option = user.options.find((o) => o.key === out);
      if (option === undefined) { res.writeHead(500); res.end('unknown option key'); return; }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(letterCompletion(option.label, user.options.map((o) => o.label))));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    get hits() { return hits; },
    users,
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/**
 * A temp project (with `.planning/config.json` = `config`) and a temp HOME / GSD_HOME. `files`
 * maps project-relative paths to text. Returns `{ dir, home, env, cleanup }`.
 */
function makeDecisionProject(config, files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-dm-site-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-dm-site-home-'));
  fs.mkdirSync(path.join(dir, '.planning'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.planning', 'config.json'), JSON.stringify(config));
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  const env = { ...process.env, HOME: home, USERPROFILE: home, GSD_HOME: home };
  for (const k of ['GSD_WORKSTREAM', 'GSD_PROJECT', 'GSD_SESSION_KEY', 'GSD_DECISION_MODEL_SITE_BUDGET_MS']) delete env[k];
  const cleanup = () => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  };
  return { dir, home, env, cleanup };
}

/**
 * Run `node <argv...>` WITHOUT blocking this process's event loop (the stub answers from it).
 * Resolves `{ code, signal, stdout, stderr }`. `input` is written to stdin when given.
 */
function runNodeAsync(argv, { cwd, env, timeout, input }) {
  return new Promise((resolve) => {
    const child = execFile(process.execPath, argv, { cwd, env, timeout, killSignal: 'SIGKILL', encoding: 'utf8' },
      (err, stdout, stderr) => resolve({
        code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
        signal: err ? err.signal : null,
        stdout,
        stderr,
      }));
    child.stdin.end(input === undefined ? '' : input);
  });
}

/** Every file under `root`, as sorted root-relative POSIX paths. */
function listFiles(root) {
  const out = [];
  const walk = (rel) => {
    for (const entry of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
      const next = rel === '' ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(next); else out.push(next);
    }
  };
  walk('');
  return out.sort();
}

module.exports = { startLetterStub, letterCompletion, makeDecisionProject, runNodeAsync, listFiles };
