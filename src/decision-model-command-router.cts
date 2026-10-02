'use strict';
/**
 * decision-model command router: `gsd-tools decide` (quick 261001-wza).
 *
 * An ADR-959 capability router. It is SYNCHRONOUS: a returned Promise is rejected
 * with SDK_FAIL_FAST, and a floated Promise breaks output ordering and exit
 * codes. The async model call therefore lives behind `decideSync` (a bounded
 * spawnSync child, see decision-model.cts); this module only parses arguments,
 * reads the request, and prints the engine's response.
 *
 * Arg indexing: args[0] = 'decide' (the family), args[1..] = flags.
 *
 *   decide --request <path|->   answer the questions in a JSON request file
 *                                (a path inside the project root, or `-` for stdin)
 *   decide --status [--probe]   report whether the capability is active and how it is
 *                                configured; --probe adds one GET to the models URL
 *                                (no network call without it). --probe needs --status.
 *   decide --questions <file> --items <file> [--budget-ms N]
 *                                items mode (CONTEXT D24): one questions object asked of
 *                                many state files. Each state file is read raw and the
 *                                request is built as data, so neither state text nor a
 *                                file name ever reaches a JSON template or a shell line.
 *   decide --mkdir               create a marked temp dir for items-mode files and print
 *                                its absolute path
 *   decide --rmdir <path>        remove a dir that --mkdir made (refuses any other path)
 *
 * Items-mode paths (the two files and every state_file) are confined to the project
 * root or to a dir made by --mkdir under the OS temp dir, judged on the real path.
 *
 * `routeHubCommandFamily` is not used: it reads args[1] as a subcommand, and
 * `decide` has none. The flags are parsed with `parseNamedArgsOrExit`.
 *
 * Every abstain is exit 0 (the engine reports it as data). Only a usage fault
 * goes through `error(message, ERROR_REASON.USAGE)`.
 *
 * Seams (production callers omit them): `_engine` (decision-model.cjs),
 * `_readStdin`, `_core` (output capture).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { parseNamedArgsOrExit } from './command-arg-projection.cjs';
import { tryWithinRoot, PathAcceptance, safeJsonParse } from './security.cjs';

// eslint-disable-next-line @typescript-eslint/no-require-imports
import io = require('./io.cjs');

const { output, ERROR_REASON } = io;

type EngineModule = typeof import('./decision-model.cjs');

interface CoreModule {
  output(value: unknown, raw: boolean, rawValue?: unknown): void;
}

const _defaultCore: CoreModule = { output };

const MAX_REQUEST_BYTES = 4194304;
/** D24: a --mkdir dir is a direct child of the OS temp dir with this name prefix ... */
const DECIDE_DIR_PREFIX = 'gsd-decide-';
/** ... that holds this marker file, written by --mkdir. --rmdir refuses a dir without it. */
const DECIDE_DIR_MARKER = '.gsd-decide-dir';
/** D24: the largest --budget-ms accepted (one hour). */
const MAX_BUDGET_MS = 3600000;
const VALUE_FLAGS = ['request', 'questions', 'items', 'budget-ms', 'rmdir'];

interface RouteDecideCommandOptions {
  args: string[];
  cwd: string;
  raw: boolean;
  error: (message: string, reason?: string) => void;
  _engine?: EngineModule;
  _readStdin?: () => string;
  _core?: CoreModule;
}

function readProcessStdin(): string {
  return fs.readFileSync(0, 'utf8');
}

