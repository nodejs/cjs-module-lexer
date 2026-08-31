import { access, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

import { corpus } from './corpus.mjs';
import { generateCases, generationLimits } from './generate.mjs';
import { reduceSource } from './reduce.mjs';

const MODES = ['js', 'wasm', 'wasm-sync'];
const MAX_TIMEOUT_MS = 30000;
const MAX_TOTAL_SOURCE_BYTES = 16 * 1024 * 1024;

/**
 * @typedef {{ exports: string[], reexports: string[] }} ParseResult
 * @typedef {object} FuzzCase
 * @property {string} name
 * @property {string} source
 * @property {ParseResult} [expected]
 * @property {'structured' | 'metamorphic' | 'robustness'} kind
 * @typedef {{ ok: true, value: ParseResult } |
 *   { ok: false, error: { name: string, code?: string, idx?: number } }} CaseResult
 * @typedef {{ mode: string, results: CaseResult[] }} ModeRun
 * @typedef {object} FuzzOptions
 * @property {string} target
 * @property {number} seed
 * @property {number} cases
 * @property {number} maximumSourceBytes
 * @property {number} timeoutMs
 * @property {'structured' | 'metamorphic' | 'robustness' | 'all'} mode
 * @property {string} [corpusPath]
 */

/**
 * @param {string[]} argumentsList
 * @returns {FuzzOptions}
 */
export function parseArgs (argumentsList) {
  const options = {
    target: process.cwd(),
    seed: 1,
    cases: 300,
    maximumSourceBytes: 8192,
    timeoutMs: 5000,
    mode: 'all'
  };

  for (let index = 0; index < argumentsList.length; index += 2) {
    const option = argumentsList[index];
    const value = argumentsList[index + 1];
    if (value === undefined) {
      throw new Error(`missing value for ${option}`);
    }
    if (option === '--target') {
      options.target = value;
    } else if (option === '--seed') {
      options.seed = readInteger(option, value, 0, 0xFFFFFFFF);
    } else if (option === '--cases') {
      options.cases = readInteger(option, value, 1, generationLimits.cases);
    } else if (option === '--max-bytes') {
      options.maximumSourceBytes = readInteger(option, value, 32, generationLimits.sourceBytes);
    } else if (option === '--timeout-ms') {
      options.timeoutMs = readInteger(option, value, 1, MAX_TIMEOUT_MS);
    } else if (option === '--mode') {
      if (!['structured', 'metamorphic', 'robustness', 'all'].includes(value)) {
        throw new Error(`unknown mode ${value}`);
      }
      options.mode = value;
    } else if (option === '--corpus') {
      options.corpusPath = value;
    } else {
      throw new Error(`unknown option ${option}`);
    }
  }

  return options;
}

/**
 * @param {FuzzOptions} options
 */
export async function runFuzz (options) {
  const target = resolve(options.target);
  await validateTarget(target);
  const externalCases = options.corpusPath ? await loadCorpus(options.corpusPath, options.maximumSourceBytes) : [];
  const generated = generateCases(options.seed, options.cases, options.maximumSourceBytes, options.mode);
  const cases = [...corpus, ...externalCases, ...generated];
  cases.sort((left, right) => Number(left.kind === 'robustness') - Number(right.kind === 'robustness'));
  validateTotalSourceBytes(cases);
  const outcomes = await Promise.allSettled(MODES.map(runSelectedMode));
  const runs = [];
  for (const outcome of outcomes) {
    if (outcome.status === 'rejected') throw outcome.reason;
    runs.push(outcome.value);
  }

  for (let index = 0; index < cases.length; index++) {
    try {
      verifyCase(cases[index], runs, index);
    } catch (error) {
      if (error instanceof FuzzFailure) {
        error.source = await reduceFailure(error, cases[index], target, options.timeoutMs);
      }
      throw error;
    }
  }

  return {
    target,
    seed: options.seed,
    generated: generated.length,
    corpus: corpus.length + externalCases.length
  };

  /**
   * @param {string} mode
   */
  function runSelectedMode (mode) {
    return runMode(mode, target, cases, options.timeoutMs);
  }
}

/**
 * @param {string} option
 * @param {string} value
 * @param {number} minimum
 * @param {number} maximum
 */
function readInteger (option, value, minimum, maximum) {
  const integer = Number(value);
  if (!Number.isInteger(integer) || integer < minimum || integer > maximum) {
    throw new RangeError(`${option} must be between ${minimum} and ${maximum}`);
  }
  return integer;
}

/**
 * @param {string} target
 */
async function validateTarget (target) {
  const packageJson = JSON.parse(await readFile(`${target}/package.json`, 'utf8'));
  if (packageJson.name !== 'cjs-module-lexer') {
    throw new Error(`target is not cjs-module-lexer: ${target}`);
  }
  await Promise.all([
    access(`${target}/lexer.js`),
    access(`${target}/dist/lexer.mjs`),
    access(`${target}/dist/lexer.js`)
  ]);
}

/**
 * @param {string} corpusPath
 * @param {number} maximumSourceBytes
 * @returns {Promise<FuzzCase[]>}
 */
async function loadCorpus (corpusPath, maximumSourceBytes) {
  const path = resolve(corpusPath);
  const { size } = await stat(path);
  if (size > MAX_TOTAL_SOURCE_BYTES) {
    throw new RangeError(`external corpus cannot exceed ${MAX_TOTAL_SOURCE_BYTES} bytes`);
  }
  const parsed = JSON.parse(await readFile(path, 'utf8'));
  if (!Array.isArray(parsed)) {
    throw new TypeError('external corpus must be an array');
  }
  if (parsed.length > generationLimits.cases) {
    throw new RangeError(`external corpus cannot exceed ${generationLimits.cases} cases`);
  }
  const cases = new Array(parsed.length);
  for (let index = 0; index < parsed.length; index++) {
    cases[index] = validateCase(parsed[index], index, maximumSourceBytes);
  }
  return cases;
}

/**
 * @param {unknown} value
 * @param {number} index
 * @param {number} maximumSourceBytes
 * @returns {FuzzCase}
 */
function validateCase (value, index, maximumSourceBytes) {
  if (!value || typeof value !== 'object') {
    throw new TypeError(`corpus case ${index} must be an object`);
  }
  const { expected, kind, name, source } = value;
  if (typeof name !== 'string' || typeof source !== 'string') {
    throw new TypeError(`corpus case ${index} must have string name and source fields`);
  }
  if (Buffer.byteLength(source) > maximumSourceBytes) {
    throw new RangeError(`corpus case ${index} exceeds max-bytes`);
  }
  if (!['structured', 'metamorphic', 'robustness'].includes(kind)) {
    throw new TypeError(`corpus case ${index} has an unknown kind`);
  }
  if (kind !== 'robustness' && !isParseResult(expected)) {
    throw new TypeError(`corpus case ${index} must have an expected result`);
  }
  return { expected, kind, name, source };
}

/**
 * @param {FuzzCase[]} cases
 */
function validateTotalSourceBytes (cases) {
  let total = 0;
  for (const fuzzCase of cases) {
    total += Buffer.byteLength(fuzzCase.source);
    if (total > MAX_TOTAL_SOURCE_BYTES) {
      throw new RangeError(`total source bytes cannot exceed ${MAX_TOTAL_SOURCE_BYTES}`);
    }
  }
}

/**
 * @param {unknown} value
 */
function isParseResult (value) {
  return Boolean(value) && typeof value === 'object' &&
    Array.isArray(value.exports) && value.exports.every(isString) &&
    Array.isArray(value.reexports) && value.reexports.every(isString);
}

/**
 * @param {unknown} value
 */
function isString (value) {
  return typeof value === 'string';
}

/**
 * @param {string} mode
 * @param {string} target
 * @param {FuzzCase[]} cases
 * @param {number} timeoutMs
 * @returns {Promise<ModeRun>}
 */
function runMode (mode, target, cases, timeoutMs) {
  let activeIndex = -1;
  let completedResults;
  let settled = false;
  let rejectRun;
  let resolveRun;
  let timeoutError;
  const worker = new Worker(new URL('./worker.mjs', import.meta.url), {
    workerData: { cases, mode, target }
  });
  const timer = setTimeout(onTimeout, timeoutMs);
  return new Promise(executor);

  function onTimeout () {
    settled = true;
    timeoutError = new Error(`${mode} worker timed out at case ${activeIndex}`);
    void worker.terminate().then(onTerminated, rejectRun);
  }

  function onTerminated () {
    rejectRun(timeoutError);
  }

  /**
   * @param {(value: ModeRun) => void} resolvePromise
   * @param {(error: Error) => void} rejectPromise
   */
  function executor (resolvePromise, rejectPromise) {
    rejectRun = rejectPromise;
    resolveRun = resolvePromise;
    worker.on('message', onMessage);
    worker.once('error', onError);
    worker.once('exit', onExit);

    /**
     * @param {{ type: string, index?: number, results?: CaseResult[] }} message
     */
    function onMessage (message) {
      if (message.type === 'progress') {
        activeIndex = message.index;
        return;
      }
      if (message.type === 'result') {
        completedResults = message.results;
        void worker.terminate().catch(onError);
      }
    }

    /**
     * @param {Error} error
     */
    function onError (error) {
      // A queued worker error can arrive after timeout starts termination.
      /* c8 ignore next */
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rejectPromise(error);
    }

    /**
     * @param {number} code
     */
    function onExit (code) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (completedResults !== undefined) {
        resolveRun({ mode, results: completedResults });
        return;
      }
      const location = activeIndex === -1 ? 'during initialization' : `at case ${activeIndex}`;
      rejectPromise(new Error(`${mode} worker exited with code ${code} ${location}`));
    }
  }
}

