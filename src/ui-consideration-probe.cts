/**
 * UI-consideration probe — the THIRD adapter of the probe-core resolution model
 * (ADR-457 build model; ADR-550 Decision 7 seam; #1867).
 *
 * The generic resolution lifecycle, the status×verification re-cut, `validateResolution`,
 * `validateRequirement`, the `analyzeCoverage` merge/rollup/orphan-reject engine, and the
 * `runProbeCli` scaffold all live in `src/probe-core.cts`. This module keeps ONLY the
 * UI-specific cluster: the six element kinds, the closed 8-category shape-rooted UI state
 * taxonomy, element classification, consideration proposal, and the `{ explicit, backstop }`
 * verification validators — mirroring `edge-probe` on the UI element/state axis.
 *
 * MIXED-axis boundary (spike verdict, ADR-550 pattern): this compiled taxonomy covers ONLY the
 * finite, project-independent shape-rooted *content/robustness* states (empty/loading/error/…).
 * Open, domain-specific UX considerations (real-time/offline, deep a11y/WCAG breadth, i18n/RTL
 * depth, emerging interaction paradigms) are prose-owned in `references/domain-probes.md`, NOT
 * here — forcing them into a closed compiled taxonomy is the wrong model.
 *
 * Authored as strict TypeScript (`src/ui-consideration-probe.cts`) and compiled by
 * `tsc -p tsconfig.build.json` to the gitignored runtime artifact
 * `gsd-core/bin/lib/ui-consideration-probe.cjs`. Do NOT hand-write the `.cjs`; it is emitted.
 * Tests `require()` the built artifact; `pretest` runs `build:lib` first.
 *
 * The pure functions stay dependency-free and deterministic. Only the PROPOSAL pass of the CLI
 * (no resolutions file) consults the optional decision-model capability (quick 261001-wzs, D11
 * site #1): for an element whose prose matched no kind cue and that has no authored `elements`
 * override, the model is asked which kinds apply: one call per element, in input order, all inside
 * a 60 s wall budget (CR-01); an element left unasked keeps its plain row and one stderr line says
 * so. A status-ok `yes` answer becomes a
 * `model_proposal` annotation on that element's existing `unclassified` row, with a `decided-by`
 * line per label and a `confirm_with: { elements }` override the author can paste to make the rows
 * deterministic. No row is added, removed or re-statused, so item keys, coverage counts and the
 * `autoResolve` unclassified exception stay exactly as without the model. A merge pass
 * (resolutions file given) never consults the model.
 */

import {
  type Item,
  type Resolution,
  type CoverageReport,
  type Validators,
  validateRequirement as coreValidateRequirement,
  validateResolution as coreValidateResolution,
  analyzeCoverage as coreAnalyzeCoverage,
  runProbeCli,
} from './probe-core.cjs';
import {
  type DecideFn,
  type DecideOpts,
  type DecisionBatchRequest,
  type DecisionQuestion,
  MAX_BATCH_QUESTIONS,
  decideWithinBudget,
  noteSkippedItems,
  answersFor,
  answerOf,
  okYes,
  decidedBy,
  resolveSiteDecide,
} from './decision-model-fallthrough.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import cliExitModule = require('./cli-exit.cjs');
const { runMain } = cliExitModule;

/** The six UI element kinds a described component can be (the closed relevance axis, D-03). */
export type UIElementKind =
  | 'form'
  | 'list-collection'
  | 'nav'
  | 'media'
  | 'interactive-control'
  | 'static-content';

/** The UI probe's verification tiers (mirrors EdgeVerification — the `verification` axis values). */
export type UIVerification = 'explicit' | 'backstop';

/** A single UI-state taxonomy category. `elements` lists which kinds make it applicable. */
export interface TaxonomyEntry {
  id: string;
  name: string;
  elements: UIElementKind[];
  consideration: string;
}