function routeDecideCommand({ args, cwd, raw, error, _engine, _readStdin, _core }: RouteDecideCommandOptions): void {
  const c: CoreModule = _core ?? _defaultCore;
  const usage = (message: string): void => error(message, ERROR_REASON.USAGE);
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const loadEngine = (): EngineModule => _engine ?? (require('./decision-model.cjs') as EngineModule);

  const data = parseNamedArgsOrExit(
    args.slice(1),
    { valueFlags: VALUE_FLAGS, booleanFlags: ['status', 'probe', 'mkdir'], positionals: 0 },
    (message) => usage(message),
  );

  // The parser reports both an absent value flag and one with no value as null, so
  // presence is checked on the raw args: `--request $FILE` with an empty FILE must
  // not silently become a successful --status (WR-09). The same holds for every
  // value flag of items mode.
  for (const flag of VALUE_FLAGS) {
    if (data[flag] === null && args.slice(1).includes(`--${flag}`)) {
      usage(flag === 'request'
        ? 'decide --request needs a value: a path inside the project root, or - for stdin'
        : `decide --${flag} needs a value`);
      return undefined;
    }
  }

  const requestArg = data['request'];
  const wantsStatus = data['status'] === true;
  const wantsProbe = data['probe'] === true;
  const wantsMkdir = data['mkdir'] === true;
  const rmdirArg = data['rmdir'];
  const questionsArg = data['questions'];
  const itemsArg = data['items'];
  const budgetArg = data['budget-ms'];
  const has = (v: unknown): boolean => typeof v === 'string';

  const modes = [has(requestArg), wantsStatus, wantsMkdir, has(rmdirArg), has(questionsArg) || has(itemsArg)].filter(Boolean).length;
  if (wantsProbe && !wantsStatus) {
    usage('decide --probe is only valid with --status');
    return undefined;
  }
  if (wantsStatus && has(requestArg)) {
    usage('decide takes either --request <path|-> or --status, not both');
    return undefined;
  }
  if (modes > 1) {
    usage('decide takes one of --request, --status, --questions with --items, --mkdir or --rmdir');
    return undefined;
  }
  if (has(budgetArg) && !(has(questionsArg) || has(itemsArg))) {
    usage('decide --budget-ms is only valid with --questions and --items');
    return undefined;
  }
  if (wantsStatus) {
    c.output(loadEngine().statusSync({ cwd, probe: wantsProbe }), raw);
    return undefined;
  }
  if (wantsMkdir) {
    makeDecideDir(c, usage);
    return undefined;
  }
  if (typeof rmdirArg === 'string') {
    removeDecideDir(rmdirArg, c, raw, usage);
    return undefined;
  }
  if (has(questionsArg) || has(itemsArg)) {
    if (typeof questionsArg !== 'string' || typeof itemsArg !== 'string') {
      usage('decide items mode needs both --questions <file> and --items <file>');
      return undefined;
    }
    let budgetMs: number | undefined;
    if (typeof budgetArg === 'string') {
      const n = /^[0-9]{1,9}$/.test(budgetArg) ? Number(budgetArg) : NaN;
      if (!Number.isInteger(n) || n < 1 || n > MAX_BUDGET_MS) {
        usage(`decide --budget-ms must be an integer from 1 to ${MAX_BUDGET_MS}`);
        return undefined;
      }
      budgetMs = n;
    }
    decideItems({ questionsArg, itemsArg, budgetMs, cwd, raw, c, usage, engine: loadEngine() });
    return undefined;
  }
  if (typeof requestArg !== 'string') {
    usage('decide requires --request <path|->, --status, --questions with --items, --mkdir or --rmdir <path>');
    return undefined;
  }

  let text: string;
  if (requestArg === '-') {
    try {
      text = (_readStdin ?? readProcessStdin)();
    } catch (e) {
      usage(`decide could not read the request from stdin: ${e instanceof Error ? e.message : String(e)}`);
      return undefined;
    }
    // The same byte limit as a request file (IN-11): safeJsonParse's maxLength counts
    // UTF-16 units, which lets about three times as many bytes of CJK text through.
    if (Buffer.byteLength(text, 'utf8') > MAX_REQUEST_BYTES) {
      usage(`decide request on stdin must be at most ${MAX_REQUEST_BYTES} bytes`);
      return undefined;
    }
  } else {
    const contained = tryWithinRoot(requestArg, cwd, PathAcceptance.AbsoluteInsideRoot);
    if (contained === null) {
      usage('decide --request must name a file inside the project root');
      return undefined;
    }
    // usage() throws an ExitError (ADR-3889), so it is never called inside a try:
    // a catch there would swallow it and print a second, bogus error.
    let st: fs.Stats;
    try {
      st = fs.statSync(contained);
    } catch (e) {
      usage(`decide could not read the request file: ${e instanceof Error ? e.message : String(e)}`);
      return undefined;
    }
    if (!st.isFile() || st.size > MAX_REQUEST_BYTES) {
      usage(`decide --request must be a regular file of at most ${MAX_REQUEST_BYTES} bytes`);
      return undefined;
    }
    let readError: string | null = null;
    try {
      text = fs.readFileSync(contained, 'utf8');
    } catch (e) {
      readError = e instanceof Error ? e.message : String(e);
      text = '';
    }
    if (readError !== null) {
      usage(`decide could not read the request file: ${readError}`);
      return undefined;
    }
  }

  const parsed = safeJsonParse(text, { maxLength: MAX_REQUEST_BYTES, label: 'decide request' });
  if (!parsed.ok) {
    usage(`decide request is not valid JSON: ${parsed.error ?? 'unknown parse error'}`);
    return undefined;
  }

  const engine: EngineModule = loadEngine();
  const valid = engine.validateRequest(parsed.value);
  if (!valid.ok) {
    usage(`decide request is invalid: ${valid.message}`);
    return undefined;
  }

  c.output(engine.decideSync(parsed.value, { cwd }), raw);
  return undefined;
}

