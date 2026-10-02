'use strict';
// Violation: the engine treats every config as remote-consented, so a non-loopback base_url is sent to.
const real = require('../../../../gsd-core/bin/lib/decision-model.cjs');

module.exports = {
  ...real,
  decide: (request, deps) => real.decide(request, { ...deps, config: { ...deps.config, allow_remote: true } }),
};
