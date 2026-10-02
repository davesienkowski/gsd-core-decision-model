/**
 * Prose contract for the optional decision-model blocks (quick 261001-x02; CONTEXT D11, D12, D14, D18, D19, D21).
 *
 * The decision-model capability is wired into workflow, reference and template prose as short fenced blocks that
 * cite ONE shared reference, gsd-core/references/decision-model-calls.md, by a lazy Read. The prose is the product
 * (ADR-550 D5), so this file asserts it directly instead of through a JS engine:
 *
 *  - every block is wrapped in the marker pair, opens with the label, gates on `decide --status` printing the literal
 *    `"active": true`, cites the reference by plain path (never an at-sign include), and fits its byte budget;
 *  - every sentence of today's text that the capability falls back to is still a substring of the file once the blocks
 *    are cut out (the shipped default, capability off, reads byte-for-byte as before);
 *  - the reference holds the block convention, the shared recipe and one section per site, within its size cap, and
 *    never reaches a model endpoint itself;
 *  - every `dm:questions` block parses and meets the D18 / D19 / D21 question shape, and the classifier output-schema
 *    line the ingest-docs site copies is still verbatim;
 *  - tracer cases run the real `decide` CLI in a sandbox: `--status` is inactive, and the documented file-batch builder
 *    produces a request the CLI answers one result per request id.
 *
 * SITES grows one row per site as the later tasks and chunk C4 land; the rows here are the tracer pair.
 */
