/**
 * Agent command router — classify-failure subcommand handler.
 *
 * ADR-457 build-at-publish: the hand-written bin/lib/agent-command-router.cjs
 * collapsed to a TypeScript source of truth. Behaviour is preserved byte-for-behaviour
 * from the prior hand-written .cjs; only types are added.
 *
 * Decision-model fallthrough (quick 261001-wzs, D11 site #14): `classifyAgentFailure` stays the pure
 * deterministic classifier. `classifyAgentFailureWithModel` wraps it and consults the optional
 * decision-model capability ONLY when the base class is `unknown-failure` and the body is
 * non-empty. A sentinel hit never asks the model. The model never changes the class (WR-03, D11,
 * D19): an ok `quota-exceeded` answer (at or above the engine's confidence floor) is attached as
 * `model_suggestion: { class, decided_by }` on the unchanged `unknown-failure` result, so the
 * workflow still takes today's unknown path (report and ask Continue/Stop) and only SHOWS the
 * suggestion with its provenance (D14). A model answer can therefore never trigger the automatic
 * quota recovery or provider-escalation re-dispatch, which key on the class alone.
 */

import {
  type DecideOpts,
  type DecisionQuestion,
  answersFor,
  answerOf,
  okChoice,
  decidedBy,
  resolveSiteDecide,
} from './decision-model-fallthrough.cjs';

// eslint-disable-next-line @typescript-eslint/no-require-imports
import io = require('./io.cjs');
const { output, error, ERROR_REASON } = io;

// ─── Types ────────────────────────────────────────────────────────────────────

type QuotaExceededResult = {
  class: 'quota-exceeded';
  sentinel: string;
  retryAfterSeconds?: number;
};

type ClassifyHandoffBugResult = {
  class: 'classify-handoff-bug';
  sentinel: string;
};

type UnknownFailureResult = {
  class: 'unknown-failure';
  /** WR-03: a decision-model suggestion to SHOW the user; never acted on (the class is unchanged). */
  model_suggestion?: { class: 'quota-exceeded'; decided_by: string };
};

type AgentFailureResult = QuotaExceededResult | ClassifyHandoffBugResult | UnknownFailureResult;

interface RouteAgentCommandOptions {
  args: string[];
  cwd?: string;
  raw: boolean;
}

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * #2296 — The runtime enum of failure classes `classifyAgentFailure` can emit.
 *
 * `AgentFailureResult`'s class strings are TypeScript types, which erase at
 * runtime. Any second surface that needs to validate a class (the
 * `resolve-execution --failure-class` flag) would otherwise have to re-declare
 * the literals, giving two lists that can silently diverge. This frozen enum is
 * the single runtime source both surfaces consume.
 */
const AGENT_FAILURE_CLASSES = Object.freeze({
  QUOTA_EXCEEDED: 'quota-exceeded',
  CLASSIFY_HANDOFF_BUG: 'classify-handoff-bug',
  UNKNOWN_FAILURE: 'unknown-failure',
} as const);

const QUOTA_SENTINELS: string[] = [
  '429',
  'usage_limit_reached',
  'usage limit',
  'rate limit',
  'rate-limited',
  'rate_limit',
  'resource_exhausted',
  'quota',
  'too many requests',
  'exceeded your',
];

const CLASSIFY_HANDOFF_SENTINEL = 'classifyhandoffifneeded is not defined';

// ─── Implementation ───────────────────────────────────────────────────────────

function parseRetryAfter(body: unknown): number | undefined {
  // eslint-disable-next-line @typescript-eslint/no-base-to-string
  const match = String(body ?? '').match(/\bretry[-_ ]after[:\s]+(\d+)\b/i);
  if (!match) return undefined;
  const seconds = Number.parseInt(match[1], 10);
  return Number.isFinite(seconds) ? seconds : undefined;
}

