const { parse: parseReal } = require(process.env.CJS_FUZZ_REAL_JS);

if (process.env.CJS_FUZZ_INITIALIZATION === 'error') {
  throw new Error('fixture initialization error');
}
if (process.env.CJS_FUZZ_INITIALIZATION === 'exit') {
  process.exit(7);
}

setInterval(Date.now, 1000);

/**
 * @param {string} source
 * @param {string} name
 */
function parse (source, name) {
  if (source === 'runtime-error-js') {
    throw new WebAssembly.RuntimeError('fixture runtime error');
  }
  if (source === 'result-mismatch') {
    return { exports: ['js'], reexports: [] };
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
  return parseReal(source, name);
}

module.exports.parse = parse;
