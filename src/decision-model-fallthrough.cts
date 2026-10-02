/**
 * Decision-model fallthrough seam (quick 261001-wzs, chunk C2 of umbrella 261001-o30).
 *
 * The one place the code sites share what they need to consult the optional decision-model
 * capability: the capability id, the gate, the lazy engine load, an own-property-safe answer
 * lookup and the locked decided-by provenance line. The sites themselves (edge probe,
 * UI-consideration probe, assumption-delta, learnings copy, agent classify-failure) keep their
 * deterministic classifiers pure and consult the model only where those fall through (D11).
 *
 * Authored as strict TypeScript and compiled by `tsc -p tsconfig.build.json` to the gitignored
 * runtime artifact `gsd-core/bin/lib/decision-model-fallthrough.cjs` (ADR-457). Do NOT
 * hand-write the `.cjs`; it is emitted.
 *
 * Rules every site follows (D5, D11, D14, D18):
 *  - Abstain is silent fallback: a null, malformed or non-ok answer leaves the site's output
 *    byte-identical to the no-model output. Only a status `ok` answer is ever applied, so the
 *    engine's `min_confidence` floor is the only threshold and no site applies its own.
 *  - Every applied answer carries its `decided-by` line (D14, ADR-1411).
 *  - A site with one fallthrough item makes at most one decide call per run. The probes, which
 *    can have many items, go through {@link decideWithinBudget}: one call per item (so each
 *    item's questions stay together) inside a {@link SITE_WALL_BUDGET_MS} wall budget, so a slow
 *    backend can never hold the probe CLI past the host shell-tool timeout (CR-01).
 *
 * Why a double gate: `decideSync` also applies the capability gate, but `resolveDecide` checks
 * `isCapabilityActive` BEFORE it requires the engine. "Inactive means no engine load, no child
 * process and no network call" is therefore a property of this chunk itself, whatever C1's
 * internals are, and it is testable here. This module has NO top-level require of
 * capability-state, config or the engine, so loading it costs nothing.
 *
 * Trust note (D19, ADR-1577): the request `state` is untrusted text. A model answer is advisory
 * and must never gate a security or destructive action; the sites keep a wrong answer harmless
 * (an annotation a human confirms, an add-only suggestion, a class that is still spot-checked).
 *
 * Nothing here writes a file or touches `.gsd-trace.jsonl` (ADR-2619).
 */

/** The decision-model capability id (`capabilities/decision-model/capability.json`). */
export const DECISION_MODEL_CAPABILITY_ID = 'decision-model';

/**
 * The engine refuses a batch holding more than 256 questions in total (C1 `MAX_QUESTIONS`).
 * Sites cap their batch to this so a large input still gets one valid call instead of a
 * whole-batch refusal that would silently disable the feature.
 */
export const MAX_BATCH_QUESTIONS = 256;

/**
 * CR-01: the whole model pass of one probe run gets this much wall time. The workflows run the
 * probe CLIs through the agent's shell tool (120 s default timeout); the deterministic report must
 * come back well inside that, whatever the backend does.
 */
export const SITE_WALL_BUDGET_MS = 60000;

/**
 * Conservative start estimates, as fractions of the budget so a lowered test budget scales them:
 * at 60 s, 3 s a question (about twice the measured warm p90 of 1.6 s, D19 E7) and 9 s for a cold
 * first call. They only decide whether an item is worth starting; the hard bound is the child kill.
 */
const WARM_QUESTION_SHARE = 1 / 20;
const COLD_START_SHARE = 3 / 20;

/** Abstain reasons that mean the backend will not answer the next item either, so the pass stops. */
const STOP_REASONS: ReadonlySet<string> = new Set([
  'capability-off', 'unreachable', 'model-missing', 'timeout', 'invalid-config', 'egress-not-consented',
]);

/** A D18 question: yes/no (`noul`) or one-of-N (`choice`). Instructions are fixed constants. */
export interface DecisionQuestion {
  type: 'noul' | 'choice';
  instructions: string;
  criteria?: Record<string, string>;
}

/** A D18 batch request. `state` is the only field that carries untrusted prose. */
export interface DecisionBatchRequest {
  requests: Array<{ id: string; state: string; questions: Record<string, DecisionQuestion> }>;
}

/** Optional per-call limits. `timeoutMs` bounds the whole call, engine child included. */
export interface DecideLimits {
  timeoutMs?: number;
}

/** A synchronous decide call: returns a D18 response object, or null when none is available. */
export type DecideFn = (request: DecisionBatchRequest, limits?: DecideLimits) => unknown;