// ─── Items mode (D24) ─────────────────────────────────────────────────────────

function realTmpDir(): string {
  try { return fs.realpathSync(os.tmpdir()); } catch { return path.resolve(os.tmpdir()); }
}

/**
 * True when `dir` is a dir that `decide --mkdir` made: a direct child of the real
 * OS temp dir, named gsd-decide-*, a real directory (not a link) holding the marker
 * as a regular file.
 */
function isMarkedDecideDir(dir: string, tmp: string): boolean {
  if (path.dirname(dir) !== tmp || !path.basename(dir).startsWith(DECIDE_DIR_PREFIX)) return false;
  try {
    if (!fs.lstatSync(dir).isDirectory()) return false;
    return fs.lstatSync(path.join(dir, DECIDE_DIR_MARKER)).isFile();
  } catch {
    return false;
  }
}

/**
 * D24 confinement for an items-mode path: its real path (symlinks resolved) inside
 * the project root, or inside a --mkdir dir under the OS temp dir. Anything else,
 * including any other temp path, is null. A relative path is taken from the root.
 */
function confineItemsPath(candidate: string, cwd: string): string | null {
  const inRoot = tryWithinRoot(candidate, cwd, PathAcceptance.AbsoluteInsideRoot);
  if (inRoot !== null) return inRoot;
  if (!path.isAbsolute(candidate)) return null;
  const tmp = realTmpDir();
  const inTmp = tryWithinRoot(candidate, tmp, PathAcceptance.AbsoluteInsideRoot);
  if (inTmp === null) return null;
  const first = path.relative(tmp, inTmp).split(path.sep)[0];
  if (first === undefined || first === '' || first === '..') return null;
  const dir = path.join(tmp, first);
  if (dir === inTmp) return null;
  return isMarkedDecideDir(dir, tmp) ? inTmp : null;
}

function sha256Hex(data: Buffer | string): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/** Read and parse one items-mode JSON file (--questions or --items), or report a usage error. */
function readItemsJson(flag: string, arg: string, cwd: string, usage: (m: string) => void): { ok: true; value: unknown } | { ok: false } {
  const contained = confineItemsPath(arg, cwd);
  if (contained === null) {
    usage(`decide --${flag} must name a file inside the project root or a decide --mkdir dir`);
    return { ok: false };
  }
  let text: string | null = null;
  let problem: string | null = null;
  try {
    const st = fs.statSync(contained);
    if (!st.isFile() || st.size > MAX_REQUEST_BYTES) problem = `decide --${flag} must be a regular file of at most ${MAX_REQUEST_BYTES} bytes`;
    else text = fs.readFileSync(contained, 'utf8');
  } catch (e) {
    problem = `decide could not read the --${flag} file: ${e instanceof Error ? e.message : String(e)}`;
  }
  // usage() throws (ADR-3889), so it is never called inside the try.
  if (problem !== null || text === null) {
    usage(problem ?? `decide could not read the --${flag} file`);
    return { ok: false };
  }
  const parsed = safeJsonParse(text, { maxLength: MAX_REQUEST_BYTES, label: `decide --${flag}` });
  if (!parsed.ok) {
    usage(`decide --${flag} is not valid JSON: ${parsed.error ?? 'unknown parse error'}`);
    return { ok: false };
  }
  return { ok: true, value: parsed.value };
}

type ItemInput = Parameters<EngineModule['decideItemsSync']>[1][number];

/**
 * Read one item's state file raw. A path outside the confinement, a missing or
 * unreadable file, or a non-regular file abstains invalid-request; a file over
 * MAX_STATE_FILE_BYTES is not read and abstains context-exceeded (never truncated).
 * The file is opened once (O_NOFOLLOW where the platform has it) and sized and read
 * through that descriptor, so the checked file is the file read.
 */