/**
 * A UI element to probe; `elements` is an optional authored override of classification.
 *
 * `text_en` (#4657) is an optional English translation of `text`, read by element
 * classification in preference to `text` when present (`text_en ?? text`). `UI_CUES`
 * are English-only word-boundary patterns, so a non-English `text` (e.g. a project
 * running with `response_language` set) classifies to zero kinds and lands every
 * element in the `unclassified` soft signal unless `text_en` supplies an English
 * rendering. `text` itself is unaffected and keeps its own meaning (the element's own
 * description, in whatever language the UI-SPEC uses) — only classification reads
 * `text_en` preferentially. Mirrors the edge adapter's `Requirement.text_en` (#3717).
 */
export interface Element {
  id: string;
  text?: string;
  text_en?: string;
  elements?: UIElementKind[];
}

/** A UI consideration item — a probe-core `Item` specialized to the UI verification vocabulary. */
export type UIConsideration = Item<UIVerification>;

/**
 * Word-boundary cues mapping element prose -> UI element kind.
 * Heuristic and intentionally lossy; an authored `elements` array overrides it. Every pattern is a
 * flat linear `\b(a|b|c)\b` alternation with NO nested/overlapping quantifiers (no catastrophic
 * backtracking — mirrors SHAPE_CUES).
 */
export const UI_CUES: Record<UIElementKind, RegExp> = {
  'form': /\b(forms?|inputs?|fields?|submit|validation|validate|password|email|checkbox|radio|textarea)\b/i,
  'list-collection': /\b(lists?|listing|tables?|grids?|collections?|rows?|items?|cards?|feed|results?)\b/i,
  'nav': /\b(nav|navigation|menus?|tabs?|breadcrumbs?|pagination|sidebars?)\b/i,
  'media': /\b(images?|img|videos?|avatars?|thumbnails?|photos?|gallery|icons?)\b/i,
  'interactive-control': /\b(buttons?|toggles?|switch|switches|dropdowns?|sliders?|controls?|pickers?)\b/i,
  'static-content': /\b(labels?|headings?|titles?|paragraphs?|copy|descriptions?|text)\b/i,
};

/** The locked element vocabulary — exactly the keys of UI_CUES (single source of truth). */
export const VALID_ELEMENT_KINDS: ReadonlySet<string> = new Set(Object.keys(UI_CUES));

/** Detect which element kinds a description's prose matches (heuristic). */
export function classifyElement(text: string): UIElementKind[] {
  const kinds: UIElementKind[] = [];
  const subject = String(text == null ? '' : text);
  for (const kind of Object.keys(UI_CUES) as UIElementKind[]) {
    if (UI_CUES[kind].test(subject)) kinds.push(kind);
  }
  return kinds;
}

/**
 * Closed taxonomy of 8 shape-rooted UI *content/robustness* state categories. `elements` lists
 * which element kinds make the category relevant. These ids are the CLOSED/compiled subset — the
 * open UX subset (real-time/offline, deep a11y, i18n/RTL depth) is prose-owned in
 * `references/domain-probes.md` and deliberately absent here (D-02).
 */
export const UI_TAXONOMY: TaxonomyEntry[] = [
  { id: 'empty', name: 'Empty / no data', elements: ['form', 'list-collection', 'media'], consideration: 'What is shown when there is no data — zero items, an unfilled form, or absent media?' },
  { id: 'loading', name: 'Loading / in-flight', elements: ['form', 'list-collection', 'media', 'nav', 'interactive-control'], consideration: 'What is shown while data or content is still loading (skeleton, spinner, progressive reveal)?' },
  { id: 'error', name: 'Error / failure', elements: ['form', 'list-collection', 'media', 'nav', 'interactive-control'], consideration: 'What is shown when the load or submit fails (message, retry affordance, partial fallback)?' },
  { id: 'populated', name: 'Populated / happy path', elements: ['list-collection', 'media'], consideration: 'What does the normal populated (happy-path) state look like at a typical volume of content?' },
  { id: 'partial', name: 'Partial / incomplete', elements: ['form', 'list-collection'], consideration: 'What is shown for partial or incomplete data — some fields or rows present, others missing?' },
  { id: 'overflow', name: 'Overflow / truncation', elements: ['list-collection', 'nav', 'static-content'], consideration: 'What happens when content exceeds its container — scroll, clip, wrap, or truncate?' },
  { id: 'zero-one-many', name: 'Zero / one / many', elements: ['list-collection'], consideration: 'How does the layout read at zero, one, and many items (singular vs plural copy, spacing)?' },
  { id: 'long-text', name: 'Long text', elements: ['form', 'static-content', 'interactive-control', 'nav'], consideration: 'What happens with unusually long text — truncation, wrapping, ellipsis, or reflow?' },
];