/** The option bag every site entry point takes. */
export interface DecideOpts {
  cwd?: string;
  /** undefined: resolve lazily via `resolveDecide(cwd)`; null: treat as inactive; function: injected. */
  decide?: DecideFn | null;
}

/** The engine's spawn seam (`decideSync`'s `_spawn` option): spawnSync's signature. */
type SpawnFn = (cmd: string, args: string[], options: Record<string, unknown>) => unknown;

interface EngineSyncOpts {
  cwd: string;
  _spawn?: SpawnFn;
}

interface Engine {
  decideSync: (request: unknown, opts: EngineSyncOpts) => unknown;
}

interface ResolveDeps {
  isActive?: (id: string, cwd: string) => boolean;
  loadEngine?: () => Engine;
  /** The spawn under the time-limit clamp (tests); defaults to child_process.spawnSync. */
  spawn?: SpawnFn;
}

const RESERVED_IDS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

function hasOwn(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Resolve a decide function for `cwd`, or null when the capability is not active.
 * The capability gate runs first and the engine is required only afterwards, lazily.
 */
export function resolveDecide(cwd: string, deps: ResolveDeps = {}): DecideFn | null {
  const isActive = deps.isActive ?? ((id: string, dir: string): boolean => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const state = require('./capability-state.cjs') as { isCapabilityActive: (capId: string, dir: string) => boolean };
    return state.isCapabilityActive(id, dir);
  });
  let active = false;
  try {
    active = isActive(DECISION_MODEL_CAPABILITY_ID, cwd) === true;
  } catch {
    active = false;
  }
  if (!active) return null;
  const loadEngine = deps.loadEngine ?? ((): Engine => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('./decision-model.cjs') as Engine;
  });
  return (request: DecisionBatchRequest, limits?: DecideLimits): unknown => {
    try {
      const limit = limits?.timeoutMs;
      const bounded = typeof limit === 'number' && Number.isFinite(limit) && limit > 0;
      return loadEngine().decideSync(request, bounded ? { cwd, _spawn: clampSpawn(limit, deps.spawn) } : { cwd });
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      process.stderr.write(`decision-model: call failed (${message}); continuing without it\n`);
      return null;
    }
  };
}

/**
 * CR-01: a spawn for decideSync's `_spawn` option that kills the engine child once `limitMs` has
 * passed since this call, whatever the engine's own budget (timeout_ms x calls, up to 900 s). The
 * engine treats that kill as a `timeout` abstain. C1 takes no caller deadline, and its child
 * payload is internal, so the spawn timeout is the one engine-side limit a caller can set.
 */
function clampSpawn(limitMs: number, base?: SpawnFn): SpawnFn {
  const deadline = performance.now() + limitMs;
  return (cmd: string, args: string[], options: Record<string, unknown>): unknown => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const spawn = base ?? (require('node:child_process') as { spawnSync: SpawnFn }).spawnSync;
    const own = typeof options['timeout'] === 'number' ? options['timeout'] : limitMs;
    const left = Math.max(1, Math.floor(deadline - performance.now()));
    return spawn(cmd, args, { ...options, windowsHide: true, timeout: Math.min(own, left) });
  };
}

/**
 * The site wall budget. Only under GSD_TEST_MODE may GSD_DECISION_MODEL_SITE_BUDGET_MS lower it
 * (a whole number of ms from 1 to {@link SITE_WALL_BUDGET_MS}); it can never raise it.
 */
export function siteBudgetMs(env: NodeJS.ProcessEnv = process.env): number {
  if (!env['GSD_TEST_MODE']) return SITE_WALL_BUDGET_MS;
  const raw = env['GSD_DECISION_MODEL_SITE_BUDGET_MS'];
  if (typeof raw !== 'string' || !/^[0-9]{1,9}$/.test(raw.trim())) return SITE_WALL_BUDGET_MS;
  const ms = Number(raw.trim());
  return ms >= 1 && ms <= SITE_WALL_BUDGET_MS ? ms : SITE_WALL_BUDGET_MS;
}

/** The outcome of a budgeted pass. `response` merges every item that came back (null for none). */
export interface BudgetedDecision {
  response: { backend?: string; results: Array<{ id: string; answers: Record<string, unknown> }> } | null;
  /** Items sent to decide. */
  asked: number;
  /** True when time ran out: an item did not fit what was left, or a call came back `timeout`. */
  outOfTime: boolean;
}

/**
 * CR-01: run a multi-item batch one item per call, in order, inside the wall budget. Each call
 * gets what is left of the budget as its hard limit. An item starts only when its conservative
 * estimate fits; the pass stops at the first item that does not, at an unusable response, or at an
 * abstain reason that means the backend will not answer the next item either. Items not asked or
 * not answered simply have no entry, so the site leaves them exactly as without the model.
 */