'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { scanFencedBlocks } = require('../gsd-core/bin/lib/markdown-sectionizer.cjs');
const { TOOLS_PATH, createTempProject, cleanup, installSpawnEnv, installSpawnHome } = require('./helpers.cjs');
const { runNode } = require('./helpers/process-seam.cjs');
const { PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');

const ROOT = path.join(__dirname, '..');
const REFERENCE_REL = 'gsd-core/references/decision-model-calls.md';
const REFERENCE_PATH_IN_PROSE = '~/.claude/gsd-core/references/decision-model-calls.md';
const OPEN_PREFIX = '<!-- decision-model: ';
const CLOSE_MARKER = '<!-- /decision-model -->';
const LABEL = '**Decision model (optional):**';
const AGENT_SITES_HEADING = '## Agent sites';
const REFERENCE_CAP_BYTES = 18432;
const SHARED_HEADINGS = [
  '## Block convention', '## Activation', '## Request shape', '## Limits',
  '## Sending', '## Reading answers', '## Provenance', '## Hard limits',
];
const REFERENCE_LITERALS = [
  LABEL, 'decided-by: decision-model (conf', '--request -', '--status', 'below_floor_choice', 'abstain',
  '#1921', 'blocking-human', 'mktemp -d', 'untrusted', 'order_check', 'user scope', 'canonical integer',
];
const KEY_RULE = /^[A-Za-z0-9_.-]{1,64}$/;
const CANONICAL_INTEGER = /^(0|[1-9][0-9]{0,63})$/;
const PROTOTYPE_KEYS = ['__proto__', 'constructor', 'prototype'];

// One row per site block. maxBytes counts the block from the start of its open-marker line through the close marker.
const SITES = [
  {
    file: 'gsd-core/workflows/ingest-docs.md',
    id: 'ingest-doc-type',
    maxBytes: 900,
    keep: [
      'For each discovered doc, spawn `gsd-doc-classifier` in parallel.',
      '**Display discovered set** and request approval',
    ],
    must: ['UNKNOWN'],
  },
  {
    file: 'gsd-core/workflows/add-tests.md',
    id: 'file-class',
    maxBytes: 700,
    keep: ["Read each file to verify classification. Don't classify based on filename alone."],
    must: ['present_classification'],
  },
];

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function readReference() {
  return read(REFERENCE_REL);
}

/** The reference text before the `## Agent sites` line (chunk C4 appends that section and caps it itself). */
function sharedPart(text) {
  const lines = text.split('\n');
  const at = lines.indexOf(AGENT_SITES_HEADING);
  return at === -1 ? text : lines.slice(0, at).join('\n');
}

/** Every block in `text` whose open marker is `<!-- decision-model: {id} -->`, with its extent and ordering facts. */
function extractBlocks(text, id) {
  const open = `${OPEN_PREFIX}${id} -->`;
  const blocks = [];
  let from = 0;
  for (;;) {
    const at = text.indexOf(open, from);
    if (at === -1) break;
    const start = text.lastIndexOf('\n', at) + 1;
    const closeAt = text.indexOf(CLOSE_MARKER, at);
    const nextOpen = text.indexOf(OPEN_PREFIX, at + open.length);
    const closed = closeAt !== -1 && (nextOpen === -1 || closeAt < nextOpen);
    const end = closeAt === -1 ? text.length : closeAt + CLOSE_MARKER.length;
    blocks.push({ text: text.slice(start, end), closed });
    from = at + open.length;
  }
  return blocks;
}

/** `text` with every decision-model block (any id) removed, i.e. the file as it reads with the capability skipped. */
function cutBlocks(text) {
  let out = '';
  let from = 0;
  for (;;) {
    const at = text.indexOf(OPEN_PREFIX, from);
    if (at === -1) break;
    const start = text.lastIndexOf('\n', at) + 1;
    const closeAt = text.indexOf(CLOSE_MARKER, at);
    if (closeAt === -1) break;
    let end = closeAt + CLOSE_MARKER.length;
    if (text[end] === '\n') end += 1;
    out += text.slice(from, start);
    from = end;
  }
  return out + text.slice(from);
}

/** Every `<!-- dm:questions {id} -->` block at line start, with its parsed JSON (the next json fence). */
function questionBlocks(text) {
  const lines = text.split('\n');
  const fences = scanFencedBlocks(lines).filter((b) => b.closeLineIdx !== -1);
  const out = [];
  const prefix = '<!-- dm:questions ';
  lines.forEach((line, i) => {
    if (!line.startsWith(prefix) || !line.endsWith(' -->')) return;
    const id = line.slice(prefix.length, line.length - ' -->'.length).trim();
    const fence = fences.find((b) => b.openLineIdx > i);
    assert.ok(fence !== undefined && fence.openLineIdx === i + 1, `dm:questions ${id} must be followed directly by a json fence`);
    assert.equal(fence.infoString, 'json', `dm:questions ${id} fence must be tagged json`);
    const body = lines.slice(fence.openLineIdx + 1, fence.closeLineIdx).join('\n');
    out.push({ id, questions: JSON.parse(body) });
  });
  return out;
}

/** The program between `node -e '` and the next single quote, after a line-start anchor comment. */
function builderProgram(text, anchor) {
  const lines = text.split('\n');
  const anchorAt = lines.findIndex((l) => l === anchor);
  assert.notEqual(anchorAt, -1, `${anchor} must be on a line of its own`);
  const after = lines.slice(anchorAt + 1).join('\n');
  const marker = "node -e '";
  const start = after.indexOf(marker);
  assert.notEqual(start, -1, `${anchor} must be followed by a node -e '...' program`);
  const bodyStart = start + marker.length;
  const end = after.indexOf("'", bodyStart);
  assert.notEqual(end, -1, `${anchor} program must end with a single quote`);
  return after.slice(bodyStart, end);
}

function walkMarkdown(dirRel, out) {
  for (const entry of fs.readdirSync(path.join(ROOT, dirRel), { withFileTypes: true })) {
    const rel = `${dirRel}/${entry.name}`;
    if (entry.isDirectory()) walkMarkdown(rel, out);
    else if (entry.name.endsWith('.md')) out.push(rel);
  }
  return out;
}

function validateQuestion(where, key, q) {
  assert.ok(KEY_RULE.test(key), `${where}: question key ${key} breaks the key rule`);
  assert.ok(!PROTOTYPE_KEYS.includes(key), `${where}: question key ${key} is a prototype name`);
  assert.ok(['choice', 'noul', 'score'].includes(q.type), `${where}.${key}: type must be choice, noul or score`);
  assert.equal(typeof q.instructions, 'string', `${where}.${key}: instructions must be a string`);
  assert.ok(q.instructions.length > 0, `${where}.${key}: instructions must not be empty`);
  if (q.type !== 'noul') {
    const keys = Object.keys(q.criteria);
    assert.ok(keys.length >= 2 && keys.length <= 24, `${where}.${key}: choice and score need 2 to 24 criteria`);
    for (const c of keys) {
      assert.ok(KEY_RULE.test(c), `${where}.${key}: criteria key ${c} breaks the key rule`);
      assert.ok(!PROTOTYPE_KEYS.includes(c), `${where}.${key}: criteria key ${c} is a prototype name`);
      assert.ok(!CANONICAL_INTEGER.test(c), `${where}.${key}: criteria key ${c} is a canonical integer (D21: JS key order would reorder it)`);
      assert.equal(typeof q.criteria[c], 'string', `${where}.${key}.${c}: description must be a string`);
    }
  }
  if (q.min_confidence !== undefined) {
    assert.ok(typeof q.min_confidence === 'number' && q.min_confidence >= 0.5 && q.min_confidence <= 1,
      `${where}.${key}: min_confidence must be a number in [0.5, 1]`);
  }
  if (q.order_check !== undefined) {
    assert.equal(typeof q.order_check, 'boolean', `${where}.${key}: order_check must be a boolean`);
  }
}

describe('decision-model prose blocks', () => {
  for (const site of SITES) {
    const where = `${site.file} [${site.id}]`;
    const wantCount = site.count ?? 1;

    describe(where, () => {
      const text = read(site.file);
      const blocks = extractBlocks(text, site.id);

      test('carries the expected number of closed blocks', () => {
        assert.equal(blocks.length, wantCount, 'open marker count');
        for (const b of blocks) assert.ok(b.closed, 'each open marker needs a close marker before the next open marker');
      });

      test('each block has the label, the gate, the lazy cite, and its budget', () => {
        assert.ok(blocks.length > 0, 'no block found');
        for (const b of blocks) {
          assert.ok(b.text.includes(LABEL), 'label');
          assert.ok(b.text.includes(REFERENCE_PATH_IN_PROSE), 'lazy cite of the shared reference');
          assert.ok(b.text.includes('decide --status'), 'status gate');
          assert.ok(b.text.includes('"active": true'), 'literal active gate');
          assert.ok(Buffer.byteLength(b.text, 'utf8') <= site.maxBytes,
            `block is ${Buffer.byteLength(b.text, 'utf8')} bytes, budget ${site.maxBytes}`);
          assert.ok(!b.text.includes('```'), 'a block holds no fenced code');
          assert.ok(!b.text.includes('AskUserQuestion'), 'a block never names the Claude question tool');
          assert.ok(!b.text.includes('@~/.claude/gsd-core/references/decision-model-calls.md'), 'no eager include');
          for (const phrase of site.must ?? []) assert.ok(b.text.includes(phrase), `block must say: ${phrase}`);
        }
      });

      test('every fallback phrase is still in the file outside the blocks', () => {
        const rest = cutBlocks(text);
        for (const phrase of site.keep) assert.ok(rest.includes(phrase), `missing today's text: ${phrase}`);
      });

      test('the reference has the site section', () => {
        const lines = readReference().split('\n');
        assert.ok(lines.includes(`## site: ${site.id}`), `reference needs "## site: ${site.id}"`);
      });

      if (site.questions ?? true) {
        test('the reference has a questions block for the site', () => {
          const ids = questionBlocks(readReference()).map((q) => q.id);
          assert.ok(ids.some((id) => id === site.id || id.startsWith(`${site.id}.`)), `no dm:questions block for ${site.id}`);
        });
      }
    });
  }
});

describe('decision-model-calls.md reference', () => {
  test('exists and keeps its shared part within the size cap, with no direct endpoint call', () => {
    const part = sharedPart(readReference());
    assert.ok(Buffer.byteLength(part, 'utf8') <= REFERENCE_CAP_BYTES, `shared part is ${Buffer.byteLength(part, 'utf8')} bytes`);
    assert.ok(!part.includes('curl'), 'prose must not call an endpoint with curl');
    assert.ok(!part.includes('/v1/chat'), 'prose must not name the chat endpoint');
  });

  test('has every shared heading and the literals the sites rely on', () => {
    const text = readReference();
    const lines = text.split('\n');
    for (const h of SHARED_HEADINGS) assert.ok(lines.includes(h), `missing heading ${h}`);
    for (const lit of REFERENCE_LITERALS) assert.ok(text.includes(lit), `missing literal ${lit}`);
  });

  test('states that only ok answers are applied and below_floor_choice never is', () => {
    const text = readReference();
    assert.ok(text.includes('Apply only `status: ok`'), 'ok-only rule');
    assert.ok(text.includes('`below_floor_choice` is never applied'), 'below-floor rule');
  });

  test('every dm:questions block parses and meets the D18, D19 and D21 question shape', () => {
    const blocks = questionBlocks(readReference());
    assert.ok(blocks.length > 0, 'at least one questions block');
    for (const { id, questions } of blocks) {
      for (const key of Object.keys(questions)) validateQuestion(id, key, questions[key]);
    }
  });

  test('copies the doc classifier output-schema line verbatim', () => {
    const agent = read('agents/gsd-doc-classifier.md');
    const head = '`{ source_path, type (ADR|PRD|SPEC|DOC|UNKNOWN)';
    const at = agent.indexOf(head);
    assert.notEqual(at, -1, 'classifier schema line moved; update this test and the reference together');
    const eol = agent.indexOf('\n', at);
    const line = agent.slice(at, eol === -1 ? agent.length : eol);
    assert.ok(readReference().includes(line), 'reference must carry the classifier schema line verbatim');
  });

  test('no markdown file under gsd-core, agents or commands includes the reference by an at-sign path', () => {
    const files = [...walkMarkdown('gsd-core', []), ...walkMarkdown('agents', []), ...walkMarkdown('commands', [])];
    for (const rel of files) {
      const text = read(rel);
      let from = 0;
      for (;;) {
        const at = text.indexOf('decision-model-calls.md', from);
        if (at === -1) break;
        let s = at;
        while (s > 0 && !' \t\r\n`"\'()<>'.includes(text[s - 1])) s -= 1;
        assert.notEqual(text[s], '@', `${rel} includes the reference eagerly`);
        from = at + 1;
      }
    }
  });
});

describe('decide CLI tracer (real engine, sandboxed)', () => {
  function sandbox(t) {
    const cwd = createTempProject('gsd-dm-prose-');
    t.after(() => cleanup(cwd));
    const env = installSpawnEnv({ GSD_HOME: installSpawnHome() });
    return { cwd, env };
  }

  test('decide --status in a fresh sandbox is inactive', (t) => {
    const { cwd, env } = sandbox(t);
    const res = runNode([TOOLS_PATH, 'decide', '--status'], { cwd, env, timeoutMs: PROBE_TIMEOUT_MS });
    assert.equal(res.exitCode, 0, res.stderr);
    const start = res.stdout.indexOf('{');
    const status = JSON.parse(res.stdout.slice(start));
    assert.equal(status.active, false);
  });

  test('the documented file-batch builder round-trips through decide --request -, one result per request id', (t) => {
    const { cwd, env } = sandbox(t);
    fs.mkdirSync(path.join(cwd, 'corpus', 'adr'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'corpus', 'adr', '0001-use-x.md'),
      '# 0001 Use X\n\nStatus: Accepted\n\n## Context\nWe need a store.\n\n## Decision\nUse X.\n\n## Consequences\nX it is.\n');
    fs.writeFileSync(path.join(cwd, 'corpus', 'guide.md'), '# Guide\n\nHow to get started with the tool, step by step.\n');

    const reference = readReference();
    const program = builderProgram(reference, '<!-- dm:file-batch-builder -->');
    const questions = questionBlocks(reference).find((q) => q.id === 'ingest-doc-type').questions;
    const questionsFile = path.join(cwd, 'questions.json');
    fs.writeFileSync(questionsFile, JSON.stringify(questions));

    const built = runNode(['-e', program, questionsFile, '3500', 'corpus/adr/0001-use-x.md', 'corpus/guide.md'],
      { cwd, env, timeoutMs: PROBE_TIMEOUT_MS });
    assert.equal(built.exitCode, 0, built.stderr);
    const request = JSON.parse(built.stdout);
    assert.deepEqual(request.requests.map((r) => r.id), ['f1', 'f2']);
    for (const r of request.requests) assert.ok(r.state.startsWith('path: corpus/'), `state starts with the path: ${r.state.slice(0, 20)}`);
    assert.ok(request.requests[0].state.includes('Status: Accepted'), 'file content follows the path line');

    const answered = runNode([TOOLS_PATH, 'decide', '--request', '-'], { cwd, env, input: built.stdout, timeoutMs: PROBE_TIMEOUT_MS });
    assert.equal(answered.exitCode, 0, answered.stderr);
    const response = JSON.parse(answered.stdout.slice(answered.stdout.indexOf('{')));
    assert.deepEqual(response.results.map((r) => r.id), request.requests.map((r) => r.id));
    for (const r of response.results) {
      for (const answer of Object.values(r.answers)) assert.ok(['ok', 'abstain'].includes(answer.status), `status ${answer.status}`);
    }
  });

  test('the builder skips an unreadable path, reports it, and keeps the other ids tied to input order', (t) => {
    const { cwd, env } = sandbox(t);
    fs.mkdirSync(path.join(cwd, 'corpus'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'corpus', 'a.md'), '# A\n');
    fs.writeFileSync(path.join(cwd, 'corpus', 'c.md'), '# C\n');
    const reference = readReference();
    const program = builderProgram(reference, '<!-- dm:file-batch-builder -->');
    const questionsFile = path.join(cwd, 'questions.json');
    fs.writeFileSync(questionsFile, JSON.stringify(questionBlocks(reference).find((q) => q.id === 'file-class').questions));

    const built = runNode(['-e', program, questionsFile, '3500', 'corpus/a.md', 'corpus/missing.md', 'corpus/c.md'],
      { cwd, env, timeoutMs: PROBE_TIMEOUT_MS });
    assert.equal(built.exitCode, 0, built.stderr);
    assert.deepEqual(JSON.parse(built.stdout).requests.map((r) => r.id), ['f1', 'f3']);
    assert.ok(built.stderr.includes('skip f2 corpus/missing.md'), built.stderr);
  });
});
