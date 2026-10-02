'use strict';
// Violation: the request state is cut to 1000 characters to fit a context limit before it is sent.
const real = require('../../../../gsd-core/bin/lib/decision-model.cjs');

function trim(state) {
  return typeof state === 'string' ? state.slice(0, 1000) : state;
}

module.exports = {
  ...real,
  decide: (request, deps) => {
    const requests = request.requests
      ? request.requests.map((r) => ({ ...r, state: trim(r.state) }))
      : undefined;
    const trimmed = requests ? { ...request, requests } : { ...request, state: trim(request.state) };
    return real.decide(trimmed, deps);
  },
};
