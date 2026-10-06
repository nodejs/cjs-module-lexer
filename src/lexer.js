let wasm;

const isLE = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
const hasBuffer = typeof Buffer !== 'undefined';

/**
 * @param {string} source
 * @param {string} [name]
 * @param {import('../lexer').ParseOptions} [options]
 */
export function parse (source, name = '@', options) {
  const mode = options ? options.mode : undefined;
  if (mode !== undefined && mode !== 'default' && mode !== 'extended')
    throw new TypeError('Expected options.mode to be "default" or "extended".');
  const flags = (options && options.allowMinifiedEnumerable === true ? 1 : 0) |
    (mode === 'extended' ? 2 : 0);
  const baseline = options === undefined ? undefined : options.baseline;
  if (baseline !== undefined && typeof baseline !== 'string')
    throw new TypeError('Detection baseline must be a string');
  if (baseline !== undefined && baseline !== 'legacy' && baseline !== 'flow-v1')
    throw new RangeError('Unknown detection baseline: ' + baseline);
  if (!wasm)
    initSync();

  const len = source.length;

  // sa(len) writes a terminator at index len.
  let memory = wasm.memory.buffer;
  const extraMem = (wasm.__heap_base.value || wasm.__heap_base) + (len + 1) * 2 - memory.byteLength;
  if (extraMem > 0) {
    wasm.memory.grow(Math.ceil(extraMem / 65536));
    memory = wasm.memory.buffer;
  }
    
  const addr = wasm.sa(len);
  // Buffer setup is slower than the loop for short sources.
  if (len >= 64 && hasBuffer)
    Buffer.from(memory, addr, len * 2).write(source, 'utf16le');
  else
    (isLE ? copyLE : copyBE)(source, new Uint16Array(memory, addr, len));

  const status = baseline === 'legacy' ? wasm.parseCJSWithOptions(addr, len, 0, 0, 0, 0, flags) :
    wasm.parseCJSGrouped(addr, len, flags);
  const err_code = status & 255;

  if (err_code) {
    const err = new Error(`Parse error ${name}${wasm.e()}:${source.slice(0, wasm.e()).split('\n').length}:${wasm.e() - source.lastIndexOf('\n', wasm.e() - 1)}`);
    Object.assign(err, { idx: wasm.e() });
    if (err_code === 5 || err_code === 6 || err_code === 7)
      Object.assign(err, { code: 'ERR_LEXER_ESM_SYNTAX' });
    throw err;
  }

  let exports = new Set(), reexports = new Set(), unsafeGetters;
  const groups = status & 1024 ? [] : undefined;
  let complete = !(status & 2048);
  
  while (wasm.rre()) {
    const start = wasm.res();
    if (start === -1) {
      reexports = new Set();
      groups.push(reexports);
      continue;
    }
    const reexptStr = decode(source.slice(start, wasm.ree()));
    if (reexptStr !== undefined)
      reexports.add(reexptStr);
    else if (reexptStr === undefined)
      complete = false;
  }
  while (wasm.ru()) {
    if (!unsafeGetters) unsafeGetters = new Set();
    unsafeGetters.add(decode(source.slice(wasm.us(), wasm.ue())));
  }
  while (wasm.re()) {
    const text = source.slice(wasm.es(), wasm.ee());
    let exptStr = status & 1024 && text.charCodeAt(0) >= 48 && text.charCodeAt(0) <= 57 ?
      String(Number(text)) : decode(text);
    if (exptStr !== undefined && (!unsafeGetters || !unsafeGetters.has(exptStr)))
      exports.add(exptStr);
    else if (exptStr === undefined)
      complete = false;
  }

  if (!(status & 1024)) return { exports: [...exports], reexports: [...reexports] };
  if (groups.length === 1)
    return { exports: [...exports], reexports: [...reexports], complete };
  const alternatives = [];
  const seen = new Set();
  let hasDependencies = false;
  for (const group of groups) {
    const values = [...group];
    const key = JSON.stringify(values);
    if (seen.has(key)) continue;
    seen.add(key);
    alternatives.push(values);
    if (values.length) hasDependencies = true;
  }
  return { exports: [...exports], reexports: hasDependencies ? alternatives.length === 1 ? alternatives[0] : alternatives : [], complete };
}

function decode (str) {
  if (str[0] === '"' || str[0] === '\'') {
    try {
      const decoded = scanStringLiteral(str);
      // Filter to exclude non-matching UTF-16 surrogate strings
      for (let i = 0; i < decoded.length; i++) {
        const surrogatePrefix = decoded.charCodeAt(i) & 0xFC00;
        if (surrogatePrefix < 0xD800) {
          // Not a surrogate
          continue;
        }
        else if (surrogatePrefix === 0xD800) {
          // Validate surrogate pair
          if ((decoded.charCodeAt(++i) & 0xFC00) !== 0xDC00)
            return;
        }
        else {
          // Out-of-range surrogate code (above 0xD800)
          return;
        }
      }
      return decoded;
    }
    catch {}
  }
  else {
    return str;
  }
}


