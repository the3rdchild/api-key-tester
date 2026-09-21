// Pre-request / post-response scripting, sandboxed in QuickJS (WASM).
//
// Why QuickJS and not node:vm: scripts are the one place where a request can
// run arbitrary code, and node:vm shares the host heap - a stray loop or a
// stray require() is the host's problem. QuickJS is a separate interpreter with
// its own memory limit and an interrupt handler, and it has no fetch, no fs and
// no timers of its own. It is also what Bruno settled on for the same job.
//
// The bridge is deliberately plain JSON: the script mutates a state object, we
// read the mutations back out. No host objects ever cross into the sandbox.

import { getQuickJS, shouldInterruptAfterDeadline } from 'quickjs-emscripten';

export interface ScriptRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
}

export interface ScriptResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
  /** parsed body when it was JSON - the common case in scripts */
  json?: unknown;
  latencyMs: number;
  size: number;
  /** streamed responses: the generated text, framing removed */
  streamText?: string;
  stream?: unknown;
}

export interface ScriptTest {
  name: string;
  passed: boolean;
  error?: string;
}

export interface ScriptOutcome {
  /** the (possibly mutated) request - pre phase only */
  req?: ScriptRequest;
  /** vars set with bru.setVar */
  vars: Record<string, string>;
  /** vars set with bru.setEnvVar - these get written back to collections.json */
  envVars: Record<string, string>;
  tests: ScriptTest[];
  logs: string[];
  /** the script itself blew up (syntax error, throw outside test(), timeout) */
  error?: string;
}

export interface ScriptContext {
  phase: 'pre' | 'post';
  req: ScriptRequest;
  res?: ScriptResponse;
  vars: Record<string, string>;
  envVars: Record<string, string>;
  timeoutMs?: number;
  memoryMb?: number;
}

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_MEMORY_MB = 32;

/** The sandbox preamble: everything a script is allowed to touch. */
function wrap(userCode: string): string {
  return `
(() => {
  const state = JSON.parse(__STATE__);
  const changedVars = {};
  const changedEnv = {};
  const tests = [];
  const logs = [];

  const str = (v) => v === undefined || v === null
    ? ''
    : (typeof v === 'object' ? JSON.stringify(v) : String(v));

  const bru = {
    getVar: (k) => state.vars[k],
    setVar: (k, v) => { const s = str(v); state.vars[k] = s; changedVars[k] = s; },
    getEnvVar: (k) => state.envVars[k],
    setEnvVar: (k, v) => { const s = str(v); state.envVars[k] = s; changedEnv[k] = s; },
    vars: state.vars,
    envVars: state.envVars,
    phase: state.phase,
  };

  const req = state.req;
  const res = state.res;

  const console = {
    log: (...a) => logs.push(a.map(str).join(' ')),
    info: (...a) => logs.push(a.map(str).join(' ')),
    warn: (...a) => logs.push('WARN ' + a.map(str).join(' ')),
    error: (...a) => logs.push('ERROR ' + a.map(str).join(' ')),
  };

  function test(name, fn) {
    try {
      fn();
      tests.push({ name: str(name), passed: true });
    } catch (e) {
      tests.push({ name: str(name), passed: false, error: (e && e.message) ? str(e.message) : str(e) });
    }
  }

  function expect(actual) {
    const fail = (msg) => { throw new Error(msg); };
    const show = (v) => str(v);
    const api = {
      toBe: (x) => { if (actual !== x) fail('expected ' + show(x) + ', got ' + show(actual)); return api; },
      toEqual: (x) => {
        if (JSON.stringify(actual) !== JSON.stringify(x)) fail('expected ' + show(x) + ', got ' + show(actual));
        return api;
      },
      toContain: (x) => {
        const ok = Array.isArray(actual) ? actual.indexOf(x) >= 0 : String(actual).indexOf(String(x)) >= 0;
        if (!ok) fail(show(actual) + ' does not contain ' + show(x));
        return api;
      },
      toMatch: (re) => {
        if (!new RegExp(re).test(String(actual))) fail(show(actual) + ' does not match ' + show(re));
        return api;
      },
      toBeLessThan: (x) => { if (!(Number(actual) < Number(x))) fail(show(actual) + ' is not < ' + show(x)); return api; },
      toBeGreaterThan: (x) => { if (!(Number(actual) > Number(x))) fail(show(actual) + ' is not > ' + show(x)); return api; },
      toExist: () => { if (actual === undefined || actual === null) fail('expected a value, got ' + show(actual)); return api; },
      toHaveProperty: (k) => {
        if (!actual || typeof actual !== 'object' || !(k in actual)) fail('missing property ' + show(k));
        return api;
      },
    };
    return api;
  }

  let error;
  try {
${userCode}
  } catch (e) {
    const head = (e && e.message) ? String(e.message) : String(e);
    error = (e && e.stack) ? head + '\\n' + String(e.stack) : head;
  }

  return JSON.stringify({
    req: state.req,
    vars: changedVars,
    envVars: changedEnv,
    tests,
    logs,
    error,
  });
})()
`;
}

