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

module.exports = { startLetterStub, letterCompletion };
