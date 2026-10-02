/**
 * Learnings Store Tests
 *
 * Tests for the global learnings CRUD library: write, read, list, query,
 * delete, dedup, empty store, malformed file handling, copyFromProject, prune.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  learningsWrite,
  learningsRead,
  learningsList,
  learningsQuery,
  learningsDelete,
  learningsCopyFromProject,
  learningsPrune,
  copyWithSameAsSuggestions,
  planSameAsDecisions,
  MAX_SAME_AS_PAIRS,
} = require('../gsd-core/bin/lib/learnings.cjs');
const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');

// ─── Test Helpers ────────────────────────────────────────────────────────────

/**
 * Create a unique temp directory for each test.
 * @returns {string}
 */
function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-learnings-test-'));
}

/**
 * Remove a directory recursively.
 * @param {string} dir
 */
function cleanupDir(dir) {
  cleanup(dir);
}

// ─── Write ───────────────────────────────────────────────────────────────────

describe('learningsWrite', () => {
  let storeDir;
  beforeEach(() => { storeDir = makeTempDir(); });
  afterEach(() => { cleanupDir(storeDir); });

  test('creates a learning file with all required fields', () => {
    const result = learningsWrite({
      source_project: 'test-project',
      learning: 'Always validate inputs before processing',
      context: 'security review',
      tags: ['security', 'validation'],
    }, { storeDir });

    assert.ok(result.id, 'should return an id');
    assert.strictEqual(result.created, true);
    assert.ok(result.content_hash, 'should return a content_hash');

    // Verify file exists and has correct structure
    const filePath = path.join(storeDir, `${result.id}.json`);
    assert.ok(fs.existsSync(filePath), 'file should exist on disk');

    const record = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    assert.strictEqual(record.id, result.id);
    assert.strictEqual(record.source_project, 'test-project');
    assert.strictEqual(record.learning, 'Always validate inputs before processing');
    assert.strictEqual(record.context, 'security review');
    assert.deepStrictEqual(record.tags, ['security', 'validation']);
    assert.strictEqual(record.content_hash, result.content_hash);
    assert.ok(record.date, 'should have a date');
  });

  test('creates store directory on first write', () => {
    const nestedDir = path.join(storeDir, 'nested', 'store');
    assert.ok(!fs.existsSync(nestedDir), 'dir should not exist yet');

    learningsWrite({
      source_project: 'test',
      learning: 'test learning',
    }, { storeDir: nestedDir });

    assert.ok(fs.existsSync(nestedDir), 'dir should be created on write');
  });

  test('defaults context to empty string and tags to empty array', () => {
    const result = learningsWrite({
      source_project: 'test',
      learning: 'minimal entry',
    }, { storeDir });

    const record = learningsRead(result.id, { storeDir });
    assert.strictEqual(record.context, '');
    assert.deepStrictEqual(record.tags, []);
  });
});

// ─── Deduplication ───────────────────────────────────────────────────────────

describe('deduplication', () => {
  let storeDir;
  beforeEach(() => { storeDir = makeTempDir(); });
  afterEach(() => { cleanupDir(storeDir); });

  test('same content from same project is not stored twice', () => {
    const entry = {
      source_project: 'my-project',
      learning: 'Use content hashing for dedup',
      tags: ['dedup'],
    };

    const first = learningsWrite(entry, { storeDir });
    const second = learningsWrite(entry, { storeDir });

    assert.strictEqual(first.created, true);
    assert.strictEqual(second.created, false);
    assert.strictEqual(first.content_hash, second.content_hash);
    assert.strictEqual(first.id, second.id);

    // Only one file on disk
    const files = fs.readdirSync(storeDir).filter(f => f.endsWith('.json'));
    assert.strictEqual(files.length, 1);
  });

  test('same learning from different projects creates separate entries', () => {
    const learning = 'Same learning text';

    const first = learningsWrite({
      source_project: 'project-a',
      learning,
    }, { storeDir });

    const second = learningsWrite({
      source_project: 'project-b',
      learning,
    }, { storeDir });

    assert.strictEqual(first.created, true);
    assert.strictEqual(second.created, true);
    assert.notStrictEqual(first.content_hash, second.content_hash);

    const files = fs.readdirSync(storeDir).filter(f => f.endsWith('.json'));
    assert.strictEqual(files.length, 2);
  });
});

// ─── Read ────────────────────────────────────────────────────────────────────

describe('learningsRead', () => {
  let storeDir;
  beforeEach(() => { storeDir = makeTempDir(); });
  afterEach(() => { cleanupDir(storeDir); });

  test('returns a learning by ID', () => {
    const { id } = learningsWrite({
      source_project: 'test',
      learning: 'readable entry',
      tags: ['read'],
    }, { storeDir });

    const record = learningsRead(id, { storeDir });
    assert.ok(record);
    assert.strictEqual(record.id, id);
    assert.strictEqual(record.learning, 'readable entry');
  });

  test('returns null for non-existent ID', () => {
    const record = learningsRead('does-not-exist', { storeDir });
    assert.strictEqual(record, null);
  });
});

// ─── List ────────────────────────────────────────────────────────────────────

describe('learningsList', () => {
  let storeDir;
  beforeEach(() => { storeDir = makeTempDir(); });
  afterEach(() => { cleanupDir(storeDir); });

  test('returns empty array for empty store', () => {
    const results = learningsList({ storeDir });
    assert.deepStrictEqual(results, []);
  });

  test('returns empty array when store dir does not exist', () => {
    const results = learningsList({ storeDir: path.join(storeDir, 'nonexistent') });
    assert.deepStrictEqual(results, []);
  });

  test('returns all learnings sorted by date (newest first)', () => {
    // Write three entries with controlled dates
    const id1 = learningsWrite({
      source_project: 'p1',
      learning: 'first',
    }, { storeDir }).id;

    // Manually adjust dates to control sort order
    const file1 = path.join(storeDir, `${id1}.json`);
    const rec1 = JSON.parse(fs.readFileSync(file1, 'utf-8'));
    rec1.date = '2025-01-01T00:00:00.000Z';
    fs.writeFileSync(file1, JSON.stringify(rec1));

    const id2 = learningsWrite({
      source_project: 'p2',
      learning: 'second',
    }, { storeDir }).id;

    const file2 = path.join(storeDir, `${id2}.json`);
    const rec2 = JSON.parse(fs.readFileSync(file2, 'utf-8'));
    rec2.date = '2025-06-15T00:00:00.000Z';
    fs.writeFileSync(file2, JSON.stringify(rec2));

    const id3 = learningsWrite({
      source_project: 'p3',
      learning: 'third',
    }, { storeDir }).id;

    const file3 = path.join(storeDir, `${id3}.json`);
    const rec3 = JSON.parse(fs.readFileSync(file3, 'utf-8'));
    rec3.date = '2025-03-10T00:00:00.000Z';
    fs.writeFileSync(file3, JSON.stringify(rec3));

    const results = learningsList({ storeDir });
    assert.strictEqual(results.length, 3);
    assert.strictEqual(results[0].learning, 'second');  // newest
    assert.strictEqual(results[1].learning, 'third');    // middle
    assert.strictEqual(results[2].learning, 'first');    // oldest
  });
});