/** Return taxonomy category ids whose applicable element kinds intersect the input set. */
export function applicableCategories(kinds: UIElementKind[]): string[] {
  const set = new Set<UIElementKind>(kinds);
  return UI_TAXONOMY.filter((c) => c.elements.some((k) => set.has(k))).map((c) => c.id);
}

/**
 * Pseudo-category for an element whose prose matched NO element cue (#1110). It is a soft
 * "review manually" signal, NOT a 9th taxonomy category: it stays out of `UI_TAXONOMY` (the closed
 * eight) and only joins `UI_VALIDATORS.categories` so `analyzeCoverage` accepts the item.
 */
export const UNCLASSIFIED_CATEGORY = 'unclassified';
const UNCLASSIFIED_PROBE = 'unclassified — review manually';

/**
 * The UI adapter's injected runtime validators (ADR-550 #5). `categories` is the closed taxonomy
 * plus the unclassified soft-signal; both verification tiers require a non-empty `resolution` so
 * plan-phase has a criterion to lift. NOTE the probe-core Validators field is `verification`
 * (SINGULAR); CONTEXT.md D-05's `verifications` is a paraphrase typo, not the real field name.
 */
export const UI_VALIDATORS: Validators = {
  categories: [...UI_TAXONOMY.map((c) => c.id), UNCLASSIFIED_CATEGORY],
  verification: ['explicit', 'backstop'],
  requiredFieldsByVerification: { explicit: ['resolution'], backstop: ['resolution'] },
};

/**
 * Validate a single element — the generic id/text checks (probe-core) plus the UI adapter's
 * `elements`-must-be-an-array check. The `text` prose is REQUIRED (it is the classification
 * signal), so reject a missing/empty `text` when no authored `elements` override is present.
 * Without this, a `{ id }` element classifies to zero kinds → zero considerations → it is silently
 * DROPPED from coverage. An explicit `elements` array (including `[]` for "no applicable
 * categories") is the legitimate way to opt out of prose classification.
 */
export function validateRequirement(element: Element): void {
  coreValidateRequirement(element);
  const r = element as unknown as { elements?: unknown; text?: unknown; text_en?: unknown };
  if (r.elements != null && !Array.isArray(r.elements)) {
    throw new Error(`element ${element.id} elements must be an array when present`);
  }
  if (r.elements == null && !(typeof r.text === 'string' && r.text.trim())) {
    throw new Error(
      `element ${element.id} text must be a non-empty string when no elements override is provided`,
    );
  }
  // text_en (#4657) is optional, but when present it must be a non-empty string. An empty
  // string is NOT caught by `??` (only null/undefined are), so an unvalidated `text_en: ''`
  // would silently win `text_en ?? text` and classify against '' — the same fail-open shape
  // #1110/#2773 already exist to eliminate, just moved one field over. Validated
  // unconditionally (not gated on whether `elements` will make it unused) so bad data fails
  // closed even when it happens to be dead for this particular call.
  if (r.text_en != null && !(typeof r.text_en === 'string' && r.text_en.trim())) {
    throw new Error(`element ${element.id} text_en must be a non-empty string when present`);
  }
}

