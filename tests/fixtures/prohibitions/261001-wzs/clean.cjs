'use strict';
// Clean subject for tests/decision-model-fallthrough.prohibitions.test.cjs: the five shipped code
// sites, unchanged, grouped by the entry point each one exposes.
const LIB = '../../../../gsd-core/bin/lib/';

module.exports = {
  edge: require(`${LIB}edge-probe.cjs`),
  ui: require(`${LIB}ui-consideration-probe.cjs`),
  delta: require(`${LIB}assumption-delta.cjs`),
  learnings: require(`${LIB}learnings.cjs`),
  agent: require(`${LIB}agent-command-router.cjs`),
};
