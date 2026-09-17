import { Worker } from 'node:worker_threads';
import type { ToolDefinition, ToolGroup, ToolSource } from './types.ts';

export const CODE_GROUP: ToolGroup = {
  id: 'code',
  label: 'Run JavaScript',
  description: 'Calculations and data processing in a sandbox with no file, network or system access.',
  kind: 'builtin',
  onByDefault: true,
  toggledBy: null,
};

const TIMEOUT_MS = 5_000;
const MAX_OUTPUT = 20_000;

/*
 * The worker runs the model's code in a fresh V8 context that holds nothing from Node: no
 * require, process, fetch or timers. DONT_CONTEXTIFY matters: an ordinary context wraps an object
 * from Node's own realm, and `this.constructor.constructor` on it reaches Node's Function and from
 * there `process`. No host functions or objects are handed in either, code generation from strings
 * is off inside the context, and results cross back as strings, read by polling instead of
 * callbacks. As a second layer the worker drops require and the process methods that load native
 * code, and it runs with a memory cap and is terminated at the deadline.
 */
const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
const vm = require('node:vm');
for (const name of ['require', 'module', 'exports', '__filename', '__dirname']) delete globalThis[name];
for (const name of ['getBuiltinModule', 'binding', '_linkedBinding', 'dlopen', 'kill', 'chdir', 'loadEnvFile']) {
  try {
    Object.defineProperty(process, name, { value: undefined, writable: false, configurable: false });
  } catch {}
}

const context = vm.createContext(vm.constants.DONT_CONTEXTIFY, { codeGeneration: { strings: false, wasm: false } });
vm.runInContext(\`
  globalThis.__out = [];
  globalThis.__state = { done: false, result: '', error: '' };
  const format = (value) => {
    if (typeof value === 'string') return value;
    if (value === undefined) return 'undefined';
    if (typeof value === 'function') return '[Function]';
    try {
      const json = JSON.stringify(value, (key, item) => (typeof item === 'bigint' ? item.toString() + 'n' : item), 2);
      return json === undefined ? String(value) : json;
    } catch {
      return String(value);
    }
  };
  globalThis.__format = format;
  const write = (...items) => { __out.push(items.map(format).join(' ')); };
  globalThis.console = { log: write, info: write, warn: write, error: write, debug: write, table: write };
\`, context);

function finish() {
  const state = vm.runInContext('[String(__state.done), String(__state.result), String(__state.error), __out.join("\\\\n")]', context);
  parentPort.postMessage({ result: String(state[1]), error: String(state[2]), output: String(state[3]) });
}

try {
  let script;
  try {
    script = new vm.Script(workerData.code, { filename: 'run_js.js' });
  } catch (error) {
    // Top-level await needs an async function around the code.
    if (!/await/.test(String(error && error.message))) throw error;
    script = new vm.Script('(async () => {\\n' + workerData.code + '\\n})()', { filename: 'run_js.js' });
  }
  context.__value = script.runInContext(context, { timeout: workerData.timeout });
  vm.runInContext(\`
    Promise.resolve(__value).then(
      (value) => { __state.result = value === undefined ? '' : __format(value); __state.done = true; },
      (error) => { __state.error = String((error && error.stack) || error); __state.done = true; },
    );
  \`, context);
  const poll = () => {
    if (vm.runInContext('__state.done === true', context) === true) finish();
    else setTimeout(poll, 5);
  };
  poll();
} catch (error) {
  vm.runInContext('__state.done = true', context);
  parentPort.postMessage({ result: '', error: String((error && error.stack) || error), output: vm.runInContext('__out.join("\\\\n")', context) });
}
`;

export interface RunResult {
  result: string;
  error: string;
  output: string;
}

export function runSandboxed(code: string, signal?: AbortSignal, timeout = TIMEOUT_MS): Promise<RunResult> {
  return new Promise((resolve) => {
    const worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: { code, timeout },
      env: {},
      resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
    });
    let settled = false;
    const settle = (value: RunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      void worker.terminate();
      resolve(value);
    };
    const onAbort = () => settle({ result: '', error: 'Stopped.', output: '' });
    const timer = setTimeout(() => settle({ result: '', error: `Timed out after ${timeout / 1000} seconds.`, output: '' }), timeout + 1_000);
    signal?.addEventListener('abort', onAbort, { once: true });
    worker.once('message', (message: RunResult) => settle(message));
    worker.once('error', (error) => settle({ result: '', error: error.message, output: '' }));
    worker.once('exit', (exitCode) => settle({ result: '', error: `The sandbox stopped (exit code ${exitCode}), probably out of memory.`, output: '' }));
  });
}

function clip(text: string): string {
  return text.length > MAX_OUTPUT ? `${text.slice(0, MAX_OUTPUT)}\n[Output truncated to ${MAX_OUTPUT} characters]` : text;
}

export const RUN_JS_TOOL: ToolDefinition = {
  group: 'code',
  label: 'Run JavaScript',
  defaultPolicy: 'auto',
  spec: {
    name: 'run_js',
    description:
      'Run JavaScript and get back console output and the value of the last expression. Use it for arithmetic, dates, ' +
      'statistics, unit conversions, parsing and transforming data, or checking an algorithm, instead of working it out by hand. ' +
      'Standard built-ins (Math, JSON, Date, Intl, RegExp, typed arrays, BigInt) are available and top-level await works. ' +
      `There is no network, file system, require or import, and each run is limited to ${TIMEOUT_MS / 1000} seconds. Nothing persists between runs.`,
    parameters: {
      type: 'object',
      properties: {
        code: { type: 'string', minLength: 1, description: 'The JavaScript to run' },
      },
      required: ['code'],
      additionalProperties: false,
    },
  },
  async run(args, context) {
    const { result, error, output } = await runSandboxed(String(args.code), context.signal);
    const parts = [output ? `Console output:\n${output}` : null, result ? `Result: ${result}` : null, error ? `Error: ${error}` : null].filter(Boolean);
    const content = clip(parts.join('\n\n') || 'The code ran and produced no output.');
    return { content: error && !output && !result ? content : content, isError: Boolean(error) };
  },
};

export function codeTools(): ToolSource {
  return { groups: async () => [CODE_GROUP], tools: async () => [RUN_JS_TOOL] };
}