function readItemState(spec: { id: string; state_file: string; sha256: boolean }, cwd: string, engine: EngineModule): ItemInput {
  const R = engine.ABSTAIN_REASON;
  const item: ItemInput = { id: spec.id };
  if (spec.sha256) item.path_sha256 = sha256Hex(path.resolve(cwd, spec.state_file).split(path.sep).join('/'));
  const contained = confineItemsPath(spec.state_file, cwd);
  if (contained === null) return { ...item, reason: R.INVALID_REQUEST };
  let fd: number | null = null;
  try {
    const noFollow = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0;
    fd = fs.openSync(contained, fs.constants.O_RDONLY | noFollow);
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return { ...item, reason: R.INVALID_REQUEST };
    if (st.size > engine.MAX_STATE_FILE_BYTES) return { ...item, reason: R.CONTEXT_EXCEEDED };
    const buf = Buffer.alloc(engine.MAX_STATE_FILE_BYTES + 1);
    let n = 0;
    for (;;) {
      const got = fs.readSync(fd, buf, n, buf.length - n, null);
      if (got === 0) break;
      n += got;
      if (n > engine.MAX_STATE_FILE_BYTES) return { ...item, reason: R.CONTEXT_EXCEEDED };
    }
    const bytes = buf.subarray(0, n);
    if (spec.sha256) item.sha256 = sha256Hex(bytes);
    return { ...item, state: bytes.toString('utf8') };
  } catch {
    return { ...item, reason: R.INVALID_REQUEST };
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* already closed */ } }
  }
}

function decideItems(o: {
  questionsArg: string;
  itemsArg: string;
  budgetMs: number | undefined;
  cwd: string;
  raw: boolean;
  c: CoreModule;
  usage: (m: string) => void;
  engine: EngineModule;
}): void {
  const q = readItemsJson('questions', o.questionsArg, o.cwd, o.usage);
  if (!q.ok) return;
  const qv = o.engine.validateItemQuestions(q.value);
  if (!qv.ok) {
    o.usage(`decide --questions is invalid: ${qv.message}`);
    return;
  }
  const it = readItemsJson('items', o.itemsArg, o.cwd, o.usage);
  if (!it.ok) return;
  const iv = o.engine.validateItemsList(it.value);
  if (!iv.ok) {
    o.usage(`decide --items is invalid: ${iv.message}`);
    return;
  }
  const inputs = iv.items.map((spec) => readItemState(spec, o.cwd, o.engine));
  o.c.output(o.engine.decideItemsSync(q.value, inputs, { cwd: o.cwd, budgetMs: o.budgetMs }), o.raw);
}

/** `decide --mkdir`: a fresh gsd-decide-* dir under the OS temp dir with the marker file; prints its absolute path. */
function makeDecideDir(c: CoreModule, usage: (m: string) => void): void {
  let dir: string | null = null;
  let problem: string | null = null;
  try {
    dir = fs.mkdtempSync(path.join(realTmpDir(), DECIDE_DIR_PREFIX));
    fs.writeFileSync(path.join(dir, DECIDE_DIR_MARKER), 'made by gsd-tools decide --mkdir; removed by decide --rmdir\n', { flag: 'wx', mode: 0o600 });
  } catch (e) {
    problem = e instanceof Error ? e.message : String(e);
  }
  if (problem !== null || dir === null) {
    usage(`decide --mkdir could not create a temp dir: ${problem ?? 'unknown error'}`);
    return;
  }
  c.output({ path: dir }, true, dir);
}

/**
 * `decide --rmdir <path>`: removes the dir only when it is a marked --mkdir dir,
 * judged on the path as given (absolute, a direct child of the real OS temp dir,
 * not a link). Anything else is a usage error and nothing is removed.
 */
function removeDecideDir(arg: string, c: CoreModule, raw: boolean, usage: (m: string) => void): void {
  const refuse = (): void => usage('decide --rmdir removes only a directory made by decide --mkdir (an absolute path under the OS temp dir holding its marker)');
  if (!path.isAbsolute(arg) || arg.includes('\0')) {
    refuse();
    return;
  }
  const tmp = realTmpDir();
  let parent: string;
  try { parent = fs.realpathSync(path.dirname(path.resolve(arg))); } catch { parent = ''; }
  const target = path.join(parent, path.basename(path.resolve(arg)));
  if (parent === '' || !isMarkedDecideDir(target, tmp)) {
    refuse();
    return;
  }
  let problem: string | null = null;
  try {
    fs.rmSync(target, { recursive: true, force: false });
  } catch (e) {
    problem = e instanceof Error ? e.message : String(e);
  }
  if (problem !== null) {
    usage(`decide --rmdir could not remove ${target}: ${problem}`);
    return;
  }
  c.output({ removed: true, path: target }, raw);
}

export = {
  routeDecideCommand,
};
