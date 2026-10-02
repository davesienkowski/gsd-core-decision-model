/**
 * UI-consideration-probe adapter unit tests (#1867).
 *
 * Asserts the LOCKED export surface of the THIRD probe-core adapter against the
 * BUILT artifact (`gsd-core/bin/lib/ui-consideration-probe.cjs`), which
 * `npm run build:lib` (run by pretest) emits from `src/ui-consideration-probe.cts`.
 *
 * The adapter mirrors `edge-probe` on the UI element/state axis: a closed 8-id
 * shape-rooted `UI_TAXONOMY`, an element-kind relevance filter
 * (`UI_CUES` → `classifyElement` → `applicableCategories`), the `unclassified`
 * soft-signal (#1110), and the `{explicit, backstop}` verification validators —
 * all lifecycle/merge/validation delegated to `probe-core` (ADPT-01/02/03, FILT-01).
 *
 * Structured-value assertions only (local/no-source-grep): every assertion is on a
 * typed return of the built module, never on stdout or file-content substrings.
 */
'use strict';
process.env.GSD_TEST_MODE = '1';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runNode } = require('./helpers/process-seam.cjs');
const { PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
const { throwIfFailed } = require('./helpers/git-fixture.cjs');
const { cleanup, createTempDir } = require('./helpers.cjs');

const BUILT_SCRIPT = path.join(__dirname, '..', 'gsd-core', 'bin', 'lib', 'ui-consideration-probe.cjs');
const uc = require(BUILT_SCRIPT);
// The LIFT-01 primitives are probe-core's (there is no adapter-owned lift function — the lift is
// plan-phase workflow prose); LIFT-01 correctness is proven at the shared primitive level here.
const core = require(path.join(__dirname, '..', 'gsd-core', 'bin', 'lib', 'probe-core.cjs'));

const TAXONOMY_IDS = ['empty', 'loading', 'error', 'populated', 'partial', 'overflow', 'zero-one-many', 'long-text'];

describe('ui-consideration-probe: classifyElement (D-03/D-04 element-cue filter)', () => {
  test('detects form from input/field/validation cues', () => {
    assert.ok(uc.classifyElement('A signup form with input fields and validation').includes('form'));
  });
  test('detects list-collection from table/rows cues', () => {
    assert.ok(uc.classifyElement('A table listing all rows of results').includes('list-collection'));
  });
  test('detects static-content from heading/paragraph/copy cues', () => {
    assert.ok(uc.classifyElement('A heading and a paragraph of body copy').includes('static-content'));
  });
  test('returns [] when no element cue matches (zero-cue prose)', () => {
    assert.deepEqual(uc.classifyElement('xyzzy plugh frobnicate wibble'), []);
  });
  test('null/undefined text is null-safe and returns []', () => {
    assert.deepEqual(uc.classifyElement(null), []);
    assert.deepEqual(uc.classifyElement(undefined), []);
  });
});

describe('ui-consideration-probe: UI_TAXONOMY + UI_VALIDATORS (ADPT-02/03, D-01/D-02/D-05)', () => {
  test('UI_TAXONOMY has exactly the 8 shape-rooted ids in order', () => {
    assert.deepEqual(uc.UI_TAXONOMY.map((c) => c.id), TAXONOMY_IDS);
  });
  test('every taxonomy entry has name, elements[], and a string consideration', () => {
    for (const c of uc.UI_TAXONOMY) {
      assert.equal(typeof c.name, 'string');
      assert.ok(Array.isArray(c.elements) && c.elements.length >= 1);
      assert.equal(typeof c.consideration, 'string');
      assert.ok(c.consideration.length > 0);
    }
  });
  test('UNCLASSIFIED_CATEGORY is the soft-signal, kept OUT of the taxonomy (#1110)', () => {
    assert.equal(uc.UNCLASSIFIED_CATEGORY, 'unclassified');
    assert.ok(!uc.UI_TAXONOMY.map((c) => c.id).includes('unclassified'));
  });
  test('UI_VALIDATORS.categories === the 8 ids plus unclassified; verification is the {explicit,backstop} tiers (singular key)', () => {
    assert.deepEqual(uc.UI_VALIDATORS.categories, [...TAXONOMY_IDS, 'unclassified']);
    // The probe-core Validators field is `verification` (SINGULAR) — CONTEXT.md D-05's `verifications` is a paraphrase typo.
    assert.deepEqual(uc.UI_VALIDATORS.verification, ['explicit', 'backstop']);
    assert.equal(uc.UI_VALIDATORS.verifications, undefined);
  });
  test('VALID_ELEMENT_KINDS is derived from UI_CUES keys (single source of truth)', () => {
    assert.deepEqual([...uc.VALID_ELEMENT_KINDS].sort(), Object.keys(uc.UI_CUES).sort());
  });
});

describe('ui-consideration-probe: applicableCategories (FILT-01 relevance intersection, D-04)', () => {
  test('static-content raises only overflow + long-text (no loading/error/empty — SPEC R2 hint)', () => {
    assert.deepEqual(uc.applicableCategories(['static-content']).sort(), ['long-text', 'overflow']);
  });
  test('list-collection raises the richest set (empty/loading/error/populated/partial/overflow/zero-one-many)', () => {
    assert.deepEqual(uc.applicableCategories(['list-collection']).sort(),
      ['empty', 'error', 'loading', 'overflow', 'partial', 'populated', 'zero-one-many']);
  });
  test('interactive-control raises loading + error + long-text — a control has in-flight and failure states, not just long-text (#2151)', () => {
    assert.deepEqual(uc.applicableCategories(['interactive-control']).sort(), ['error', 'loading', 'long-text']);
  });
  test('no element kinds raises nothing', () => {
    assert.deepEqual(uc.applicableCategories([]), []);
  });
  test('result ids are a subset of the taxonomy ids', () => {
    const all = uc.applicableCategories(['form', 'list-collection', 'nav', 'media', 'interactive-control', 'static-content']);
    for (const id of all) assert.ok(TAXONOMY_IDS.includes(id));
  });
  test('every UIElementKind maps to >= 1 taxonomy category (a classified element never silently yields zero considerations)', () => {
    for (const kind of Object.keys(uc.UI_CUES)) {
      assert.ok(uc.applicableCategories([kind]).length >= 1, `element kind ${kind} must have >= 1 applicable category`);
    }
  });
});

describe('ui-consideration-probe: proposeConsiderations (ADPT-01/FILT-01, #1110)', () => {
  test('emits exactly one unresolved Item per applicable category, question carried in Item.probe', () => {
    const element = { id: 'C1', text: 'A table listing all rows of results' };
    const items = uc.proposeConsiderations(element);
    const expected = uc.applicableCategories(uc.classifyElement(element.text));
    assert.deepEqual(items.map((i) => i.category).sort(), [...expected].sort());
    for (const it of items) {
      assert.equal(it.requirement_id, 'C1');
      assert.equal(it.status, 'unresolved');
      assert.equal(it.verification, null);
      assert.equal(it.resolution, null);
      assert.equal(it.reason, null);
      assert.equal(typeof it.probe, 'string');
      assert.ok(it.probe.length > 0);
    }
  });
  test('zero-cue prose yields exactly ONE unclassified item, never a silent drop or minted category (#1110)', () => {
    const items = uc.proposeConsiderations({ id: 'Z', text: 'xyzzy plugh frobnicate' });
    assert.equal(items.length, 1);
    assert.equal(items[0].category, 'unclassified');
    assert.equal(items[0].status, 'unresolved');
    assert.equal(items[0].verification, null);
  });
  test('an explicit `elements: []` opt-out is silent (no items, no unclassified)', () => {
    assert.deepEqual(uc.proposeConsiderations({ id: 'O', text: 'anything', elements: [] }), []);
  });
  test('an authored array with an invalid element kind throws (fail closed, never silently empty)', () => {
    assert.throws(() => uc.proposeConsiderations({ id: 'B', text: 'x', elements: ['not-a-kind'] }));
  });
  test('an authored valid element override bypasses prose classification', () => {
    const items = uc.proposeConsiderations({ id: 'A', text: 'no cues here at all', elements: ['static-content'] });
    assert.deepEqual(items.map((i) => i.category).sort(), ['long-text', 'overflow']);
  });
});

describe('ui-consideration-probe: delegated validation (ADPT-03, D-06 — inherited from probe-core)', () => {
  test('validateResolution rejects a dismissed resolution with an empty/blank reason', () => {
    assert.throws(() => uc.validateResolution({
      requirement_id: 'C1', category: 'empty', status: 'dismissed', verification: null, resolution: null, reason: '   ',
    }));
  });
  test('analyzeCoverage rejects an orphan resolution (no matching proposed item)', () => {
    const elements = [{ id: 'C1', text: 'A table listing all rows of results' }];
    const orphan = [{
      requirement_id: 'C1', category: 'nonexistent-category', status: 'resolved',
      verification: 'explicit', resolution: 'x', reason: null,
    }];
    assert.throws(() => uc.analyzeCoverage(elements, orphan));
  });
  test('analyzeCoverage delegates a clean merge to probe-core and reports coverage', () => {
    const elements = [{ id: 'C1', text: 'A table listing all rows of results' }];
    const report = uc.analyzeCoverage(elements, []);
    assert.ok(report && report.coverage && typeof report.coverage.applicable === 'number');
    assert.ok(Array.isArray(report.items) && report.items.length >= 1);
  });
});

// ── LIFT-01 (proven at the shared probe-core primitive level on UI-SPEC-shaped input) ──────────
// A resolved `## UI Considerations` section after resolution: a `covered` (inferable)
// consideration → a plain-string truth; a `backstop` (non-inferable, purely-visual) consideration
// → carries verification: 'backstop'. Measures DISPOSITION, not entry-count (SPEC R7, Goodhart).
const COVERED = 'Empty state for the results table renders the documented "No results" copy.';
const BACKSTOP = { statement: 'Overflowing long labels truncate with an ellipsis without shifting layout.', verification: 'backstop' };
const COVERED_2 = 'Loading state shows a skeleton for the results table.';

describe('ui-consideration-probe LIFT-01: projectTruths (covered→string, backstop→flat scalar, D-07)', () => {
  test('covered consideration projects to a bare string; backstop projects to {statement, verification:backstop}', () => {
    const out = core.projectTruths([COVERED, BACKSTOP]);
    assert.equal(out[0], COVERED);
    assert.deepEqual(out[1], { statement: BACKSTOP.statement, verification: 'backstop' });
  });
  test('projection preserves input order (deterministic lift over taxonomy id order — ordering/stability edge)', () => {
    const out = core.projectTruths([COVERED, COVERED_2, BACKSTOP]);
    assert.equal(out[0], COVERED);
    assert.equal(out[1], COVERED_2);
    assert.deepEqual(out[2], { statement: BACKSTOP.statement, verification: 'backstop' });
  });
  test('no covered/backstop consideration is silently dropped', () => {
    const input = [COVERED, COVERED_2, BACKSTOP];
    assert.equal(core.projectTruths(input).length, input.length);
  });
});

describe('ui-consideration-probe LIFT-01: verify-time disposition (never silent pass, D-09)', () => {
  test('a no-evidence backstop consideration routes to insufficient_spec — NEVER a silent green', () => {
    const d = core.dispositionForUnverifiableTruth(BACKSTOP, { evidence: [] });
    assert.equal(d.status, 'unverified');
    assert.equal(d.flagged, true);
    assert.equal(d.tier, 'backstop');
    assert.equal(d.reason, core.INSUFFICIENT_SPEC);
    assert.equal(core.INSUFFICIENT_SPEC, 'insufficient_spec');
    assert.notEqual(d.status, 'green');
  });
  test('a backstop consideration WITH explicit evidence (a passing wired test) disposes green', () => {
    const d = core.dispositionForUnverifiableTruth(BACKSTOP, { evidence: [{ kind: 'wired-test', passed: true }] });
    assert.equal(d.status, 'green');
    assert.equal(d.flagged, false);
  });
  test('a covered (inferable) consideration disposes green even with no evidence (over-abstention guard)', () => {
    const d = core.dispositionForUnverifiableTruth(COVERED, { evidence: [] });
    assert.equal(d.status, 'green');
    assert.equal(d.flagged, false);
  });
});

// ══ WIRE-01 (Phase 2, #1867) — the live ui-phase producer surface ════════════════════════════
// Two new adapter functions the ui-phase Step 9.5 probe consumes: proposeElements (the
// propose-then-confirm view exposing detected kinds + applicable categories per element) and
// autoResolve (the deterministic `--auto` resolution FLOOR that never dismisses and never
// auto-backstops an unclassified item, #1110). Structured-value assertions only.
const LIST_ELEMENT = { id: 'C1', text: 'A table listing all rows of results' };
const ZERO_CUE_ELEMENT = { id: 'Z', text: 'xyzzy plugh frobnicate' };
// A surface that is genuinely BOTH a form and a list, but whose prose trips only the form cue —
// the partial-cue recall gap the confirm step exists to close.
const PARTIAL_CUE_ELEMENT = { id: 'P', text: 'A signup form with input fields and validation' };

describe('ui-consideration-probe: proposeElements (WIRE-01 confirm surface, SC1)', () => {
  test('a classified element returns one ElementProposal with kinds, applicable categories, considerations, unclassified:false', () => {
    const [p] = uc.proposeElements([LIST_ELEMENT]);
    assert.equal(p.id, 'C1');
    assert.ok(p.kinds.includes('list-collection'));
    assert.deepEqual([...p.categories].sort(), [...uc.applicableCategories(uc.classifyElement(LIST_ELEMENT.text))].sort());
    assert.deepEqual(p.considerations.map((c) => c.category).sort(), [...p.categories].sort());
    assert.equal(p.unclassified, false);
  });
  test('a zero-cue element returns kinds:[], categories:[], unclassified:true, and exactly one unclassified consideration (#1110)', () => {
    const [p] = uc.proposeElements([ZERO_CUE_ELEMENT]);
    assert.deepEqual(p.kinds, []);
    assert.deepEqual(p.categories, []);
    assert.equal(p.unclassified, true);
    assert.equal(p.considerations.length, 1);
    assert.equal(p.considerations[0].category, uc.UNCLASSIFIED_CATEGORY);
  });
  test('proposeElements is deterministic — two calls on the same element array deepEqual (idempotency substrate for WIRE-02)', () => {
    assert.deepEqual(uc.proposeElements([LIST_ELEMENT, ZERO_CUE_ELEMENT]), uc.proposeElements([LIST_ELEMENT, ZERO_CUE_ELEMENT]));
  });
  test('an authored elements[] override bypasses prose classification and drives the categories', () => {
    const [p] = uc.proposeElements([{ id: 'A', text: 'no cues here at all', elements: ['static-content'] }]);
    assert.deepEqual([...p.kinds].sort(), ['static-content']);
    assert.deepEqual([...p.categories].sort(), ['long-text', 'overflow']);
    assert.equal(p.unclassified, false);
  });
});

describe('ui-consideration-probe: autoResolve (WIRE-01 typed --auto never-dismiss, SC2, #1110)', () => {
  test('every applicable consideration auto-resolves to a backstop with a non-empty resolution; NONE is dismissed', () => {
    const items = uc.proposeConsiderations(LIST_ELEMENT);
    const resolutions = uc.autoResolve(items);
    assert.equal(resolutions.length, items.length);
    for (const r of resolutions) {
      assert.notEqual(r.status, 'dismissed');
      assert.equal(r.status, 'resolved');
      assert.equal(r.verification, 'backstop');
      assert.equal(typeof r.resolution, 'string');
      assert.ok(r.resolution.length > 0);
    }
  });
  test('an unclassified item stays unresolved — never auto-backstopped (a missing cue is not evidence, #1110)', () => {
    const items = uc.proposeConsiderations(ZERO_CUE_ELEMENT); // one unclassified item
    const [r] = uc.autoResolve(items);
    assert.equal(r.status, 'unresolved');
    assert.equal(r.verification, null);
    assert.equal(r.resolution, null);
    assert.equal(r.reason, null);
  });
  test('autoResolve output validates and merges through probe-core: zero dismissed, byVerification.backstop === applicable', () => {
    const items = uc.proposeConsiderations(LIST_ELEMENT);
    const report = uc.analyzeCoverage([LIST_ELEMENT], uc.autoResolve(items));
    assert.ok(report.items.every((it) => it.status !== 'dismissed'));
    assert.equal(report.coverage.resolved, report.coverage.applicable);
    assert.equal(report.coverage.byVerification.backstop, report.coverage.applicable);
  });
});

describe('ui-consideration-probe: partial-cue recall gap (confirm is load-bearing, not the heuristic — Goodhart)', () => {
  test('prose that trips only the form cue under-covers: heuristic categories are a STRICT SUBSET of the confirmed form+list union', () => {
    const [heuristic] = uc.proposeElements([PARTIAL_CUE_ELEMENT]);
    const [confirmed] = uc.proposeElements([{ ...PARTIAL_CUE_ELEMENT, elements: ['form', 'list-collection'] }]);
    assert.deepEqual(heuristic.kinds, ['form']); // prose only tripped 'form'
    const hSet = new Set(heuristic.categories);
    const cSet = new Set(confirmed.categories);
    for (const cat of hSet) assert.ok(cSet.has(cat), `heuristic category ${cat} must be in the confirmed union`);
    assert.ok(cSet.size > hSet.size, 'the confirmed union must strictly exceed the heuristic set — proving the confirm step recovers missed coverage');
  });
});

// ══ WIRE-02 (Phase 2, #1867) — the UI-SPEC section round-trips the shipped lift, backward-compat,
// idempotency. Typed returns only (this file carries no allow-test-rule header). The `## UI
// Considerations` section format is LOCKED by the shipped plan-phase `## UI Considerations` lift rule +
// probe-core `projectTruths`; these guards pin that the template documents the SAME format. ═════
describe('ui-consideration-probe WIRE-02: backward-compat + format-match + idempotency (SC4)', () => {
  test('projectTruths(undefined) and projectTruths([]) both === [] — an old UI-SPEC with no section lifts nothing, never throws (Hyrum SC4)', () => {
    assert.deepEqual(core.projectTruths(undefined), []);
    assert.deepEqual(core.projectTruths([]), []);
  });
  test('a mixed covered/backstop/unresolved considerations array projects to the exact plan-phase-lift shape, order preserved (format-match SC3)', () => {
    const input = ['Empty state renders the documented "No results" copy.', { statement: 'Overflowing long labels truncate with an ellipsis.', verification: 'backstop' }, 'Loading shows a skeleton for the results table.'];
    const out = core.projectTruths(input);
    assert.equal(out[0], input[0]);                                              // covered → bare string
    assert.deepEqual(out[1], { statement: input[1].statement, verification: 'backstop' }); // backstop → flat scalar
    assert.equal(out[2], input[2]);                                             // order preserved
  });
  test('proposeElements is deterministic — re-running the probe rewrites byte-stable rows, never duplicated (idempotency SC4)', () => {
    const els = [{ id: 'C1', text: 'A table listing all rows of results' }, { id: 'Z', text: 'xyzzy plugh' }];
    assert.deepEqual(uc.proposeElements(els), uc.proposeElements(els));
  });
});

// ══ #4657 — the text_en language channel (mirrors #3717/#4156 onto the UI adapter) ═════════
// UI_CUES are English word-boundary patterns; a non-English element classifies to zero kinds
// and lands in the #1110 unclassified soft signal. text_en carries the classifier-facing
// English translation — engine input, never user-facing output. (The ADR-550 amendment's
// record scopes to the edge adapter's Requirement; #4657 extends the same remedy shape to
// the UI Element.) classifyElement's own signature stays untouched; the text_en ?? text
// selection lives at the two classification call sites (proposeConsiderations, proposeElements).
describe('ui-consideration-probe: text_en language-aware classification (#4657)', () => {
  // The reproduction pair from the issue: Danish UI-SPEC prose + faithful English translations.
  const daList = 'En liste over projektorer med knapper til at forbinde og afbryde.';
  const daForm = 'En formular hvor brugeren indtaster IP-adresse og adgangskode.';
  const enList = 'A list of projectors with buttons to connect and disconnect.';
  const enForm = 'A form where the user enters IP address and password.';

  test('proposeConsiderations: text_en present is used for classification instead of text (failing-first regression)', () => {
    // text alone (non-English) classifies to zero kinds -> the unclassified sentinel.
    const nonEnglishOnly = uc.proposeConsiderations({ id: 'U1', text: daList });
    assert.deepEqual(nonEnglishOnly.map((c) => c.category), ['unclassified']);

    // text_en present -> classification runs against the English translation (list-collection
    // from "list", interactive-control from "buttons").
    const withTextEn = uc.proposeConsiderations({ id: 'U1', text: daList, text_en: enList });
    assert.deepEqual(
      withTextEn.map((c) => c.category),
      ['empty', 'loading', 'error', 'populated', 'partial', 'overflow', 'zero-one-many', 'long-text'],
    );
  });

  test('#4657: a non-English element with text_en classifies identically to its English equivalent', () => {
    for (const [da, en] of [[daList, enList], [daForm, enForm]]) {
      const englishOnly = uc.proposeConsiderations({ id: 'U1', text: en });
      const nonEnglishWithTranslation = uc.proposeConsiderations({ id: 'U1', text: da, text_en: en });
      assert.deepEqual(
        nonEnglishWithTranslation.map((c) => c.category),
        englishOnly.map((c) => c.category),
        `a translated non-English element must raise the same categories as the English original (${da})`,
      );
    }
  });

  test('proposeConsiderations: text_en absent falls back to text (back-compat — English projects unchanged)', () => {
    const withoutTextEn = uc.proposeConsiderations({ id: 'U1', text: enForm });
    assert.deepEqual(withoutTextEn.map((c) => c.category), ['empty', 'loading', 'error', 'partial', 'long-text']);
  });

  test('validateRequirement: text_en: null is treated as absent (no throw)', () => {
    assert.doesNotThrow(() => uc.validateRequirement({ id: 'U1', text: 'A results table', text_en: null }));
  });

  test('proposeConsiderations: text_en: null falls back to text', () => {
    const viaNull = uc.proposeConsiderations({ id: 'U1', text: enForm, text_en: null });
    assert.deepEqual(viaNull.map((c) => c.category), ['empty', 'loading', 'error', 'partial', 'long-text']);
  });

  test('validateRequirement: rejects empty-string text_en (?? does not catch \'\')', () => {
    // Nullish coalescing only falls back on null/undefined — an empty string would otherwise
    // win `text_en ?? text` and silently classify against '', degrading to zero kinds with no
    // signal (the exact fail-open #1110/#2773 exist to eliminate).
    assert.throws(
      () => uc.validateRequirement({ id: 'U1', text: daList, text_en: '' }),
      /text_en must be a non-empty string when present/i,
    );
  });

  test('validateRequirement: rejects whitespace-only text_en', () => {
    assert.throws(
      () => uc.validateRequirement({ id: 'U1', text: daList, text_en: '   ' }),
      /text_en must be a non-empty string when present/i,
    );
  });

  test('validateRequirement: rejects non-string text_en (number/array/object)', () => {
    for (const bad of [42, ['x'], {}]) {
      assert.throws(
        () => uc.validateRequirement({ id: 'U1', text: daList, text_en: bad }),
        /text_en must be a non-empty string when present/i,
      );
    }
  });

  test('validateRequirement: rejects empty text_en even when an elements override makes it unused', () => {
    // Validation is unconditional — it does not skip the text_en check just because the
    // authored-elements branch would never classify prose. Bad data fails closed regardless.
    assert.throws(
      () => uc.validateRequirement({ id: 'U1', text: daList, text_en: '', elements: ['form'] }),
      /text_en must be a non-empty string when present/i,
    );
  });

  test('proposeConsiderations: authored elements override still wins when text_en is also present', () => {
    // nav is an applicable element kind for loading, error, overflow AND long-text.
    const override = uc.proposeConsiderations({ id: 'U9', text: daList, text_en: enList, elements: ['nav'] });
    assert.deepEqual(override.map((c) => c.category), ['loading', 'error', 'overflow', 'long-text']);
  });

  test('proposeConsiderations: zero-cue text_en still surfaces the unclassified soft signal (#1110)', () => {
    const zeroCue = uc.proposeConsiderations({ id: 'U1', text: daForm, text_en: 'Purple elephant dreams.' });
    assert.deepEqual(zeroCue.map((c) => c.category), ['unclassified']);
  });

  test('proposeElements: kinds derive from text_en when present (confirm surface sees the translation)', () => {
    const [translated] = uc.proposeElements([{ id: 'U1', text: daList, text_en: enList }]);
    assert.deepEqual(translated.kinds, ['list-collection', 'interactive-control']);
    assert.equal(translated.unclassified, false);
    // and without text_en the same element stays on the unclassified path
    const [plain] = uc.proposeElements([{ id: 'U1', text: daList }]);
    assert.equal(plain.unclassified, true);
    assert.deepEqual(plain.kinds, []);
  });

  test('analyzeCoverage: the reproduction pair — Danish text + text_en yields the English report\'s categories', () => {
    const english = uc.analyzeCoverage([{ id: 'U1', text: enList }, { id: 'U2', text: enForm }]);
    const translated = uc.analyzeCoverage([{ id: 'U1', text: daList, text_en: enList }, { id: 'U2', text: daForm, text_en: enForm }]);
    assert.equal(translated.coverage.applicable, english.coverage.applicable);
    assert.equal(translated.coverage.unclassified, 0);
    assert.deepEqual(
      translated.items.map((c) => c.category),
      english.items.map((c) => c.category),
    );
  });

  test('CLI: elements file with text_en classifies through the built engine (exit 0, no unclassified)', (t) => {
    const dir = createTempDir('ui-probe-4657-');
    t.after(() => cleanup(dir));
    const elementsPath = path.join(dir, 'elements.json');
    fs.writeFileSync(elementsPath, JSON.stringify([
      { id: 'U1', text: daList, text_en: enList },
      { id: 'U2', text: daForm, text_en: enForm },
    ]));
    const r = runNode([BUILT_SCRIPT, elementsPath], { timeoutMs: PROBE_TIMEOUT_MS });
    throwIfFailed(r, `node ${BUILT_SCRIPT} ${elementsPath}`);
    const rep = JSON.parse(r.stdout);
    assert.equal(rep.coverage.unclassified, 0);
    assert.ok(rep.coverage.applicable > 0, 'translated elements must raise applicable categories');
  });
});

describe('ui-consideration-probe: decision-model fallthrough (261001-o30 D11 site #1)', () => {
  // D18 batch validator from the C1 engine: the fake decide rejects any request the real
  // engine would refuse, so the site cannot drift from the locked interface.
  const { validateRequest } = require(path.join(__dirname, '..', 'gsd-core', 'bin', 'lib', 'decision-model.cjs'));
  const KINDS = ['form', 'list-collection', 'nav', 'media', 'interactive-control', 'static-content'];

  const E1 = { id: 'E1', text: 'A table listing all rows of results' };
  const E2 = { id: 'E2', text: 'Formulario con campos para el nombre y la direccion del cliente' };

  /** A call-counting fake decide that validates D18 and answers per-id from `answerFor`. */
  function fakeDecide(answerFor) {
    const calls = [];
    const decide = (request) => {
      calls.push(request);
      const v = validateRequest(request);
      assert.equal(v.ok, true, `fake decide got an invalid D18 request: ${v.message}`);
      return {
        backend: 'openai-letter',
        model: 'fake-model',
        endpoint_host: '127.0.0.1:1234',
        min_confidence: 0.9,
        results: request.requests.map((r) => ({ id: r.id, answers: answerFor(r) })),
      };
    };
    return { decide, calls };
  }

  test('a zero-hit element keeps its unclassified row and gains a model_proposal annotation', () => {
    assert.equal(typeof uc.proposeCoverageWithDecisionModel, 'function');
    assert.notDeepEqual(uc.classifyElement(E1.text), [], 'E1 must be regex-labelled');
    assert.deepEqual(uc.classifyElement(E2.text), [], 'E2 must be a zero-hit element');
    const { decide, calls } = fakeDecide(() => ({
      form: { status: 'ok', answer: 'yes', p_yes: 0.95, confidence: 0.95 },
      'list-collection': { status: 'ok', answer: 'no', p_yes: 0.02, confidence: 0.98 },
      nav: { status: 'abstain', reason: 'low-confidence', confidence: 0.6 },
      media: { status: 'ok', answer: 'no', p_yes: 0.03, confidence: 0.97 },
      'interactive-control': { status: 'ok', answer: 'no', p_yes: 0.04, confidence: 0.96 },
      'static-content': { status: 'ok', answer: 'no', p_yes: 0.04, confidence: 0.96 },
    }));
    const base = uc.analyzeCoverage([E1, E2], []);
    const report = uc.proposeCoverageWithDecisionModel([E1, E2], { decide });
    assert.equal(calls.length, 1, 'exactly one decide call per run');
    assert.equal(calls[0].requests.length, 1, 'only the zero-hit element is asked');
    assert.equal(calls[0].requests[0].state, E2.text, 'state is the classified subject, verbatim');
    assert.deepEqual(report.items.filter((i) => i.requirement_id === 'E1'),
      base.items.filter((i) => i.requirement_id === 'E1'));
    const baseRow = base.items.find((i) => i.requirement_id === 'E2');
    const row = report.items.find((i) => i.requirement_id === 'E2');
    assert.equal(row.category, 'unclassified');
    const { model_proposal: mp, ...rest } = row;
    assert.deepEqual(rest, baseRow, 'every base field is kept');
    assert.deepEqual(mp, {
      labels: [{ label: 'form', decided_by: 'decided-by: decision-model (conf 0.95, backend openai-letter)' }],
      categories: uc.applicableCategories(['form']),
      confirm_with: { elements: ['form'] },
    });
    assert.deepEqual(report.coverage, base.coverage);
  });

  /** Answers where only the listed kinds are an ok yes (confidence 0.97). */
  const yesFor = (...kinds) => () => Object.fromEntries(KINDS.map((k) => [k, kinds.includes(k)
    ? { status: 'ok', answer: 'yes', p_yes: 0.97, confidence: 0.97 }
    : { status: 'ok', answer: 'no', p_yes: 0.02, confidence: 0.98 }]));

  test('a fully regex-labelled set, or an authored elements override, never calls decide', () => {
    for (const els of [
      [E1],
      [E1, { ...E2, elements: [] }],
      [E1, { ...E2, elements: ['media'] }],
    ]) {
      const { decide, calls } = fakeDecide(yesFor('media'));
      assert.deepEqual(uc.proposeCoverageWithDecisionModel(els, { decide }), uc.analyzeCoverage(els, []));
      assert.equal(calls.length, 0);
    }
  });

  test('an unusable decide response leaves the report equal to the no-model report', () => {
    const base = JSON.stringify(uc.analyzeCoverage([E1, E2], []));
    const allAbstain = Object.fromEntries(KINDS.map((k) => [k, { status: 'abstain', reason: 'low-confidence' }]));
    const responses = [
      null,
      'nope',
      42,
      {},
      { results: 'x' },
      { results: [{ answers: yesFor('media')() }] },
      { results: [{ id: 'r9', answers: yesFor('media')() }] },
      { results: [{ id: 'r0', answers: 'garbage' }] },
      { results: [{ id: '__proto__', answers: yesFor('media')() }] },
      { backend: 'x', results: [{ id: 'r0', answers: allAbstain }] },
      { backend: 'x', results: [{ id: 'r0', answers: yesFor()() }] },
    ];
    for (const response of responses) {
      const calls = [];
      const report = uc.proposeCoverageWithDecisionModel([E1, E2], { decide: (req) => { calls.push(req); return response; } });
      assert.equal(calls.length, 1);
      assert.equal(JSON.stringify(report), base, JSON.stringify(response));
    }
  });

  test('text_en is the request state when present', () => {
    const { decide, calls } = fakeDecide(yesFor());
    // text_en classifies (table, rows), so it is regex-labelled and not asked at all
    uc.proposeCoverageWithDecisionModel([{ id: 'E3', text: E2.text, text_en: E1.text }], { decide });
    assert.equal(calls.length, 0);
    const zero = { id: 'E4', text: E2.text, text_en: 'Zzz plugh frobnicate' };
    assert.deepEqual(uc.classifyElement(zero.text_en), []);
    uc.proposeCoverageWithDecisionModel([zero], { decide });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].requests[0].state, zero.text_en);
  });

  test('three zero-hit elements make one call with ids r0..r2; labels and categories follow vocabulary order', () => {
    const els = ['uno dos', 'tres cuatro', 'cinco seis'].map((text, i) => ({ id: `Z${i}`, text }));
    const { decide, calls } = fakeDecide(yesFor('media', 'form', 'nav'));
    const report = uc.proposeCoverageWithDecisionModel(els, { decide });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].requests.map((r) => r.id), ['r0', 'r1', 'r2']);
    assert.deepEqual(calls[0].requests.map((r) => r.state), ['uno dos', 'tres cuatro', 'cinco seis']);
    assert.deepEqual(report.items.map((i) => i.requirement_id), ['Z0', 'Z1', 'Z2']);
    for (const item of report.items) {
      assert.deepEqual(item.model_proposal.labels.map((l) => l.label), ['form', 'nav', 'media']);
      assert.deepEqual(item.model_proposal.categories, uc.applicableCategories(['form', 'nav', 'media']));
      assert.deepEqual(item.model_proposal.confirm_with, { elements: ['form', 'nav', 'media'] });
    }
  });

  test('every question the request carries is a fixed noul keyed by the UI_CUES keys', () => {
    assert.deepEqual(Object.keys(uc.UI_KIND_QUESTIONS), Object.keys(uc.UI_CUES));
    const plan = uc.planKindDecisions([E2]);
    assert.deepEqual(Object.keys(plan.request.requests[0].questions), Object.keys(uc.UI_CUES));
    for (const q of Object.values(uc.UI_KIND_QUESTIONS)) assert.equal(q.type, 'noul');
  });

  test('a large zero-hit set is capped so the batch stays inside the engine question limit', () => {
    const els = Array.from({ length: 80 }, (_, i) => ({ id: `Q${i}`, text: `zzz ${i}` }));
    const plan = uc.planKindDecisions(els);
    assert.ok(plan.request.requests.length * KINDS.length <= 256);
    assert.equal(validateRequest(plan.request).ok, true);
  });

  test('makeCliAnalyzer consults the model only on the proposal pass, never on the merge pass', () => {
    const els = [E1, E2];
    const { decide, calls } = fakeDecide(yesFor('media'));
    const merge = uc.makeCliAnalyzer(['node', 'ui-consideration-probe.cjs', 'els.json', 'res.json'], { decide });
    assert.deepEqual(merge(els, []), uc.analyzeCoverage(els, []));
    assert.equal(calls.length, 0);
    const proposal = uc.makeCliAnalyzer(['node', 'ui-consideration-probe.cjs', 'els.json'], { decide });
    const report = proposal(els, []);
    assert.equal(calls.length, 1);
    assert.ok(report.items.find((i) => i.requirement_id === 'E2').model_proposal);
  });

  test('proposeElements and autoResolve are unchanged, and autoResolve leaves an annotated unclassified row unresolved (#1110)', () => {
    const { decide } = fakeDecide(yesFor('media'));
    const report = uc.proposeCoverageWithDecisionModel([E1, E2], { decide });
    const row = report.items.find((i) => i.requirement_id === 'E2');
    assert.ok(row.model_proposal);
    const resolutions = uc.autoResolve(report.items);
    const resolved = resolutions.find((r) => r.requirement_id === 'E2');
    assert.equal(resolved.status, 'unresolved');
    assert.equal(resolved.verification, null);
    assert.equal(resolved.model_proposal, undefined);
    assert.deepEqual(uc.autoResolve(uc.analyzeCoverage([E1, E2], []).items), resolutions);
    assert.equal(uc.proposeElements([E1, E2]).find((p) => p.id === 'E2').unclassified, true);
  });

  test('a null decide (capability inactive) and a validation error behave as without the model', () => {
    assert.deepEqual(uc.proposeCoverageWithDecisionModel([E1, E2], { decide: null }), uc.analyzeCoverage([E1, E2], []));
    assert.throws(() => uc.proposeCoverageWithDecisionModel([E1, E1], { decide: null }), /duplicate element id/);
    assert.throws(() => uc.proposeCoverageWithDecisionModel('x', { decide: null }), /elements must be an array/);
  });

  test('privacy: a decide run writes no .gsd-trace.jsonl or any other file in the project', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-uc-priv-'));
    try {
      const { decide } = fakeDecide(yesFor('media'));
      uc.proposeCoverageWithDecisionModel([E1, E2], { decide, cwd: dir });
      assert.deepEqual(fs.readdirSync(dir), []);
    } finally { cleanup(dir); }
  });

  test('property: applying any decide response only ever annotates unclassified rows', () => {
    const fc = require('fast-check');
    const elArb = fc.uniqueArray(
      fc.record({
        id: fc.stringMatching(/^[A-Za-z][A-Za-z0-9_-]{0,8}$/),
        text: fc.oneof(
          fc.constantFrom('A table of rows', 'uno dos tres', 'zzz', 'A button', 'plugh'),
          fc.string({ minLength: 1 }).filter((t) => t.trim().length > 0)),
        elements: fc.option(fc.constantFrom([], ['media'], ['form', 'nav']), { nil: undefined }),
      }, { requiredKeys: ['id', 'text'] }),
      { selector: (r) => r.id, maxLength: 8 },
    );
    const answerArb = fc.oneof(
      fc.constant({ status: 'ok', answer: 'yes', p_yes: 0.99, confidence: 0.99 }),
      fc.constant({ status: 'ok', answer: 'no', p_yes: 0.01, confidence: 0.99 }),
      fc.constant({ status: 'abstain', reason: 'low-confidence' }),
      fc.anything(),
    );
    const responseArb = fc.oneof(
      fc.anything(),
      fc.record({
        backend: fc.oneof(fc.constant('openai-letter'), fc.anything()),
        results: fc.array(fc.record({
          id: fc.constantFrom('r0', 'r1', 'r2', 'r3', '__proto__', 'x'),
          answers: fc.dictionary(fc.constantFrom(...KINDS, '__proto__', 'constructor'), answerArb),
        }), { maxLength: 6 }),
      }),
    );
    fc.assert(fc.property(elArb, responseArb, (els, response) => {
      const base = uc.analyzeCoverage(els, []);
      const out = uc.applyKindDecisions(base, uc.planKindDecisions(els), response);
      assert.equal(out.items.length, base.items.length);
      assert.deepEqual(out.coverage, base.coverage);
      out.items.forEach((item, idx) => {
        const { model_proposal: mp, ...rest } = item;
        assert.deepEqual(rest, base.items[idx]);
        if (mp !== undefined) assert.equal(item.category, 'unclassified');
      });
    }), { numRuns: 100 });
  });

  test('subprocess: with decision_model enabled and a failing backend the CLI output equals the disabled run', async () => {
    const http = require('node:http');
    const { execFile } = require('node:child_process');
    const run = (dir, home, elFile) => new Promise((resolve) => {
      execFile(process.execPath, [BUILT_SCRIPT, elFile], {
        cwd: dir, timeout: PROBE_TIMEOUT_MS * 2, encoding: 'utf8',
        env: { ...process.env, HOME: home, USERPROFILE: home, GSD_HOME: home },
      }, (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr }));
    });
    let hits = 0;
    const server = http.createServer((req, res) => { hits += 1; req.resume(); res.statusCode = 500; res.end('no'); });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const dirs = [];
    try {
      const mk = (decisionModel) => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-uc-sub-'));
        const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-uc-home-'));
        dirs.push(dir, home);
        fs.mkdirSync(path.join(dir, '.planning'), { recursive: true });
        fs.writeFileSync(path.join(dir, '.planning', 'config.json'), JSON.stringify({ decision_model: decisionModel }));
        const elFile = path.join(dir, 'els.json');
        fs.writeFileSync(elFile, JSON.stringify([E1, E2]));
        return { dir, home, elFile };
      };
      const on = mk({ enabled: true, model: 'fake-model', base_url: `http://127.0.0.1:${server.address().port}`, timeout_ms: 2000 });
      const off = mk({ enabled: false });
      const withModel = await run(on.dir, on.home, on.elFile);
      const without = await run(off.dir, off.home, off.elFile);
      assert.equal(withModel.code, 0, withModel.stderr);
      assert.equal(without.code, 0, without.stderr);
      assert.equal(withModel.stdout, without.stdout);
      assert.ok(hits > 0, 'the enabled run reached the backend, so the active path is wired through decideSync');
      assert.deepEqual(JSON.parse(without.stdout), uc.analyzeCoverage([E1, E2], []));
    } finally {
      server.close();
      for (const d of dirs) cleanup(d);
    }
  });
});