// ─── Query ───────────────────────────────────────────────────────────────────

describe('learningsQuery', () => {
  let storeDir;
  beforeEach(() => { storeDir = makeTempDir(); });
  afterEach(() => { cleanupDir(storeDir); });

  test('filters by tag', () => {
    learningsWrite({
      source_project: 'p1',
      learning: 'auth lesson',
      tags: ['auth', 'security'],
    }, { storeDir });

    learningsWrite({
      source_project: 'p2',
      learning: 'ui lesson',
      tags: ['ui', 'css'],
    }, { storeDir });

    learningsWrite({
      source_project: 'p3',
      learning: 'auth pattern',
      tags: ['auth', 'patterns'],
    }, { storeDir });

    const results = learningsQuery({ tag: 'auth' }, { storeDir });
    assert.strictEqual(results.length, 2);
    assert.ok(results.every(r => r.tags.includes('auth')));
  });

  test('returns all when no tag filter', () => {
    learningsWrite({ source_project: 'p1', learning: 'a' }, { storeDir });
    learningsWrite({ source_project: 'p2', learning: 'b' }, { storeDir });

    const results = learningsQuery({}, { storeDir });
    assert.strictEqual(results.length, 2);
  });

  test('returns empty array when tag not found', () => {
    learningsWrite({
      source_project: 'p1',
      learning: 'something',
      tags: ['other'],
    }, { storeDir });

    const results = learningsQuery({ tag: 'nonexistent' }, { storeDir });
    assert.strictEqual(results.length, 0);
  });
});

// ─── Delete ──────────────────────────────────────────────────────────────────

describe('learningsDelete', () => {
  let storeDir;
  beforeEach(() => { storeDir = makeTempDir(); });
  afterEach(() => { cleanupDir(storeDir); });

  test('removes a learning by ID', () => {
    const { id } = learningsWrite({
      source_project: 'test',
      learning: 'to be deleted',
    }, { storeDir });

    assert.strictEqual(learningsDelete(id, { storeDir }), true);
    assert.strictEqual(learningsRead(id, { storeDir }), null);

    const files = fs.readdirSync(storeDir).filter(f => f.endsWith('.json'));
    assert.strictEqual(files.length, 0);
  });

  test('returns false for non-existent ID', () => {
    assert.strictEqual(learningsDelete('nonexistent', { storeDir }), false);
  });
});

// ─── Malformed File Handling ─────────────────────────────────────────────────

describe('malformed file handling', () => {
  let storeDir;
  beforeEach(() => { storeDir = makeTempDir(); });
  afterEach(() => { cleanupDir(storeDir); });

  test('list skips malformed JSON files with warning', () => {
    // Write a valid entry
    learningsWrite({
      source_project: 'test',
      learning: 'valid entry',
    }, { storeDir });

    // Write a malformed JSON file
    fs.writeFileSync(path.join(storeDir, 'bad-entry.json'), '{not valid json!!!', 'utf-8');

    const results = learningsList({ storeDir });
    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0].learning, 'valid entry');
  });

  test('write dedup check skips malformed files without crashing', () => {
    // Write a malformed JSON file first
    fs.writeFileSync(path.join(storeDir, 'corrupt.json'), 'corrupted!', 'utf-8');

    // Writing should still succeed
    const result = learningsWrite({
      source_project: 'test',
      learning: 'new entry after corrupt',
    }, { storeDir });

    assert.strictEqual(result.created, true);
  });
});

// ─── Copy From Project ───────────────────────────────────────────────────────

describe('learningsCopyFromProject', () => {
  let storeDir;
  let projectDir;

  beforeEach(() => {
    storeDir = makeTempDir();
    projectDir = makeTempDir();
  });
  afterEach(() => {
    cleanupDir(storeDir);
    cleanupDir(projectDir);
  });

  test('copies learnings from LEARNINGS.md into global store', () => {
    const learningsMd = `# Project Learnings

## Authentication Patterns
Always use OAuth2 for third-party auth.
Never store tokens in localStorage.

## Database Design
Normalize to 3NF unless read performance demands denormalization.

## Error Handling
Use custom error classes that extend Error.
`;
    fs.writeFileSync(path.join(projectDir, 'LEARNINGS.md'), learningsMd, 'utf-8');

    const result = learningsCopyFromProject(projectDir, {
      storeDir,
      sourceProject: 'my-app',
    });

    assert.strictEqual(result.created, 3);
    assert.strictEqual(result.skipped, 0);

    const all = learningsList({ storeDir });
    assert.strictEqual(all.length, 3);

    // Verify content was captured
    const learningTexts = all.map(r => r.learning);
    assert.ok(learningTexts.some(t => t.includes('OAuth2')));
    assert.ok(learningTexts.some(t => t.includes('Normalize to 3NF')));
    assert.ok(learningTexts.some(t => t.includes('custom error classes')));
  });

  test('deduplicates on second copy', () => {
    const learningsMd = `# Learnings

## Testing
Always write tests first.
`;
    fs.writeFileSync(path.join(projectDir, 'LEARNINGS.md'), learningsMd, 'utf-8');

    learningsCopyFromProject(projectDir, { storeDir, sourceProject: 'app' });
    const second = learningsCopyFromProject(projectDir, { storeDir, sourceProject: 'app' });

    assert.strictEqual(second.created, 0);
    assert.strictEqual(second.skipped, 1);

    const all = learningsList({ storeDir });
    assert.strictEqual(all.length, 1);
  });

  test('returns zero counts when LEARNINGS.md does not exist', () => {
    const result = learningsCopyFromProject(projectDir, { storeDir });
    assert.deepStrictEqual(result, { total: 0, created: 0, skipped: 0 });
  });

  test('skips sections with empty body', () => {
    const learningsMd = `# Learnings

## Empty Section

## Has Content
Real content here.
`;
    fs.writeFileSync(path.join(projectDir, 'LEARNINGS.md'), learningsMd, 'utf-8');

    const result = learningsCopyFromProject(projectDir, { storeDir, sourceProject: 'app' });
    assert.strictEqual(result.created, 1);

    const all = learningsList({ storeDir });
    assert.strictEqual(all.length, 1);
    assert.ok(all[0].learning.includes('Real content'));
  });
});

// ─── Prune ───────────────────────────────────────────────────────────────────