function empty(error?: string): ScriptOutcome {
  return { vars: {}, envVars: {}, tests: [], logs: [], error };
}

/** How many wrapper lines sit above the user's first line. */
const PREAMBLE_LINES = wrap('\u0000MARKER\u0000')
  .split('\n')
  .findIndex((line) => line.includes('\u0000MARKER\u0000'));

/** Rewrite eval.js:<line> back to the line the user actually wrote. */
function rebase(message: string): string {
  return message.replace(/eval\.js:(\d+)/g, (whole, line: string) => {
    const n = Number(line) - PREAMBLE_LINES;
    return n > 0 ? `script:${n}` : whole;
  });
}

export async function runScript(code: string, ctx: ScriptContext): Promise<ScriptOutcome> {
  if (!code.trim()) return empty();

  const QuickJS = await getQuickJS();
  const runtime = QuickJS.newRuntime();
  runtime.setMemoryLimit((ctx.memoryMb ?? DEFAULT_MEMORY_MB) * 1024 * 1024);
  runtime.setInterruptHandler(
    shouldInterruptAfterDeadline(Date.now() + (ctx.timeoutMs ?? DEFAULT_TIMEOUT_MS)),
  );
  const vm = runtime.newContext();

  try {
    const state = {
      phase: ctx.phase,
      req: ctx.req,
      res: ctx.res,
      vars: ctx.vars,
      envVars: ctx.envVars,
    };
    const stateHandle = vm.newString(JSON.stringify(state));
    vm.setProp(vm.global, '__STATE__', stateHandle);
    stateHandle.dispose();

    const evaluated = vm.evalCode(wrap(code));
    if (evaluated.error) {
      const detail = vm.dump(evaluated.error);
      evaluated.error.dispose();
      const message =
        typeof detail === 'object' && detail && 'message' in detail
          ? String((detail as { message: unknown }).message)
          : String(detail);
      // An interrupt arrives here as a bare "interrupted" - say what actually
      // happened, with the limit that was hit.
      return empty(
        /interrupt/i.test(message)
          ? `Script stopped after ${ctx.timeoutMs ?? DEFAULT_TIMEOUT_MS} ms (infinite loop?)`
          : rebase(message),
      );
    }

    const raw = vm.dump(evaluated.value) as string;
    evaluated.value.dispose();
    const parsed = JSON.parse(raw) as ScriptOutcome & { req?: ScriptRequest };
    return {
      req: ctx.phase === 'pre' ? parsed.req : undefined,
      vars: parsed.vars ?? {},
      envVars: parsed.envVars ?? {},
      tests: parsed.tests ?? [],
      logs: parsed.logs ?? [],
      error: parsed.error ? rebase(parsed.error) : undefined,
    };
  } catch (e) {
    // An interrupt surfaces here as a plain throw from evalCode.
    const msg = e instanceof Error ? e.message : String(e);
    return empty(
      msg.includes('interrupt')
        ? `Script stopped after ${ctx.timeoutMs ?? DEFAULT_TIMEOUT_MS} ms`
        : msg,
    );
  } finally {
    vm.dispose();
    runtime.dispose();
  }
}
