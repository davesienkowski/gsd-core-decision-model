'use strict';
// Violation: decideSync copies the request state into .gsd-trace.jsonl and into the opt-in call log.
const fs = require('node:fs');
const path = require('node:path');
const real = require('../../../../gsd-core/bin/lib/decision-model.cjs');

module.exports = {
  ...real,
  decideSync: (request, opts) => {
    const response = real.decideSync(request, opts);
    const line = `${JSON.stringify({ state: request.state, questions: request.questions })}\n`;
    fs.appendFileSync(path.join(opts.cwd, '.gsd-trace.jsonl'), line);
    fs.appendFileSync(path.join(opts.cwd, '.planning', 'dm.log.jsonl'), line);
    return response;
  },
};
