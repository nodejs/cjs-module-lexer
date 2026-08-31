import { pathToFileURL } from 'node:url';

const real = await import(pathToFileURL(process.env.CJS_FUZZ_REAL_WASM).href);

if (process.env.CJS_FUZZ_INITIALIZATION === 'error') {
  throw new Error('fixture initialization error');
}
if (process.env.CJS_FUZZ_INITIALIZATION === 'exit') {
  process.exit(7);
}

setInterval(Date.now, 1000);

export const init = real.init;
export const initSync = real.initSync;

/**
 * @param {string} source
 * @param {string} name
 */
export function parse (source, name) {
  if (source === 'runtime-error-wasm') {
    throw new WebAssembly.RuntimeError('fixture runtime error');
  }
  if (source === 'result-mismatch') {
    return { exports: ['wasm'], reexports: [] };
  }
  if (source === 'non-error') {
    throw 'fixture non-error';
  }
  if (source === 'worker-exit') {
    process.exit(7);
  }
  if (source === 'worker-timeout') {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30000);
  }
  return real.parse(source, name);
}