describe('learningsPrune', () => {
  let storeDir;
  beforeEach(() => { storeDir = makeTempDir(); });
  afterEach(() => { cleanupDir(storeDir); });

  test('removes entries older than threshold', () => {
    // Create an old entry
    const oldId = learningsWrite({
      source_project: 'old-project',
      learning: 'ancient wisdom',
    }, { storeDir }).id;

    // Backdate it to 100 days ago
    const oldFile = path.join(storeDir, `${oldId}.json`);
    const oldRec = JSON.parse(fs.readFileSync(oldFile, 'utf-8'));
    oldRec.date = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString();
    fs.writeFileSync(oldFile, JSON.stringify(oldRec));

    // Create a recent entry
    learningsWrite({
      source_project: 'new-project',
      learning: 'fresh knowledge',
    }, { storeDir });

    const result = learningsPrune('90d', { storeDir });
    assert.strictEqual(result.removed, 1);
    assert.strictEqual(result.kept, 1);

    const remaining = learningsList({ storeDir });
    assert.strictEqual(remaining.length, 1);
    assert.strictEqual(remaining[0].learning, 'fresh knowledge');
  });

  test('keeps all entries when none are old enough', () => {
    learningsWrite({ source_project: 'p', learning: 'recent' }, { storeDir });

    const result = learningsPrune('30d', { storeDir });
    assert.strictEqual(result.removed, 0);
    assert.strictEqual(result.kept, 1);
  });

  test('returns zeros when store does not exist', () => {
    const result = learningsPrune('90d', { storeDir: path.join(storeDir, 'nope') });
    assert.deepStrictEqual(result, { removed: 0, kept: 0 });
  });

  test('throws on invalid duration format', () => {
    assert.throws(
      () => learningsPrune('invalid', { storeDir }),
      /Invalid duration format/
    );
  });
});

// ─── CLI Integration ────────────────────────────────────────────────────────

describe('CLI integration', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = createTempProject(); });
  afterEach(() => { cleanup(tmpDir); });

  test('learnings list returns valid JSON', () => {
    const res = runGsdTools(['learnings', 'list'], tmpDir, { HOME: tmpDir });
    assert.strictEqual(res.success, true);
    const parsed = JSON.parse(res.output);
    assert.ok(Array.isArray(parsed.learnings));
    assert.strictEqual(typeof parsed.count, 'number');
  });

  test('learnings query --tag succeeds', () => {
    const res = runGsdTools(['learnings', 'query', '--tag', 'auth'], tmpDir, { HOME: tmpDir });
    assert.strictEqual(res.success, true);
    const parsed = JSON.parse(res.output);
    assert.ok(Array.isArray(parsed.learnings));
  });

  test('learnings prune with bad format exits non-zero', () => {
    const res = runGsdTools(['learnings', 'prune', '--older-than', 'badformat'], tmpDir, { HOME: tmpDir });
    assert.strictEqual(res.success, false);
    assert.ok(res.error.includes('Invalid duration format'));
  });

  test('learnings unknown subcommand exits non-zero', () => {
    const res = runGsdTools(['learnings', 'unknown'], tmpDir, { HOME: tmpDir });
    assert.strictEqual(res.success, false);
    assert.ok(res.error.includes('Unknown learnings subcommand'));
  });
});

// ─── Dedupe Scaling (#306) ───────────────────────────────────────────────────

/**
 * Build a LEARNINGS.md string with k unique ## sections.
 * Mirrors the ## heading format that learningsCopyFromProject parses.
 */
function makeLearningsMd(k) {
  const sections = [];
  for (let i = 1; i <= k; i++) {
    sections.push(`## Title ${i}\n\nBody content for item ${i}, unique text.`);
  }
  return `# Project Learnings\n\n${sections.join('\n\n')}\n`;
}

describe('learnings dedupe scaling (#306)', () => {
  test('store directory scan count is independent of imported item count', (t) => {
    // Test A: assert readdirSync call count does NOT scale with K (regression guard for #306)
    // BEFORE the fix: count scales 1:1 with K (one scan per learningsWrite call).
    // AFTER the fix: count is constant (one index-build scan per learningsCopyFromProject call).

    const storeDir2 = makeTempDir();
    const projectDir2 = makeTempDir();
    t.after(() => {
      cleanupDir(storeDir2);
      cleanupDir(projectDir2);
    });

    const storeDir6 = makeTempDir();
    const projectDir6 = makeTempDir();
    t.after(() => {
      cleanupDir(storeDir6);
      cleanupDir(projectDir6);
    });

    // K=2
    fs.writeFileSync(path.join(projectDir2, 'LEARNINGS.md'), makeLearningsMd(2), 'utf-8');
    const spy2 = t.mock.method(fs, 'readdirSync');
    const before2 = spy2.mock.calls.length;
    learningsCopyFromProject(projectDir2, { storeDir: storeDir2, sourceProject: 'proj-a' });
    const c1 = spy2.mock.calls.length - before2;
    spy2.mock.restore();

    // K=6
    fs.writeFileSync(path.join(projectDir6, 'LEARNINGS.md'), makeLearningsMd(6), 'utf-8');
    const spy6 = t.mock.method(fs, 'readdirSync');
    const before6 = spy6.mock.calls.length;
    learningsCopyFromProject(projectDir6, { storeDir: storeDir6, sourceProject: 'proj-b' });
    const c6 = spy6.mock.calls.length - before6;
    spy6.mock.restore();

    assert.strictEqual(c1, c6,
      `store directory scan count must be independent of imported item count (#306) — got ${c1} for K=2 vs ${c6} for K=6`);
  });

  test('dedupe semantics preserved: duplicate entry in existing store is skipped', (t) => {
    // Test B part 1: importing a section that duplicates an already-stored entry → skipped
    const storeDir = makeTempDir();
    const projectDir = makeTempDir();
    t.after(() => {
      cleanupDir(storeDir);
      cleanupDir(projectDir);
    });

    // Pre-seed one entry that matches the first section of our LEARNINGS.md
    learningsWrite({
      source_project: 'my-proj',
      learning: 'Body content for item 1, unique text.',
      context: 'Title 1',
      tags: ['title'],
    }, { storeDir });

    // LEARNINGS.md has 3 sections; section 1 duplicates the pre-seeded entry
    fs.writeFileSync(path.join(projectDir, 'LEARNINGS.md'), makeLearningsMd(3), 'utf-8');
    const result = learningsCopyFromProject(projectDir, { storeDir, sourceProject: 'my-proj' });

    assert.strictEqual(result.created, 2, 'two new sections should be created');
    assert.strictEqual(result.skipped, 1, 'one duplicate section should be skipped');

    const all = learningsList({ storeDir });
    assert.strictEqual(all.length, 3);
  });

  test('dedupe semantics preserved: two identical sections in same file → one created, one skipped', (t) => {
    // Test B part 2: exercises the index.set during-loop dedup path
    const storeDir = makeTempDir();
    const projectDir = makeTempDir();
    t.after(() => {
      cleanupDir(storeDir);
      cleanupDir(projectDir);
    });

    // Two identical ## sections in the same LEARNINGS.md
    const md = `# Learnings\n\n## Duplicate Section\n\nExact same body text.\n\n## Duplicate Section\n\nExact same body text.\n`;
    fs.writeFileSync(path.join(projectDir, 'LEARNINGS.md'), md, 'utf-8');

    const result = learningsCopyFromProject(projectDir, { storeDir, sourceProject: 'my-proj' });

    assert.strictEqual(result.created, 1, 'exactly one entry should be created');
    assert.strictEqual(result.skipped, 1, 'the duplicate should be skipped');

    const all = learningsList({ storeDir });
    assert.strictEqual(all.length, 1);
  });
});