function classifyAgentFailure(body: unknown): AgentFailureResult {
  // eslint-disable-next-line @typescript-eslint/no-base-to-string
  const normalized = String(body ?? '').toLowerCase();
  if (normalized.trim() === '') {
    return { class: AGENT_FAILURE_CLASSES.UNKNOWN_FAILURE };
  }

  for (const sentinel of QUOTA_SENTINELS) {
    if (normalized.includes(sentinel)) {
      const retryAfterSeconds = parseRetryAfter(body);
      return retryAfterSeconds === undefined
        ? { class: AGENT_FAILURE_CLASSES.QUOTA_EXCEEDED, sentinel }
        : { class: AGENT_FAILURE_CLASSES.QUOTA_EXCEEDED, sentinel, retryAfterSeconds };
    }
  }

  if (normalized.includes(CLASSIFY_HANDOFF_SENTINEL)) {
    return {
      class: AGENT_FAILURE_CLASSES.CLASSIFY_HANDOFF_BUG,
      sentinel: CLASSIFY_HANDOFF_SENTINEL,
    };
  }

  return { class: AGENT_FAILURE_CLASSES.UNKNOWN_FAILURE };
}

/**
 * The one fixed choice question for the unknown-failure fallthrough. The instructions are a module
 * constant; the untrusted failure body goes only in the request `state` (ADR-1577).
 */
const FAILURE_QUESTION: Readonly<DecisionQuestion> = Object.freeze({
  type: 'choice' as const,
  instructions: 'Why did this subagent fail, based on its return text? Pick the one option that fits best.',
  criteria: Object.freeze({
    'quota-exceeded': 'the provider refused or stopped the run because of a usage, rate, quota, credit or billing limit, and waiting for a reset is the fix',
    other: 'any other cause, such as a code, test, tool, permission, network, timeout, context-length or logic failure, or a crash',
  }),
});

/**
 * `classifyAgentFailure` plus the optional decision-model fallthrough (D11 site #14, D14, D18).
 * Returns the deterministic result untouched unless it is `unknown-failure` for a non-empty body.
 * Then makes ONE decide call (id f0, state = the full body verbatim). Only an ok `quota-exceeded`
 * answer adds anything: a `model_suggestion` on the still-`unknown-failure` result (WR-03).
 * Abstain, `other`, null or garbage all return the base result.
 */
function classifyAgentFailureWithModel(body: unknown, opts: DecideOpts = {}): AgentFailureResult {
  const base = classifyAgentFailure(body);
  if (base.class !== AGENT_FAILURE_CLASSES.UNKNOWN_FAILURE) return base;
  // eslint-disable-next-line @typescript-eslint/no-base-to-string
  const text = String(body ?? '');
  if (text.trim() === '') return base;
  const decide = resolveSiteDecide(opts);
  if (decide === null) return base;
  const response = decide({ requests: [{ id: 'f0', state: text, questions: { failure: FAILURE_QUESTION } }] });
  const answer = answerOf(answersFor(response, 'f0'), 'failure');
  if (okChoice(answer) !== AGENT_FAILURE_CLASSES.QUOTA_EXCEEDED) return base;
  return {
    class: AGENT_FAILURE_CLASSES.UNKNOWN_FAILURE,
    model_suggestion: { class: AGENT_FAILURE_CLASSES.QUOTA_EXCEEDED, decided_by: decidedBy(answer, response) },
  };
}

function routeAgentCommand({ args, cwd, raw }: RouteAgentCommandOptions): void {
  const subcommand = args[1];
  if (subcommand !== 'classify-failure') {
    error('Unknown agent subcommand. Available: classify-failure', ERROR_REASON.SDK_UNKNOWN_COMMAND);
  }

  const bodyArgs = args.slice(2).filter((arg) => arg !== '--');
  output(classifyAgentFailureWithModel(bodyArgs.join(' '), { cwd: cwd ?? process.cwd() }), raw, undefined);
}

export = {
  AGENT_FAILURE_CLASSES,
  classifyAgentFailure,
  classifyAgentFailureWithModel,
  FAILURE_QUESTION,
  routeAgentCommand,
};