/** Validate a UI-consideration resolution against the UI verification vocabulary (delegated, D-06). */
export function validateResolution(resolution: Resolution<UIVerification>): true {
  return coreValidateResolution(resolution, UI_VALIDATORS);
}

/**
 * Propose candidate considerations for an element. Uses authored `elements` when present, else
 * classifies from prose. Every proposed consideration starts unresolved (verification null); the
 * taxonomy entry's `consideration` question is carried in the item's `probe` field.
 */
export function proposeConsiderations(element: Element): UIConsideration[] {
  validateRequirement(element);
  let kinds: UIElementKind[];
  if (Array.isArray(element.elements)) {
    // Fail closed: an authored array must contain only locked element kinds. A non-empty but
    // invalid array would otherwise intersect no category and silently suppress every probe — the
    // gate reads green while nothing was checked. An empty array stays a valid "no applicable
    // categories" override (silent opt-out).
    for (const k of element.elements) {
      if (typeof k !== 'string' || !VALID_ELEMENT_KINDS.has(k)) {
        throw new Error(
          `invalid element kind ${JSON.stringify(k)} for element ${element.id} — must be one of: ${[...VALID_ELEMENT_KINDS].join(', ')}`,
        );
      }
    }
    kinds = element.elements;
  } else {
    // #4657: prefer the English translation when present — UI_CUES are English-only
    // word-boundary patterns, so a non-English `text` (e.g. response_language projects)
    // would otherwise classify to zero kinds. validateRequirement (called above) has
    // already guaranteed text_en, if present, is a non-empty string.
    kinds = classifyElement((element.text_en ?? element.text) as string);
    if (kinds.length === 0) {
      // Prose present but no element cue matched. Do NOT silently drop it (#1110): a UI element
      // whose phrasing missed every cue would otherwise vanish from coverage with no signal — the
      // exact blind spot this probe exists to catch. Surface ONE soft, dismissible "unclassified —
      // review manually" candidate. The explicit `elements: []` opt-out (above) stays silent.
      return [{
        requirement_id: element.id,
        category: UNCLASSIFIED_CATEGORY,
        status: 'unresolved',
        verification: null,
        resolution: null,
        reason: null,
        probe: UNCLASSIFIED_PROBE,
      }];
    }
  }
  return applicableCategories(kinds).map((catId): UIConsideration => {
    const cat = UI_TAXONOMY.find((c) => c.id === catId);
    return {
      requirement_id: element.id,
      category: catId,
      status: 'unresolved',
      verification: null,
      resolution: null,
      reason: null,
      probe: cat ? cat.consideration : '',
    };
  });
}

/**
 * Propose considerations for every element (deterministic propose), then delegate the
 * merge/rollup/orphan-reject to probe-core. UI-specific pre-checks: elements must be an array,
 * element ids must be unique. Throws on any invalid resolution.
 */
export function analyzeCoverage(
  elements: Element[],
  resolutions: Resolution<UIVerification>[] = [],
): CoverageReport<UIVerification> {
  if (!Array.isArray(elements)) {
    throw new Error('elements must be an array');
  }
  const items: UIConsideration[] = [];
  const seenIds = new Set<string>();
  for (const el of elements) {
    validateRequirement(el);
    if (seenIds.has(el.id)) {
      throw new Error(`duplicate element id ${JSON.stringify(el.id)}`);
    }
    seenIds.add(el.id);
    for (const consideration of proposeConsiderations(el)) items.push(consideration);
  }
  return coreAnalyzeCoverage(items, resolutions, UI_VALIDATORS);
}

/**
 * A per-element propose-then-confirm view (WIRE-01, #1867): the detected element `kinds`, the
 * `categories` they raise, the proposed `considerations`, and an `unclassified` flag. The ui-phase
 * probe step surfaces `kinds` to the user so a human can ADD a kind the heuristic missed — the
 * classifier is a SIGNAL, not ground truth (Goodhart). A single tripped cue on a multi-kind surface
 * under-covers; the confirm step, not the heuristic, is what makes coverage sound.
 */
