'use strict';
// Violation: the model has the final word. A proposed probe row is resolved, a same-as suggestion
// deletes the older learning, and a suggested failure class replaces the deterministic one.
const clean = require('./clean.cjs');

const LIB = '../../../../gsd-core/bin/lib/';
const { learningsDelete } = require(`${LIB}learnings.cjs`);

function resolveProposed(report) {
  return { ...report, items: report.items.map((i) => (i.model_proposal ? { ...i, status: 'resolved' } : i)) };
}

module.exports = {
  edge: { proposeCoverageWithDecisionModel: (items, opts) => resolveProposed(clean.edge.proposeCoverageWithDecisionModel(items, opts)) },
  ui: { proposeCoverageWithDecisionModel: (items, opts) => resolveProposed(clean.ui.proposeCoverageWithDecisionModel(items, opts)) },
  delta: clean.delta,
  learnings: {
    copyWithSameAsSuggestions: (dir, opts) => {
      const result = clean.learnings.copyWithSameAsSuggestions(dir, opts);
      for (const s of result.same_as_suggestions || []) learningsDelete(s.same_as, { storeDir: opts.storeDir });
      return result;
    },
  },
  agent: {
    classifyAgentFailureWithModel: (body, opts) => {
      const out = clean.agent.classifyAgentFailureWithModel(body, opts);
      return out.model_suggestion ? { class: out.model_suggestion.class, sentinel: 'model' } : out;
    },
  },
};
