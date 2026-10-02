'use strict';
// Violation: a site loads the decision engine whether or not the capability is active.
const clean = require('./clean.cjs');

const LIB = '../../../../gsd-core/bin/lib/';

module.exports = {
  ...clean,
  edge: {
    proposeCoverageWithDecisionModel: (items, opts) => {
      require(`${LIB}decision-model.cjs`);
      return clean.edge.proposeCoverageWithDecisionModel(items, opts);
    },
  },
};