/**
 * @param {FuzzCase} fuzzCase
 * @param {ModeRun[]} runs
 * @param {number} index
 */
function verifyCase (fuzzCase, runs, index) {
  if (fuzzCase.kind === 'robustness') {
    for (const run of runs) {
      const result = run.results[index];
      if (!result.ok) {
        if (result.error.name === 'RuntimeError') {
          throw new FuzzFailure(`${fuzzCase.name}: ${run.mode} returned a RuntimeError`, fuzzCase.source);
        }
      }
    }
    return;
  }
  for (const run of runs) {
    const result = run.results[index];
    if (!result.ok) {
      throw new FuzzFailure(`${fuzzCase.name}: ${run.mode} returned ${JSON.stringify(result.error)}`, fuzzCase.source);
    }
    if (!isDeepStrictEqual(result.value, fuzzCase.expected)) {
      const message = `${fuzzCase.name}: ${run.mode} returned ${JSON.stringify(result.value)}, ` +
        `expected ${JSON.stringify(fuzzCase.expected)}`;
      throw new FuzzFailure(
        message,
        fuzzCase.source
      );
    }
  }
}

/**
 * @param {FuzzFailure} failure
 * @param {FuzzCase} fuzzCase
 * @param {string} target
 * @param {number} timeoutMs
 */
