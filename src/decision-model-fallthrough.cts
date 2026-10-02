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
 *  - A site makes at most one decide call per run, batching all of its fallthrough items.
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

/** A synchronous decide call: returns a D18 response object, or null when none is available. */
export type DecideFn = (request: DecisionBatchRequest) => unknown;

/** The option bag every site entry point takes. */
export interface DecideOpts {
  cwd?: string;
  /** undefined: resolve lazily via `resolveDecide(cwd)`; null: treat as inactive; function: injected. */
  decide?: DecideFn | null;
}

interface ResolveDeps {
  isActive?: (id: string, cwd: string) => boolean;
  loadEngine?: () => { decideSync: (request: unknown, opts: { cwd: string }) => unknown };
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
  const loadEngine = deps.loadEngine ?? ((): { decideSync: (request: unknown, opts: { cwd: string }) => unknown } => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('./decision-model.cjs') as { decideSync: (request: unknown, opts: { cwd: string }) => unknown };
  });
  return (request: DecisionBatchRequest): unknown => {
    try {
      return loadEngine().decideSync(request, { cwd });
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      process.stderr.write(`decision-model: call failed (${message}); continuing without it\n`);
      return null;
    }
  };
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
 */
export function decidedBy(answer: unknown, response: unknown): string {
  const raw = isRecord(answer) ? Number(answer['confidence']) : NaN;
  const confidence = Number.isFinite(raw) ? raw : 0;
  const backendRaw = isRecord(response) && typeof response['backend'] === 'string' ? response['backend'] : '';
  const backend = backendRaw.length > 0 ? backendRaw : 'unknown';
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const engine = require('./decision-model.cjs') as { formatProvenance: (conf: number, backend: string) => string };
  return engine.formatProvenance(confidence, backend);
}