// ─── #3683 — phase-scoped learnings source (path agreement + gated wiring) ──
//
// The extractor writes {PHASE_DIR}/{PADDED}-LEARNINGS.md; the copy command read
// only <root>/LEARNINGS.md (project root), so learnings.copy ALWAYS no-oped —
// the global-learnings store stayed empty even after manual extraction. The
// copy must discover the most recent phase-scoped artifact; the project-root
// path remains the fallback (legacy shape). Pins also cover the gated
// completion wiring in execute-phase.md and the registry/docs agreement.

describe('#3683 learnings copy source resolution', () => {
  let storeDir;
  let projectDir;

  beforeEach(() => {
    storeDir = makeTempDir();
    projectDir = makeTempDir();
  });
  afterEach(() => {
    cleanupDir(storeDir);
    cleanupDir(projectDir);
  });

  function writePhaseLearnings(phaseSlug, ageMinutes) {
    const phaseDir = path.join(projectDir, 'phases', phaseSlug);
    fs.mkdirSync(phaseDir, { recursive: true });
    const file = path.join(phaseDir, `${phaseSlug}-LEARNINGS.md`);
    fs.writeFileSync(file, `# Learnings\n\n## ${phaseSlug} Lesson\nBody for ${phaseSlug}.\n`, 'utf-8');
    const when = new Date(Date.now() - ageMinutes * 60 * 1000);
    fs.utimesSync(file, when, when);
    return file;
  }

  test('learnings copy reads the phase-scoped artifact', () => {
    writePhaseLearnings('1.0-discovery', 30);
    const result = learningsCopyFromProject(projectDir, { storeDir, sourceProject: 'app' });
    assert.strictEqual(result.created, 1, `phase-scoped artifact must be the copy source: ${JSON.stringify(result)}`);
    const all = learningsList({ storeDir });
    assert.ok(all.some((r) => r.learning.includes('Body for 1.0-discovery')), 'item body must land in learning');
  });

  test('learnings copy still reads the project-root artifact', () => {
    fs.writeFileSync(path.join(projectDir, 'LEARNINGS.md'), '# L\n\n## Root Lesson\nBody.\n', 'utf-8');
    const result = learningsCopyFromProject(projectDir, { storeDir, sourceProject: 'app' });
    assert.strictEqual(result.created, 1);
    assert.ok(learningsList({ storeDir }).some((r) => r.context === 'Root Lesson'), 'section title lands in context');
  });

  test('phase-scoped wins when both exist', () => {
    writePhaseLearnings('2.0-build', 10);
    fs.writeFileSync(path.join(projectDir, 'LEARNINGS.md'), '# L\n\n## Root Lesson\nBody.\n', 'utf-8');
    const result = learningsCopyFromProject(projectDir, { storeDir, sourceProject: 'app' });
    assert.strictEqual(result.created, 1);
    assert.ok(
      learningsList({ storeDir }).some((r) => r.learning.includes('Body for 2.0-build')),
      'the most recent phase artifact must win over the project-root file',
    );
  });

  test('learnings copy no-ops with no artifact', () => {
    const result = learningsCopyFromProject(projectDir, { storeDir, sourceProject: 'app' });
    assert.deepStrictEqual(result, { total: 0, created: 0, skipped: 0 });
  });

  test('learnings copy picks the most recent phase artifact', () => {
    writePhaseLearnings('1.0-discovery', 240); // older
    writePhaseLearnings('3.0-hardening', 5);   // newer
    const result = learningsCopyFromProject(projectDir, { storeDir, sourceProject: 'app' });
    assert.strictEqual(result.created, 1);
    assert.ok(learningsList({ storeDir }).some((r) => r.learning.includes('Body for 3.0-hardening')));
  });

  test('extractor-shaped artifact copies per-item entries, not category blobs', () => {
    // The real producer writes ## category sections containing ### items
    // (extract-learnings.md write_learnings). The copy must store each ###
    // item as its own learning — aggregating a category into one mega-entry
    // defeats the store's relevance contract (learnings.max_inject).
    const phaseDir = path.join(projectDir, 'phases', '4.0-real');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(
      path.join(phaseDir, '4.0-real-LEARNINGS.md'),
      [
        '# Phase 4 Learnings',
        '',
        '## Decisions',
        '',
        '### Use SQLite over Postgres',
        'Zero-ops for single-node deployments.',
        '',
        '### Pin the runner image',
        'Reproducible CI beats newest-libraries.',
        '',
        '## Surprises',
        '',
        '### npm dedupe changed lockfile',
        'Expected; audit after upgrades.',
        '',
      ].join('\n'),
      'utf-8',
    );
    const result = learningsCopyFromProject(projectDir, { storeDir, sourceProject: 'app' });
    assert.strictEqual(result.created, 3, 'each ### item must become one learning');
    const all = learningsList({ storeDir });
    // ### item TITLES land in context; their BODIES land in learning.
    assert.ok(all.some((r) => r.context === 'Use SQLite over Postgres' && r.learning.includes('Zero-ops')));
    assert.ok(all.some((r) => r.context === 'Pin the runner image' && r.learning.includes('Reproducible')));
    assert.ok(all.some((r) => r.context === 'npm dedupe changed lockfile' && r.learning.includes('audit')));
    for (const r of all) {
      assert.ok(r.learning.length < 200, 'entries must be item-scoped, not category blobs');
    }
  });

  test('malformed artifact yields no entries', () => {
    const phaseDir = path.join(projectDir, 'phases', '1.0-x');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '1.0-x-LEARNINGS.md'), 'no sections at all\n', 'utf-8');
    const result = learningsCopyFromProject(projectDir, { storeDir, sourceProject: 'app' });
    assert.strictEqual(result.created, 0);
  });
});