function scanStringLiteral (source) {
  const quote = source[0];

  // try JSON.parse first for performance
  if (quote === '"') {
    try {
      return JSON.parse(source);
    } catch {
      // ignored
    }
  } else if (quote === "'" && source.length > 1 && source[source.length - 1] === "'" && source.indexOf('"') === -1) {
    try {
      return JSON.parse('"' + source.slice(1, -1) + '"');
    } catch {
      // ignored
    }
  }

  // fall back to doing it the hard way
  let parsed = '';
  let index = { v: 1 };

  while (index.v < source.length) {
    const char = source[index.v];
    switch (char) {
      case quote: {
        return parsed;
      }
      case '\\': {
        ++index.v;
        parsed += scanEscapeSequence(source, index);
        break;
      }
      case '\r':
      case '\n': {
        throw new SyntaxError();
      }
      default: {
        ++index.v;
        parsed += char;
      }
    }
  }

  throw new SyntaxError();
}

function scanEscapeSequence (source, index) {
  if (index.v === source.length) {
    throw new SyntaxError();
  }
  const char = source[index.v];
  ++index.v;
  switch (char) {
    case '\r': {
      if (source[index.v] === '\n') {
        ++index.v;
      }
      // fall through
    }
    case '\n':
    case '\u2028':
    case '\u2029': {
      return '';
    }
    case 'r': {
      return '\r';
    }
    case 'n': {
      return '\n';
    }
    case 't': {
      return '\t';
    }
    case 'b': {
      return '\b';
    }
    case 'f': {
      return '\f';
    }
    case 'v': {
      return '\v';
    }
    case 'x': {
      return scanHexEscapeSequence(source, index);
    }
    case 'u': {
      return scanUnicodeEscapeSequence(source, index);
    }
    case '0':
    case '1':
    case '2':
    case '3':
    case '4':
    case '5':
    case '6':
    case '7': {
      return scanOctalEscapeSequence(char, source, index);
    }
    default: {
      return char;
    }
  }
}

function scanHexEscapeSequence (source, index) {
  const a = readHex(source[index.v]);
  ++index.v;
  const b = readHex(source[index.v]);
  ++index.v;
  return String.fromCodePoint(a * 16 + b);
}

function scanUnicodeEscapeSequence (source, index) {
  let result = 0;
  if (source[index.v] === '{') {
    ++index.v;
    do {
      result = result * 16 + readHex(source[index.v]);
      if (result > 0x10FFFF) {
        throw new SyntaxError();
      }
      ++index.v;
    } while (source[index.v] !== '}');
    ++index.v;
  } else {
    for (let i = 0; i < 4; ++i) {
      result = result * 16 + readHex(source[index.v]);
      ++index.v;
    }
  }
  return String.fromCodePoint(result);
}

function scanOctalEscapeSequence (char, source, index) {
  let toRead = char <= '3' ? 2 : 1;
  let result = +char;
  do {
    char = source[index.v];
    if (char < '0' || char > '7') {
      break;
    }
    result = result * 8 + (+char);
    ++index.v;
    --toRead;
  } while (toRead > 0);
  return String.fromCodePoint(result);
}

function readHex (char) {
  if (char >= '0' && char <= '9') {
    return +char;
  } else if (char >= 'a' && char <= 'f') {
    return char.charCodeAt(0) - 87;
  } else if (char >= 'A' && char <= 'F') {
    return char.charCodeAt(0) - 55;
  }
  throw new SyntaxError();
}



/**
 * @param {string} src
 * @param {Uint16Array} outBuf16
 */
function copyBE (src, outBuf16) {
  const len = src.length;
  let i = 0;
  while (i < len) {
    const ch = src.charCodeAt(i);
    outBuf16[i++] = (ch & 0xff) << 8 | ch >>> 8;
  }
}

/**
 * @param {string} src
 * @param {Uint16Array} outBuf16
 */
function copyLE (src, outBuf16) {
  const len = src.length;
  let i = 0;
  while (i < len)
    outBuf16[i] = src.charCodeAt(i++);
}

function getWasmBytes() {
  const binary = 'WASM_BINARY';  // This string will be replaced by build.js.
  if (typeof Buffer !== 'undefined')
    return Buffer.from(binary, 'base64');
  return Uint8Array.from(atob(binary), x => x.charCodeAt(0));
}

let initPromise;
export function init () {
  if (initPromise)
    return initPromise;
  return initPromise = (async () => {
    const compiled = await WebAssembly.compile(getWasmBytes());
    const { exports } = await WebAssembly.instantiate(compiled);
    wasm = exports;
  })();
}

export function initSync () {
  if (wasm) {
    return;
  }
  const compiled = new WebAssembly.Module(getWasmBytes());
  const { exports } = new WebAssembly.Instance(compiled);
  wasm = exports;
  return;
}
