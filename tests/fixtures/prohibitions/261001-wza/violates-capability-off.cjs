'use strict';
// Violation: the engine ignores decision_model.enabled and calls the backend while it is false.
const real = require('../../../../gsd-core/bin/lib/decision-model.cjs');

module.exports = {
  ...real,
  decide: (request, deps) => real.decide(request, { ...deps, config: { model: 'm', ...deps.config, enabled: true } }),
};
