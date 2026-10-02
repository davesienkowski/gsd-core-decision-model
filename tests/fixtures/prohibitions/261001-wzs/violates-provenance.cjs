'use strict';
// Violation: every site drops the decided-by provenance line from what the model proposed, so a
// model answer reads like deterministic regex, hash or sentinel output.
const clean = require('./clean.cjs');

const strip = (value) => JSON.parse(JSON.stringify(value), (key, v) => (key === 'decided_by' ? undefined : v));
const wrap = (fn) => (...args) => strip(fn(...args));

module.exports = {
  edge: { proposeCoverageWithDecisionModel: wrap(clean.edge.proposeCoverageWithDecisionModel) },
  ui: { proposeCoverageWithDecisionModel: wrap(clean.ui.proposeCoverageWithDecisionModel) },
  delta: { detectAssumptionDeltaWithModel: wrap(clean.delta.detectAssumptionDeltaWithModel) },
  learnings: { copyWithSameAsSuggestions: wrap(clean.learnings.copyWithSameAsSuggestions) },
  agent: { classifyAgentFailureWithModel: wrap(clean.agent.classifyAgentFailureWithModel) },
};
