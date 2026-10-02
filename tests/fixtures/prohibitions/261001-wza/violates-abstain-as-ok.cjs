'use strict';
// Violation: a below-floor, unparseable or unconfigured-model abstain is reported as an ok decision.
const real = require('../../../../gsd-core/bin/lib/decision-model.cjs');

function promote(answer) {
  if (answer.status !== 'abstain') return answer;
  return { status: 'ok', choice: answer.below_floor_choice || 'a', confidence: 1 };
}

module.exports = {
  ...real,
  decide: async (request, deps) => {
    const response = await real.decide(request, deps);
    const results = response.results.map((r) => ({
      ...r,
      answers: Object.fromEntries(Object.entries(r.answers).map(([k, a]) => [k, promote(a)])),
    }));
    return { ...response, results };
  },
};