export interface ElementProposal {
  id: string;
  kinds: UIElementKind[];
  categories: string[];
  considerations: UIConsideration[];
  unclassified: boolean;
}

/**
 * Build the propose-then-confirm view for every element (WIRE-01). Deterministic: a pure function
 * of the input array (no Date/random/iteration-order surprise), so re-running the probe on an
 * unchanged UI-SPEC yields byte-identical rows (the idempotency substrate WIRE-02 relies on). An
 * aggregating VIEW over the existing Phase-1 functions — it adds no new classification logic.
 *
 * `unclassified` is true ONLY when prose classified to zero cues (#1110); an explicit `elements: []`
 * opt-out stays silent (`unclassified: false`, empty considerations), matching proposeConsiderations.
 */
export function proposeElements(elements: Element[]): ElementProposal[] {
  return elements.map((el): ElementProposal => {
    validateRequirement(el);
    const considerations = proposeConsiderations(el);
    const kinds: UIElementKind[] = Array.isArray(el.elements)
      ? el.elements // already validated inside proposeConsiderations
      : classifyElement((el.text_en ?? el.text) as string); // #4657: text_en ?? text
    const unclassified = !Array.isArray(el.elements) && kinds.length === 0;
    const categories = unclassified ? [] : applicableCategories(kinds);
    return { id: el.id, kinds, categories, considerations, unclassified };
  });
}

/**
 * The deterministic `--auto` resolution FLOOR (WIRE-01, SC2). For each proposed consideration:
 *   - an `unclassified` item stays `unresolved` — NEVER auto-backstopped (a missing cue is not
 *     evidence a consideration applies, #1110);
 *   - every applicable item auto-resolves to a conservative `backstop` (carrying the taxonomy
 *     question as its `resolution` so probe-core's "backstop requires a resolution" check passes).
 *   - it NEVER emits `dismissed` under any branch — a wrong auto-dismissal is the exact silent
 *     failure this probe eliminates (the never-dismiss invariant, asserted on the typed return).
 *
 * This is the CODE floor only. It mirrors spec-phase.md Step 5.5's prose `--auto` rule
 * (auto-`covered` where a defensible acceptance criterion can be written, else auto-`backstop`,
 * never auto-`dismiss`) but deliberately keeps the covered-vs-backstop JUDGMENT in the ui-phase
 * workflow (an LLM MAY upgrade an item to `explicit`/covered when it can write a real acceptance
 * criterion). Encoding the never-dismiss FLOOR in code is what makes the invariant unit-testable;
 * the covered-upgrade stays prose because "a defensible criterion exists" is not a code predicate.
 * Keep the two in sync: if spec-phase's `--auto` policy changes, revisit this floor.
 */
export function autoResolve(items: UIConsideration[]): Resolution<UIVerification>[] {
  return items.map((item): Resolution<UIVerification> => {
    if (item.category === UNCLASSIFIED_CATEGORY) {
      return { requirement_id: item.requirement_id, category: item.category, status: 'unresolved', verification: null, resolution: null, reason: null };
    }
    return { requirement_id: item.requirement_id, category: item.category, status: 'resolved', verification: 'backstop', resolution: item.probe, reason: null };
  });
}

/*
 * Decision-model fallthrough (quick 261001-wzs, D11 site #1, D14, D18). Everything below is a
 * post-pass over `analyzeCoverage`'s result: the pure classifiers above are untouched.
 */

/**
 * One fixed yes/no question per element kind, keyed exactly by the UI_CUES keys. The instructions
 * are module constants; the untrusted element prose goes only in the request `state` (ADR-1577).
 */
