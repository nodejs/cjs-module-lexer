const { execFileSync } = require('node:child_process');
const path = require('node:path');

/**
 * @param {string} source
 * @param {string} name
 * @param {import('../../lexer').ParseOptions} options
 */
exports.parse = function parse (source, name = '@', options) {
  const mode = options?.mode;
  if (mode !== undefined && mode !== 'default' && mode !== 'extended')
    throw new TypeError('Expected options.mode to be "default" or "extended".');
  const flags = (options?.allowMinifiedEnumerable === true ? 1 : 0) | (mode === 'extended' ? 2 : 0);
  const executable = process.env.NATIVE_LEXER || path.join(__dirname,
    process.platform === 'win32' ? '../../build/native/Debug/native_parse.exe' : '../../build/native/native_parse');
  const result = JSON.parse(execFileSync(executable, [String(flags)], {
    input: Buffer.from(source, 'utf16le'), maxBuffer: 16 * 1024 * 1024
  }));
  if (result.status) {
    const error = new Error(`Parse error ${name}${result.idx}`);
    error.idx = result.idx;
    if (result.code === 5 || result.code === 6 || result.code === 7) error.code = 'ERR_LEXER_ESM_SYNTAX';
    throw error;
  }
  return { exports: [...new Set(result.exports)], reexports: [...new Set(result.reexports)] };
};