export function decideWithinBudget(
  decide: DecideFn,
  request: DecisionBatchRequest,
  deps: { now?: () => number; budgetMs?: number } = {},
): BudgetedDecision {
  const now = deps.now ?? ((): number => performance.now());
  const budget = deps.budgetMs ?? siteBudgetMs();
  const start = now();
  const results: Array<{ id: string; answers: Record<string, unknown> }> = [];
  let backend: string | undefined;
  let asked = 0;
  let outOfTime = false;
  for (const item of request.requests) {
    const remaining = budget - (now() - start);
    const need = budget * (Object.keys(item.questions).length * WARM_QUESTION_SHARE + (asked === 0 ? COLD_START_SHARE : 0));
    if (remaining < need) { outOfTime = true; break; }
    const response = decide({ requests: [item] }, { timeoutMs: Math.floor(remaining) });
    asked += 1;
    const answers = answersFor(response, item.id);
    if (answers === null) break;
    if (backend === undefined && isRecord(response) && typeof response['backend'] === 'string') backend = response['backend'];
    results.push({ id: item.id, answers });
    const reasons = Object.values(answers).map((a) => (isRecord(a) && a['status'] === 'abstain' ? a['reason'] : undefined));
    if (reasons.includes('timeout')) { outOfTime = true; break; }
    if (reasons.some((r) => typeof r === 'string' && STOP_REASONS.has(r))) break;
  }
  const response = results.length === 0 ? null : { ...(backend === undefined ? {} : { backend }), results };
  return { response, asked, outOfTime };
}

/**
 * CR-01 / IN-04: the one stderr line a probe prints when the budget or its item cap left zero-hit
 * items without a model pass. Stdout (the report) is never touched.
 */
export function noteSkippedItems(proposed: number, total: number): void {
  process.stderr.write(`decision-model: proposed ${proposed} of ${total} zero-hit items within the time budget\n`);
}

/** Resolve the decide function for a site's option bag (see {@link DecideOpts}). */
export function resolveSiteDecide(opts: DecideOpts | undefined): DecideFn | null {
  const o = opts ?? {};
  if (o.decide !== undefined) return o.decide;
  return resolveDecide(o.cwd ?? process.cwd());
}

/**
 * The answers object for request `id`, or null. Own-property lookups only, and the three
 * prototype-pollution ids are rejected, so a hostile response cannot reach inherited members.
 */
export function answersFor(response: unknown, id: string): Record<string, unknown> | null {
  if (typeof id !== 'string' || RESERVED_IDS.has(id)) return null;
  if (!isRecord(response) || !hasOwn(response, 'results')) return null;
  const results = response['results'];
  if (!Array.isArray(results)) return null;
  for (const entry of results as unknown[]) {
    if (!isRecord(entry) || !hasOwn(entry, 'id') || entry['id'] !== id) continue;
    if (!hasOwn(entry, 'answers')) return null;
    const answers = entry['answers'];
    return isRecord(answers) ? answers : null;
  }
  return null;
}

/** Look up one question's answer inside an answers object (own property only). */
export function answerOf(answers: Record<string, unknown> | null, key: string): unknown {
  if (answers === null || RESERVED_IDS.has(key) || !hasOwn(answers, key)) return undefined;
  return answers[key];
}

/** True only for a `noul` answer with status ok and answer yes. */
export function okYes(answer: unknown): boolean {
  return isRecord(answer) && answer['status'] === 'ok' && answer['answer'] === 'yes';
}

/** The chosen option key of a `choice` answer with status ok, else null. */
export function okChoice(answer: unknown): string | null {
  if (!isRecord(answer) || answer['status'] !== 'ok') return null;
  const choice = answer['choice'];
  return typeof choice === 'string' ? choice : null;
}

/**
 * The locked D14 provenance line: `decided-by: decision-model (conf 0.97, backend openai-letter)`.
 * Formatting is delegated to the engine's `formatProvenance` (C1) so the format exists once. A
 * decided-by line is only built for an applied answer, so the engine is already in play then.
 * IN-03: an answer with no finite numeric confidence reads `conf n/a` rather than a made-up 0.00.
 */
export function decidedBy(answer: unknown, response: unknown): string {
  const raw = isRecord(answer) ? answer['confidence'] : undefined;
  const backendRaw = isRecord(response) && typeof response['backend'] === 'string' ? response['backend'] : '';
  const backend = backendRaw.length > 0 ? backendRaw : 'unknown';
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return `decided-by: decision-model (conf n/a, backend ${backend})`;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const engine = require('./decision-model.cjs') as { formatProvenance: (conf: number, backend: string) => string };
  return engine.formatProvenance(raw, backend);
}