export const UI_KIND_QUESTIONS: Readonly<Record<UIElementKind, DecisionQuestion>> = Object.freeze({
  'form': Object.freeze({ type: 'noul' as const, instructions: 'Does this UI element take user input, such as a form, fields, checkboxes or submission? Answer yes or no.' }),
  'list-collection': Object.freeze({ type: 'noul' as const, instructions: 'Does this UI element show a list, table, grid, feed or other repeated items? Answer yes or no.' }),
  'nav': Object.freeze({ type: 'noul' as const, instructions: 'Does this UI element navigate between views, such as menus, tabs, breadcrumbs, a sidebar or pagination? Answer yes or no.' }),
  'media': Object.freeze({ type: 'noul' as const, instructions: 'Does this UI element show images, video, avatars, thumbnails or icons? Answer yes or no.' }),
  'interactive-control': Object.freeze({ type: 'noul' as const, instructions: 'Is this UI element a button, toggle, dropdown, slider or picker? Answer yes or no.' }),
  'static-content': Object.freeze({ type: 'noul' as const, instructions: 'Does this UI element show headings, labels, titles or descriptive text? Answer yes or no.' }),
});

/** A model-proposed element-kind label with its provenance line (D14). */
export interface ModelProposalLabel {
  label: UIElementKind;
  decided_by: string;
}

/** The annotation a probe adds to an unclassified row. Never a row of its own. */
export interface ModelProposal {
  labels: ModelProposalLabel[];
  categories: string[];
  confirm_with: { elements: UIElementKind[] };
}

/** A UI consideration that may carry the optional model annotation (unclassified rows only). */
export type AnnotatedConsideration = UIConsideration & { model_proposal?: ModelProposal };

/** A coverage report whose unclassified rows may carry `model_proposal`. */
export interface AnnotatedCoverageReport {
  items: AnnotatedConsideration[];
  coverage: CoverageReport<UIVerification>['coverage'];
}

/** The planned batch: the D18 request plus which element each request id stands for. */
export interface KindPlan {
  request: DecisionBatchRequest;
  targets: Array<{ id: string; requirement_id: string }>;
  /** Every zero-hit item, including any past the cap (IN-04), so a skip can be reported. */
  fallthrough: number;
}

const KIND_KEYS = Object.keys(UI_CUES) as UIElementKind[];

/**
 * Plan the batched request for elements the regex could not label (sent one request per call by
 * the proposal pass). Pure. An element is asked
 * only when it has no authored `elements` array (including the `[]` opt-out) and
 * `classifyElement(text_en ?? text)` is empty. The request state is that exact subject, verbatim.
 * Returns null when nothing falls through.
 */
export function planKindDecisions(elements: Element[]): KindPlan | null {
  if (!Array.isArray(elements)) return null;
  const questions: Record<string, DecisionQuestion> = {};
  for (const kind of KIND_KEYS) questions[kind] = UI_KIND_QUESTIONS[kind];
  const maxTargets = Math.floor(MAX_BATCH_QUESTIONS / KIND_KEYS.length);
  const targets: KindPlan['targets'] = [];
  const requests: DecisionBatchRequest['requests'] = [];
  let fallthrough = 0;
  for (const el of elements) {
    if (el == null || Array.isArray(el.elements)) continue;
    const subject = el.text_en ?? el.text;
    if (typeof subject !== 'string' || classifyElement(subject).length > 0) continue;
    fallthrough += 1;
    if (targets.length >= maxTargets) continue;
    const id = `r${targets.length}`;
    targets.push({ id, requirement_id: el.id });
    requests.push({ id, state: subject, questions: { ...questions } });
  }
  return targets.length === 0 ? null : { request: { requests }, targets, fallthrough };
}

/**
 * Apply a decide response to a report. Pure: returns a new report. Only status-ok `yes` answers
 * count, so the engine's floor is the only threshold. Labels follow UI_CUES order and categories
 * follow UI_TAXONOMY order, so identical answers give byte-identical JSON. Only the `unclassified`
 * row of an asked element can gain `model_proposal`; everything else is copied through unchanged.
 */
