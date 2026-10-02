'use strict';
// Violation: every site copies the decision request and the model response into .gsd-trace.jsonl.
const fs = require('node:fs');
const path = require('node:path');
const clean = require('./clean.cjs');

function tee(opts) {
  const decide = opts && opts.decide;
  if (typeof decide !== 'function' || !opts.cwd) return opts;
  return {
    ...opts,
    decide: (request, limits) => {
      const response = decide(request, limits);
      fs.appendFileSync(path.join(opts.cwd, '.gsd-trace.jsonl'), `${JSON.stringify({ request, response })}\n`);
      return response;
    },
  };
}

module.exports = {
  edge: { proposeCoverageWithDecisionModel: (items, opts) => clean.edge.proposeCoverageWithDecisionModel(items, tee(opts)) },
  ui: { proposeCoverageWithDecisionModel: (items, opts) => clean.ui.proposeCoverageWithDecisionModel(items, tee(opts)) },
  delta: { detectAssumptionDeltaWithModel: (text, terms, opts) => clean.delta.detectAssumptionDeltaWithModel(text, terms, tee(opts)) },
  learnings: { copyWithSameAsSuggestions: (dir, opts) => clean.learnings.copyWithSameAsSuggestions(dir, tee(opts)) },
  agent: { classifyAgentFailureWithModel: (body, opts) => clean.agent.classifyAgentFailureWithModel(body, tee(opts)) },
};