async function reduceFailure (failure, fuzzCase, target, timeoutMs) {
  return reduceSource(fuzzCase.source, preservesFailure);

  /**
   * @param {string} candidate
   */
  async function preservesFailure (candidate) {
    const candidateCase = { ...fuzzCase, source: candidate };
    const cases = [candidateCase];
    const runs = await Promise.all(MODES.map(runCandidateMode));
    try {
      verifyCase(candidateCase, runs, 0);
      return false;
    } catch (error) {
      return error instanceof FuzzFailure && error.message === failure.message;
    }

    /**
     * @param {string} mode
     */
    function runCandidateMode (mode) {
      return runMode(mode, target, cases, timeoutMs);
    }
  }
}

class FuzzFailure extends Error {
  /**
   * @param {string} message
   * @param {string} source
   */
  constructor (message, source) {
    super(message);
    this.source = source;
  }
}

/**
 * @param {Error} error
 * @param {FuzzOptions} options
 */
async function reportFailure (error, options) {
  const path = `${tmpdir()}/cjs-module-lexer-fuzz-${process.pid}.txt`;
  const source = error instanceof FuzzFailure ? `\n\n${error.source}\n` : '\n';
  await writeFile(path, `${error.stack}${source}`);
  console.error(`fuzz failed seed=${options.seed} details=${path}`);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  const options = parseArgs(process.argv.slice(2));
  try {
    const result = await runFuzz(options);
    const summary = `fuzz ok seed=${result.seed} generated=${result.generated} ` +
      `corpus=${result.corpus} target=${result.target}`;
    console.log(summary);
  } catch (error) {
    await reportFailure(error, options);
    process.exitCode = 1;
  }
}