describe('#3683 completion wiring and registry pins', () => {
  const EXECUTE_PHASE = path.join(__dirname, '..', 'gsd-core', 'workflows', 'execute-phase.md');
  const REGISTRY = path.join(__dirname, '..', 'gsd-core', 'templates', 'README.md');
  const FEATURES = path.join(__dirname, '..', 'docs', 'FEATURES.md');

  test('execute-phase completion wires gated extraction', () => {
    const content = fs.readFileSync(EXECUTE_PHASE, 'utf-8');
    const stepStart = content.indexOf('<step name="auto_copy_learnings">');
    assert.ok(stepStart !== -1, 'auto_copy_learnings step must exist');
    const stepEnd = content.indexOf('</step>', stepStart);
    const step = content.slice(stepStart, stepEnd);
    assert.ok(
      /extract-learnings|extract_learnings/.test(step),
      'the gated step must invoke the extraction producer for the completed phase',
    );
    assert.ok(
      /must NOT block phase completion|does not block phase completion|non-fatal/i.test(step),
      'extraction failure must be explicitly non-fatal',
    );
    // Gate-first ordering: the disabled skip must precede the extraction wiring
    // so disabled runs stay byte-identical.
    const gateIdx = step.indexOf('GL_ENABLED');
    const extractIdx = step.search(/Run the .extract[-_]learnings. workflow/);
    assert.ok(gateIdx !== -1 && extractIdx !== -1 && gateIdx < extractIdx, 'gate check must precede extraction');
  });

  test('registry producer attribution is gated', () => {
    const registry = fs.readFileSync(REGISTRY, 'utf-8');
    const splitLines = require('../gsd-core/bin/lib/text-lines.cjs').splitLines;
    const row = splitLines(registry).find((l) => l.includes('LEARNINGS.md'));
    assert.ok(row, 'registry must carry a LEARNINGS.md row');
    assert.ok(
      /global_learnings|gated/i.test(row),
      `producer attribution must state the gate: ${row}`,
    );
  });

  test('features doc agrees with the registry', () => {
    const features = fs.readFileSync(FEATURES, 'utf-8');
    // Anchor on the SECTION HEADING — the TOC also mentions extract-learnings
    // ~2400 chars earlier and its window contains neither keyword.
    const heading = features.search(/##+\s*\d*\d*\.?\s*Extract Learnings/i);
    assert.ok(heading !== -1, 'FEATURES.md must have an Extract Learnings section');
    const section = features.slice(heading, heading + 4000);
    assert.ok(
      /global_learnings|automatically/i.test(section),
      'the learnings feature section must acknowledge the gated automatic path',
    );
  });
});

// ─── Decision-model same-as suggestions (261001-o30 D11 site #9) ─────────────

const SAME_LINE = 'decided-by: decision-model (conf 0.90, backend openai-letter)';

/** A call-counting fake decide that validates the batch shape; `answerFor(id, request)` picks each answer. */
function fakeSameDecide(answerFor) {
  const calls = [];
  const fn = (request) => {
    calls.push(request);
    return {
      backend: 'openai-letter',
      model: 'fake',
      results: request.requests.map((r) => ({ id: r.id, answers: { same: answerFor(r.id, r) } })),
    };
  };
  fn.calls = calls;
  return fn;
}
const OK_YES = () => ({ status: 'ok', answer: 'yes', p_yes: 0.9, confidence: 0.9 });

describe('copyWithSameAsSuggestions (decision-model fallthrough, 261001-o30 D11 site #9)', () => {
  let storeDir;
  let projectDir;
  beforeEach(() => {
    storeDir = makeTempDir();
    projectDir = makeTempDir();
  });
  afterEach(() => {
    cleanupDir(storeDir);
    cleanupDir(projectDir);
  });

  const md = (items) => `# Learnings\n\n## Lessons\n\n${items.map(([t, b]) => `### ${t}\n${b}`).join('\n\n')}\n`;
  // WR-04: the same lesson in other words, sharing only "network" with the seeded record
  // (Jaccard 1/21), so the lexical method misses it and the model is asked.
  const NEAR_MISS = md([['Network retries', 'When a remote request fails, wait longer before each new attempt and add randomness']]);
  const storeBytes = () => Object.fromEntries(
    fs.readdirSync(storeDir).map((f) => [f, fs.readFileSync(path.join(storeDir, f), 'utf-8')]),
  );

  test('a paraphrase of a stored learning gets a same_as suggestion and no store file changes', () => {
    assert.strictEqual(typeof copyWithSameAsSuggestions, 'function');
    const l1 = learningsWrite({
      source_project: 'other',
      context: 'Retry policy for flaky network calls',
      learning: 'Retry network calls with exponential backoff and jitter',
    }, { storeDir });
    const before = storeBytes();
    fs.writeFileSync(path.join(projectDir, 'LEARNINGS.md'), NEAR_MISS, 'utf-8');

    const decide = fakeSameDecide(OK_YES);
    const result = copyWithSameAsSuggestions(projectDir, { storeDir, sourceProject: 'app', decide });

    assert.strictEqual(decide.calls.length, 1);
    assert.strictEqual(decide.calls[0].requests.length, 1);
    assert.deepStrictEqual(Object.keys(decide.calls[0].requests[0].questions), ['same']);
    const added = learningsList({ storeDir }).find((r) => r.id !== l1.id);
    assert.ok(added, 'the new learning is still written');
    assert.deepStrictEqual(result, {
      total: 1, created: 1, skipped: 0,
      same_as_suggestions: [{ id: added.id, same_as: l1.id, decided_by: SAME_LINE }],
    });
    const after = storeBytes();
    assert.strictEqual(after[`${l1.id}.json`], before[`${l1.id}.json`]);
    assert.deepStrictEqual(Object.keys(after).sort(), [`${l1.id}.json`, `${added.id}.json`].sort());
    assert.deepStrictEqual(Object.keys(JSON.parse(after[`${added.id}.json`])).sort(),
      ['content_hash', 'context', 'date', 'id', 'learning', 'source_project', 'tags']);
    assert.strictEqual(fs.existsSync(path.join(projectDir, '.gsd-trace.jsonl')), false);
    assert.strictEqual(fs.existsSync(path.join(storeDir, '.gsd-trace.jsonl')), false);
  });

  const seed = () => learningsWrite({
    source_project: 'other',
    context: 'Retry policy for flaky network calls',
    learning: 'Retry network calls with exponential backoff and jitter',
  }, { storeDir });
  const PARAPHRASE = NEAR_MISS;
  // Jaccard 5/13 with the seeded record: graduation.md already clusters this pair.
  const LEXICAL_DUP = md([['Network retries', 'Use jitter and exponential backoff when retrying a flaky network call']]);
  const plainCounts = (r) => ({ total: r.total, created: r.created, skipped: r.skipped });

  test('an exact content-hash duplicate is still skipped and counted, and never asks the model', () => {
    fs.writeFileSync(path.join(projectDir, 'LEARNINGS.md'), PARAPHRASE, 'utf-8');
    learningsCopyFromProject(projectDir, { storeDir, sourceProject: 'app' });
    seed();
    const decide = fakeSameDecide(OK_YES);
    const second = copyWithSameAsSuggestions(projectDir, { storeDir, sourceProject: 'app', decide });
    assert.deepStrictEqual(second, { total: 1, created: 0, skipped: 1 });
    assert.strictEqual(decide.calls.length, 0);
    assert.strictEqual(learningsList({ storeDir }).length, 2);
  });

  test('WR-04: a pair the lexical method already clusters (Jaccard >= 0.25) is never asked about', () => {
    seed();
    fs.writeFileSync(path.join(projectDir, 'LEARNINGS.md'), LEXICAL_DUP, 'utf-8');
    const decide = fakeSameDecide(OK_YES);
    assert.deepStrictEqual(copyWithSameAsSuggestions(projectDir, { storeDir, sourceProject: 'app', decide }), { total: 1, created: 1, skipped: 0 });
    assert.strictEqual(decide.calls.length, 0);
  });

  test('no pre-existing candidate: no call and the result has no new keys', () => {
    fs.writeFileSync(path.join(projectDir, 'LEARNINGS.md'), md([['A', 'alpha beta gamma'], ['B', 'alpha beta gamma delta']]), 'utf-8');
    const decide = fakeSameDecide(OK_YES);
    const result = copyWithSameAsSuggestions(projectDir, { storeDir, sourceProject: 'app', decide });
    assert.deepStrictEqual(result, { total: 2, created: 2, skipped: 0 });
    assert.strictEqual(decide.calls.length, 0);
  });

  test('no LEARNINGS.md: zero counts, no call', () => {
    const decide = fakeSameDecide(OK_YES);
    assert.deepStrictEqual(copyWithSameAsSuggestions(projectDir, { storeDir, decide }), { total: 0, created: 0, skipped: 0 });
    assert.strictEqual(decide.calls.length, 0);
  });

  test('an existing store with no lexical overlap makes no call', () => {
    learningsWrite({ source_project: 'other', context: 'zzz', learning: 'qqq www' }, { storeDir });
    fs.writeFileSync(path.join(projectDir, 'LEARNINGS.md'), md([['Network retries', 'jitter backoff']]), 'utf-8');
    const decide = fakeSameDecide(OK_YES);
    assert.deepStrictEqual(copyWithSameAsSuggestions(projectDir, { storeDir, sourceProject: 'app', decide }), { total: 1, created: 1, skipped: 0 });
    assert.strictEqual(decide.calls.length, 0);
  });

  test('decide null (capability inactive) is exactly learningsCopyFromProject, byte for byte', () => {
    seed();
    fs.writeFileSync(path.join(projectDir, 'LEARNINGS.md'), PARAPHRASE, 'utf-8');
    const result = copyWithSameAsSuggestions(projectDir, { storeDir, sourceProject: 'app', decide: null });
    assert.deepStrictEqual(Object.keys(result), ['total', 'created', 'skipped']);
    assert.deepStrictEqual(result, { total: 1, created: 1, skipped: 0 });
  });

  test('abstain, no-answers, null and garbage responses leave the plain result with no new keys', () => {
    seed();
    fs.writeFileSync(path.join(projectDir, 'LEARNINGS.md'), PARAPHRASE, 'utf-8');
    const decides = [
      () => ({ results: [{ id: 'p0', answers: { same: { status: 'abstain', reason: 'low-confidence', confidence: 0.4 } } }] }),
      () => ({ results: [{ id: 'p0', answers: { same: { status: 'ok', answer: 'no', confidence: 0.99 } } }] }),
      () => null, () => 'x', () => ({}), () => ({ results: [{ id: 'p0' }] }),
      () => ({ results: [{ id: '__proto__', answers: { same: { status: 'ok', answer: 'yes', confidence: 1 } } }] }),
      () => ({ results: [{ id: 'p0', answers: { same: { status: 'abstain' } } }] }),
    ];
    let n = 0;
    for (const decide of decides) {
      // A fresh store/project per attempt, because the first copy would otherwise dedupe the second.
      const sd = makeTempDir();
      const pd = makeTempDir();
      try {
        learningsWrite({ source_project: 'other', context: 'Retry policy for flaky network calls', learning: 'Retry network calls with exponential backoff and jitter' }, { storeDir: sd });
        fs.writeFileSync(path.join(pd, 'LEARNINGS.md'), PARAPHRASE, 'utf-8');
        const result = copyWithSameAsSuggestions(pd, { storeDir: sd, sourceProject: 'app', decide });
        assert.deepStrictEqual(Object.keys(result), ['total', 'created', 'skipped'], `response #${n}`);
      } finally { cleanupDir(sd); cleanupDir(pd); n++; }
    }
  });

  test('over the cap: 24 pairs go in one call and the overflow is reported once a pair is answered ok', () => {
    learningsWrite({ source_project: 'other', context: 'E1', learning: 'alpha beta gamma' }, { storeDir });
    learningsWrite({ source_project: 'other', context: 'E2', learning: 'alpha beta delta' }, { storeDir });
    const items = [];
    for (let i = 0; i < 13; i++) items.push([`New ${i}`, `alpha beta unique${i}x extra words`]);
    fs.writeFileSync(path.join(projectDir, 'LEARNINGS.md'), md(items), 'utf-8');
    const no = fakeSameDecide(() => ({ status: 'ok', answer: 'no', p_yes: 0.05, confidence: 0.95 }));
    const result = copyWithSameAsSuggestions(projectDir, { storeDir, sourceProject: 'app', decide: no });
    assert.strictEqual(no.calls.length, 1);
    assert.strictEqual(no.calls[0].requests.length, MAX_SAME_AS_PAIRS);
    assert.deepStrictEqual(no.calls[0].requests.map((r) => r.id), Array.from({ length: 24 }, (_, i) => `p${i}`));
    assert.strictEqual(result.created, 13);
    assert.strictEqual(result.same_as_unchecked, 2);
    assert.strictEqual('same_as_suggestions' in result, false);
  });

  test('over the cap with only abstain answers carries no same_as_unchecked key', () => {
    learningsWrite({ source_project: 'other', context: 'E1', learning: 'alpha beta gamma' }, { storeDir });
    learningsWrite({ source_project: 'other', context: 'E2', learning: 'alpha beta delta' }, { storeDir });
    const items = [];
    for (let i = 0; i < 13; i++) items.push([`New ${i}`, `alpha beta unique${i}x extra words`]);
    fs.writeFileSync(path.join(projectDir, 'LEARNINGS.md'), md(items), 'utf-8');
    const abstain = fakeSameDecide(() => ({ status: 'abstain', reason: 'unreachable' }));
    const result = copyWithSameAsSuggestions(projectDir, { storeDir, sourceProject: 'app', decide: abstain });
    assert.strictEqual(abstain.calls.length, 1);
    assert.deepStrictEqual(Object.keys(result), ['total', 'created', 'skipped']);
  });

  test('a yes answer for only some pairs suggests exactly those, in ranked order', () => {
    const l1 = seed();
    fs.writeFileSync(path.join(projectDir, 'LEARNINGS.md'), PARAPHRASE, 'utf-8');
    const decide = fakeSameDecide((id) => (id === 'p0'
      ? { status: 'ok', answer: 'yes', p_yes: 0.99, confidence: 0.99 }
      : { status: 'ok', answer: 'no', p_yes: 0.01, confidence: 0.99 }));
    const result = copyWithSameAsSuggestions(projectDir, { storeDir, sourceProject: 'app', decide });
    assert.strictEqual(result.same_as_suggestions.length, 1);
    assert.strictEqual(result.same_as_suggestions[0].same_as, l1.id);
    assert.strictEqual(result.same_as_suggestions[0].decided_by, 'decided-by: decision-model (conf 0.99, backend openai-letter)');
  });

  test('every store file is byte-identical across the suggestion step and no trace file appears', () => {
    seed();
    fs.writeFileSync(path.join(projectDir, 'LEARNINGS.md'), PARAPHRASE, 'utf-8');
    const noModel = makeTempDir();
    try {
      const seeded = learningsList({ storeDir });
      for (const r of seeded) fs.writeFileSync(path.join(noModel, `${r.id}.json`), JSON.stringify(r, null, 2));
      const withModel = copyWithSameAsSuggestions(projectDir, { storeDir, sourceProject: 'app', decide: fakeSameDecide(OK_YES) });
      const plain = learningsCopyFromProject(projectDir, { storeDir: noModel, sourceProject: 'app' });
      assert.deepStrictEqual(plainCounts(withModel), plain);
      const norm = (dir) => fs.readdirSync(dir).map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8')))
        .map((r) => { const copy = { ...r }; delete copy.id; delete copy.date; return copy; }).sort((a, b) => a.content_hash.localeCompare(b.content_hash));
      assert.deepStrictEqual(norm(storeDir), norm(noModel));
      assert.deepStrictEqual(fs.readdirSync(storeDir).filter((f) => !f.endsWith('.json')), []);
    } finally { cleanupDir(noModel); }
  });
});

describe('planSameAsDecisions (pure planner)', () => {
  const rec = (id, context, learning) => ({
    id, source_project: 'p', date: '2026-01-01T00:00:00.000Z', context, learning, tags: [], content_hash: `h-${id}`,
  });

  test('null for no created learnings, no existing ones, or no lexical overlap', () => {
    assert.strictEqual(planSameAsDecisions([], [rec('e1', 'x', 'y')]), null);
    assert.strictEqual(planSameAsDecisions([rec('c1', 'x', 'y')], []), null);
    assert.strictEqual(planSameAsDecisions([rec('c1', 'alpha', 'beta')], [rec('e1', 'gamma', 'delta')]), null);
    assert.strictEqual(planSameAsDecisions([rec('c1', 'the', 'a an')], [rec('e1', 'the', 'a an')]), null, 'stop words only carry no tokens');
  });

  test('top two near-misses by Jaccard, ties by existing id ascending, never a created record or itself', () => {
    // c1 / c2 tokens {x, y}. e1 {x, y, z} is 2/3 and e5 {x, k} is 1/3: both lexical hits, never asked.
    // e2 {x, z, w} and e4 {x, z, v} are 1/4: also a hit. e3 {x, p, q, r} and e6 {x, s, t, u} are 1/5.
    const created = [rec('c1', 'x', 'y'), rec('c2', 'x', 'y')];
    const existing = [
      rec('e1', 'x y', 'z'), rec('e5', 'x', 'k'), rec('e2', 'x z', 'w'), rec('e4', 'x z', 'v'),
      rec('e6', 'x s', 't u'), rec('e3', 'x p', 'q r'), rec('e7', 'm', 'n'), created[0], created[1],
    ];
    const plan = planSameAsDecisions(created, existing);
    assert.deepStrictEqual(plan.pairs, [
      { id: 'c1', same_as: 'e3' }, { id: 'c1', same_as: 'e6' },
      { id: 'c2', same_as: 'e3' }, { id: 'c2', same_as: 'e6' },
    ]);
    assert.strictEqual(plan.unchecked, 0);
    assert.deepStrictEqual(plan.request.requests.map((r) => r.id), ['p0', 'p1', 'p2', 'p3']);
    for (const pair of plan.pairs) assert.ok(!['c1', 'c2'].includes(pair.same_as));
  });

  test('ranked by Jaccard descending, state is the fixed two-part text, capped at 24 with the overflow counted', () => {
    const created = [];
    for (let i = 0; i < 13; i++) created.push(rec(`c${String(i).padStart(2, '0')}`, 'alpha beta', `u${i} v${i} w${i}`));
    const existing = [rec('e1', 'alpha', 'gamma delta epsilon'), rec('e2', 'alpha', 'zeta eta theta')];
    const plan = planSameAsDecisions(created, existing);
    assert.strictEqual(plan.pairs.length, 24);
    assert.strictEqual(plan.unchecked, 2);
    assert.deepStrictEqual(plan.pairs.slice(0, 3), [
      { id: 'c00', same_as: 'e1' }, { id: 'c00', same_as: 'e2' }, { id: 'c01', same_as: 'e1' },
    ]);
    assert.strictEqual(plan.request.requests[0].state, 'Learning A:\nalpha beta\nu0 v0 w0\n\nLearning B:\nalpha\ngamma delta epsilon');
    assert.strictEqual(plan.request.requests[0].questions.same.type, 'noul');
    assert.ok(Object.isFrozen(plan.request.requests[0].questions.same));
  });

  test('WR-04: near-misses rank by overlap descending, so a pair just under 0.25 comes first, whatever the id order', () => {
    // c2 {w, b} vs e2 {b, c, d, e} is 1/5; c1 {w, f} shares nothing with e2 and only 1/10 with e1.
    // ("a" is a graduation.md stop word, so these fixtures use "w".)
    const created = [rec('c1', 'w', 'f'), rec('c2', 'w', 'b')];
    const existing = [rec('e1', 'w g h', 'i j k l m n'), rec('e2', 'b c', 'd e')];
    const plan = planSameAsDecisions(created, existing);
    assert.deepStrictEqual(plan.pairs[0], { id: 'c2', same_as: 'e2' });
  });

  test('WR-05: malformed or legacy store records are skipped, and "undefined" is never tokenized or sent', () => {
    // A JS lesson that legitimately mentions "undefined": every malformed record below would
    // tokenize to "undefined" and pair with it under the old planner.
    const c1 = rec('c1', 'Null checks', 'Guard against undefined values');
    const malformed = [
      { id: 'm1', context: 'x' },                      // no learning
      { id: 'm2', context: 'y', learning: 5 },          // non-string learning
      { id: 'm3' },                                     // neither field
      { id: 'm4', context: 42, learning: 'guard' },     // non-string context
      { context: 'z', learning: 'undefined guard' },    // no id
      'a bare JSON string',
      7,
      null,
    ];
    assert.strictEqual(planSameAsDecisions([c1], malformed), null);
    const valid = rec('v1', 'Null defaults', 'Give every optional field an explicit fallback value');
    const plan = planSameAsDecisions([c1, { id: 'c2', context: 'q' }], [...malformed, valid]);
    assert.deepStrictEqual(plan.pairs, [{ id: 'c1', same_as: 'v1' }]);
    const noLiteralUndefined = (p) => p.request.requests.every((r) => r.state.split('\n').every((line) => line !== 'undefined'));
    assert.ok(noLiteralUndefined(plan));
    // A record without context (context is optional) is planned with an empty context line.
    const noContext = planSameAsDecisions([rec('c3', undefined, 'Null guards for missing values')], [valid]);
    assert.ok(noContext !== null);
    assert.ok(noLiteralUndefined(noContext), noContext.request.requests[0].state);
  });

  test('WR-04: the 0.25 boundary itself is a lexical hit; just below it is asked', () => {
    // {w, b} vs {w, c, d} is exactly 1/4; {w, b} vs {w, c, d, e} is 1/5.
    assert.strictEqual(planSameAsDecisions([rec('c1', 'w', 'b')], [rec('e1', 'w c', 'd')]), null);
    assert.deepStrictEqual(planSameAsDecisions([rec('c1', 'w', 'b')], [rec('e1', 'w c', 'd e')]).pairs, [{ id: 'c1', same_as: 'e1' }]);
  });
});

describe('learnings copy CLI stays deterministic off or unreachable (261001-o30 D11 site #9)', () => {
  const cleanups = [];
  afterEach(() => { while (cleanups.length) cleanup(cleanups.pop()); });

  function copyIn(decisionModel, seedStore) {
    const dir = createTempProject();
    const home = makeTempDir();
    cleanups.push(dir, home);
    fs.writeFileSync(path.join(dir, '.planning', 'config.json'), JSON.stringify({ decision_model: decisionModel }));
    fs.writeFileSync(path.join(dir, '.planning', 'LEARNINGS.md'),
      '# L\n\n## Lessons\n\n### Network retries\nUse jitter and exponential backoff when retrying a flaky network call\n');
    if (seedStore) {
      learningsWrite({
        source_project: 'other',
        context: 'Retry policy for flaky network calls',
        learning: 'Retry network calls with exponential backoff and jitter',
      }, { storeDir: path.join(home, '.gsd', 'knowledge') });
    }
    const res = runGsdTools(['learnings', 'copy'], dir, { HOME: home, USERPROFILE: home, GSD_HOME: home });
    return { res, dir };
  }

  test('WR-01: with the capability off, each malformed store file is warned about once, as without the model', () => {
    const { runNode } = require('./helpers/process-seam.cjs');
    const { PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
    const { TEST_ENV_BASE } = require('./helpers.cjs');
    const dir = createTempProject();
    const home = makeTempDir();
    cleanups.push(dir, home);
    fs.writeFileSync(path.join(dir, '.planning', 'config.json'), '{}');
    fs.writeFileSync(path.join(dir, '.planning', 'LEARNINGS.md'),
      '# L\n\n## Lessons\n\n### Network retries\nUse jitter and exponential backoff when retrying a flaky network call\n');
    const store = path.join(home, '.gsd', 'knowledge');
    learningsWrite({
      source_project: 'other',
      context: 'Retry policy for flaky network calls',
      learning: 'Retry network calls with exponential backoff and jitter',
    }, { storeDir: store });
    fs.writeFileSync(path.join(store, 'zz-00.json'), '{ not json');
    const r = runNode([path.join(__dirname, '..', 'gsd-core', 'bin', 'gsd-tools.cjs'), 'learnings', 'copy'], {
      cwd: dir,
      env: { ...process.env, ...TEST_ENV_BASE, HOME: home, USERPROFILE: home, GSD_HOME: home },
      timeoutMs: PROBE_TIMEOUT_MS,
    });
    assert.strictEqual(r.exitCode, 0, r.stderr);
    assert.deepStrictEqual(JSON.parse(r.stdout), { total: 1, created: 1, skipped: 0 });
    const warnings = r.stderr.split('\n').filter((l) => l.startsWith('Warning: skipping malformed file') && l.includes('zz-00.json'));
    assert.strictEqual(warnings.length, 1, r.stderr);
  });

  test('decision_model disabled prints exactly { total, created, skipped }', () => {
    const { res, dir } = copyIn({ enabled: false }, true);
    assert.strictEqual(res.success, true, res.error);
    assert.deepStrictEqual(JSON.parse(res.output), { total: 1, created: 1, skipped: 0 });
    assert.strictEqual(fs.existsSync(path.join(dir, '.gsd-trace.jsonl')), false);
  });

  /** `learnings copy` against a stub, with a near-miss pair so the model is asked; async so the stub can answer. */
  async function copyWithStub(pick) {
    const { startLetterStub, makeDecisionProject, runNodeAsync } = require('./helpers/decision-model-stub.cjs');
    const { PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
    const { TEST_ENV_BASE } = require('./helpers.cjs');
    const stub = await startLetterStub(pick);
    const p = makeDecisionProject(
      { decision_model: { enabled: true, model: 'fake-model', base_url: stub.url, timeout_ms: 2000 } },
      { '.planning/LEARNINGS.md': '# L\n\n## Lessons\n\n### Network retries\nWhen a remote request fails, wait longer before each new attempt and add randomness\n' },
    );
    try {
      learningsWrite({
        source_project: 'other',
        context: 'Retry policy for flaky network calls',
        learning: 'Retry network calls with exponential backoff and jitter',
      }, { storeDir: path.join(p.home, '.gsd', 'knowledge') });
      const r = await runNodeAsync([path.join(__dirname, '..', 'gsd-core', 'bin', 'gsd-tools.cjs'), 'learnings', 'copy'],
        { cwd: p.dir, env: { ...p.env, ...TEST_ENV_BASE }, timeout: PROBE_TIMEOUT_MS });
      return { ...r, hits: stub.hits };
    } finally {
      await stub.close();
      p.cleanup();
    }
  }

  test('decision_model enabled against a failing backend prints the identical payload, and the backend was reached', async () => {
    const r = await copyWithStub(() => ({ status: 500, body: 'no' }));
    assert.strictEqual(r.code, 0, r.stderr);
    assert.strictEqual(r.hits, 1, 'the enabled run reached the backend, so learnings copy is wired to the model path');
    assert.deepStrictEqual(JSON.parse(r.stdout), { total: 1, created: 1, skipped: 0 });
  });

  test('decision_model enabled and answering yes: the CLI prints a same_as suggestion end to end', async () => {
    const r = await copyWithStub(() => 'yes');
    assert.strictEqual(r.code, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.deepStrictEqual({ total: out.total, created: out.created, skipped: out.skipped }, { total: 1, created: 1, skipped: 0 });
    assert.strictEqual(out.same_as_suggestions.length, 1);
    assert.match(out.same_as_suggestions[0].decided_by, /^decided-by: decision-model \(conf \d\.\d\d, backend openai-letter\)$/);
  });
});
