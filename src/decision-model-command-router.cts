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
import { parseNamedArgsOrExit } from './command-arg-projection.cjs';
import { tryWithinRoot, PathAcceptance, safeJsonParse } from './security.cjs';

// eslint-disable-next-line @typescript-eslint/no-require-imports
import io = require('./io.cjs');

const { output, ERROR_REASON } = io;

type EngineModule = typeof import('./decision-model.cjs');

interface CoreModule {
  output(value: unknown, raw: boolean): void;
}

const _defaultCore: CoreModule = { output };

const MAX_REQUEST_BYTES = 4194304;

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

  const data = parseNamedArgsOrExit(
    args.slice(1),
    { valueFlags: ['request'], booleanFlags: ['status', 'probe'], positionals: 0 },
    (message) => usage(message),
  );

  const requestArg = data['request'];
  const wantsStatus = data['status'] === true;
  const wantsProbe = data['probe'] === true;

  // The parser reports both an absent --request and one with no value as null, so
  // presence is checked on the raw args: `--request $FILE` with an empty FILE must
  // not silently become a successful --status (WR-09).
  if (requestArg === null && args.slice(1).includes('--request')) {
    usage('decide --request needs a value: a path inside the project root, or - for stdin');
    return undefined;
  }
  if (wantsProbe && !wantsStatus) {
    usage('decide --probe is only valid with --status');
    return undefined;
  }
  if (wantsStatus && requestArg !== null && requestArg !== undefined) {
    usage('decide takes either --request <path|-> or --status, not both');
    return undefined;
  }
  if (wantsStatus) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const statusEngine: EngineModule = _engine ?? (require('./decision-model.cjs') as EngineModule);
    c.output(statusEngine.statusSync({ cwd, probe: wantsProbe }), raw);
    return undefined;
  }
  if (typeof requestArg !== 'string') {
    usage('decide requires --request <path|-> or --status');
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

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const engine: EngineModule = _engine ?? (require('./decision-model.cjs') as EngineModule);
  const valid = engine.validateRequest(parsed.value);
  if (!valid.ok) {
    usage(`decide request is invalid: ${valid.message}`);
    return undefined;
  }

  c.output(engine.decideSync(parsed.value, { cwd }), raw);
  return undefined;
}

export = {
  routeDecideCommand,
};