export function applyKindDecisions(
  report: CoverageReport<UIVerification>,
  plan: KindPlan | null,
  response: unknown,
): AnnotatedCoverageReport {
  const proposals = new Map<string, ModelProposal>();
  if (plan !== null) {
    for (const target of plan.targets) {
      const answers = answersFor(response, target.id);
      if (answers === null) continue;
      const labels: ModelProposalLabel[] = [];
      for (const kind of KIND_KEYS) {
        const answer = answerOf(answers, kind);
        if (okYes(answer)) labels.push({ label: kind, decided_by: decidedBy(answer, response) });
      }
      if (labels.length === 0) continue;
      const kinds = labels.map((l) => l.label);
      proposals.set(target.requirement_id, {
        labels,
        categories: applicableCategories(kinds),
        confirm_with: { elements: kinds },
      });
    }
  }
  const items: AnnotatedConsideration[] = report.items.map((item): AnnotatedConsideration => {
    const proposal = item.category === UNCLASSIFIED_CATEGORY ? proposals.get(item.requirement_id) : undefined;
    return proposal === undefined ? item : { ...item, model_proposal: proposal };
  });
  return { ...report, items };
}

/**
 * The proposal pass: today's `analyzeCoverage(elements, [])` FIRST (so validation still throws
 * exactly as before), then one decide call per element that fell through, inside the site wall
 * budget (`decideWithinBudget`). With nothing to ask, no capability or a null decide, the
 * deterministic report is returned as is. When the budget or the item cap left zero-hit elements
 * unasked, one stderr line reports how many got a proposal.
 */
export function proposeCoverageWithDecisionModel(
  elements: Element[],
  opts: DecideOpts = {},
): CoverageReport<UIVerification> | AnnotatedCoverageReport {
  const base = analyzeCoverage(elements, []);
  const plan = planKindDecisions(elements);
  if (plan === null) return base;
  const decide: DecideFn | null = resolveSiteDecide(opts);
  if (decide === null) return base;
  const run = decideWithinBudget(decide, plan.request);
  const report = applyKindDecisions(base, plan, run.response);
  if (run.outOfTime || plan.fallthrough > plan.targets.length) {
    noteSkippedItems(report.items.filter((i) => i.model_proposal !== undefined).length, plan.fallthrough);
  }
  return report;
}

/**
 * The `runProbeCli` analyze callback. With no resolutions path (`argv[3]`) this is the proposal
 * pass and may consult the model; with one it is the pure merge pass.
 */
export function makeCliAnalyzer(
  argv: readonly string[],
  opts: DecideOpts = {},
): (elements: unknown, resolutions: unknown) => CoverageReport<UIVerification> | AnnotatedCoverageReport {
  const mergePass = Boolean(argv[3]);
  return (elements: unknown, resolutions: unknown) =>
    mergePass
      ? analyzeCoverage(elements as Element[], resolutions as Resolution<UIVerification>[])
      : proposeCoverageWithDecisionModel(elements as Element[], opts);
}

/*
 * CLI entry (invokable surface): `ui-consideration-probe.cjs <elements.json> [resolutions.json]`.
 * The generic I/O plumbing (parse, fail-closed exit 2, pretty-JSON out) lives in probe-core's
 * `runProbeCli`; this adapter supplies its `analyzeCoverage`. Guarded by `require.main === module`
 * so it runs only when the compiled `.cjs` is executed directly.
 */
if (require.main === module) {
  // runProbeCli's default `exit` now throws ExitError (src/probe-core.cts) rather
  // than calling process.exit directly, so this entry point must run under
  // runMain to translate that throw into process.exitCode.
  runMain(() => {
    runProbeCli(
      makeCliAnalyzer(process.argv, { cwd: process.cwd() }),
      { usage: 'ui-consideration-probe.cjs <elements.json> [resolutions.json]' },
    );
  });
}
