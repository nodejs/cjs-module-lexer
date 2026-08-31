import { createRequire } from 'node:module';
import { parentPort, workerData } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const { cases, mode, target } = workerData;

const parse = await loadParser(target, mode);
const results = new Array(cases.length);

for (let index = 0; index < cases.length; index++) {
  parentPort.postMessage({ type: 'progress', index });
  try {
    const { exports, reexports } = parse(cases[index].source, cases[index].name);
    results[index] = { ok: true, value: { exports, reexports } };
  } catch (error) {
    results[index] = { ok: false, error: normalizeError(error) };
  }
}

parentPort.postMessage({ type: 'result', results });

/**
 * @param {string} targetDirectory
 * @param {'js' | 'wasm' | 'wasm-sync'} parserMode
 */
async function loadParser (targetDirectory, parserMode) {
  if (parserMode === 'js') {
    return require(`${targetDirectory}/lexer.js`).parse;
  }
  if (parserMode === 'wasm') {
    const module = await import(pathToFileURL(`${targetDirectory}/dist/lexer.mjs`).href);
    await module.init();
    return module.parse;
  }
  const module = require(`${targetDirectory}/dist/lexer.js`);
  module.initSync();
  return module.parse;
}

/**
 * @param {unknown} error
 */
function normalizeError (error) {
  if (!(error instanceof Error)) {
    return { name: typeof error };
  }
  return {
    name: error.name,
    code: error.code,
    idx: error.idx
  };
}
