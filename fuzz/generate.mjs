const MAX_GENERATED_CASES = 10000;
const MAX_SOURCE_BYTES = 1024 * 1024;

export const generationLimits = {
  cases: MAX_GENERATED_CASES,
  sourceBytes: MAX_SOURCE_BYTES
};

export class Random {
  #state;

  /**
   * @param {number} seed
   */
  constructor (seed) {
    this.#state = seed >>> 0;
  }

  next () {
    this.#state = (Math.imul(this.#state, 1664525) + 1013904223) >>> 0;
    return this.#state;
  }

  /**
   * @param {number} maximum
   */
  integer (maximum) {
    return this.next() % maximum;
  }
}

/**
 * @typedef {{ exports: string[], reexports: string[] }} ParseResult
 * @typedef {object} FuzzCase
 * @property {string} name
 * @property {string} source
 * @property {ParseResult} [expected]
 * @property {'structured' | 'metamorphic' | 'robustness'} kind
 */

/**
 * @param {number} seed
 * @param {number} count
 * @param {number} maximumSourceBytes
 * @param {'structured' | 'metamorphic' | 'robustness' | 'all'} mode
 * @returns {FuzzCase[]}
 */
export function generateCases (seed, count, maximumSourceBytes, mode) {
  if (!Number.isInteger(count) || count < 1 || count > MAX_GENERATED_CASES) {
    throw new RangeError(`cases must be between 1 and ${MAX_GENERATED_CASES}`);
  }
  if (!Number.isInteger(maximumSourceBytes) || maximumSourceBytes < 32 || maximumSourceBytes > MAX_SOURCE_BYTES) {
    throw new RangeError(`max-bytes must be between 32 and ${MAX_SOURCE_BYTES}`);
  }

  const random = new Random(seed);
  const cases = new Array(count);
  for (let index = 0; index < count; index++) {
    const selectedMode = mode === 'all'
      ? ['structured', 'metamorphic', 'robustness'][index % 3]
      : mode;
    const structured = generateStructuredCase(random, index);
    let generated;
    if (selectedMode === 'metamorphic') {
      generated = metamorphose(structured, random);
    } else if (selectedMode === 'robustness') {
      generated = mutate(structured, random);
    } else {
      generated = structured;
    }
    cases[index] = capSource(generated, maximumSourceBytes);
  }
  return cases;
}

/**
 * @param {Random} random
 * @param {number} index
 * @returns {FuzzCase}
 */
function generateStructuredCase (random, index) {
  const first = `export${index}a`;
  const second = `export${index}b`;
  const dependency = `dependency-${index}`;
  const variant = random.integer(7);
  let source;
  let expected;

  switch (variant) {
    case 0:
      source = `exports.${first} = 0;\nmodule.exports.${second} = 0;`;
      expected = { exports: [first, second], reexports: [] };
      break;
    case 1:
      source = `Object.defineProperty(exports, ${JSON.stringify(first)}, { value: 0 });`;
      expected = { exports: [first], reexports: [] };
      break;
    case 2:
      source = `module.exports = { ${first}: binding, ${JSON.stringify(second)}: value };`;
      expected = { exports: [first, second], reexports: [] };
      break;
    case 3:
      source = `module.exports = require(${JSON.stringify(dependency)});`;
      expected = { exports: [], reexports: [dependency] };
      break;
    case 4:
      source = `__exportStar(require(${JSON.stringify(dependency)}));`;
      expected = { exports: [], reexports: [dependency] };
      break;
    case 5:
      source = `module.exports = { ...require(${JSON.stringify(dependency)}), ${first}: binding };`;
      expected = { exports: [first], reexports: [dependency] };
      break;
    default:
      source = `Object.defineProperty(exports, ${JSON.stringify(first)}, { ` +
        'enumerable: true, get: function () { return binding.value; } });';
      expected = { exports: [first], reexports: [] };
  }

  return {
    name: `generated-${index}`,
    source,
    expected,
    kind: 'structured'
  };
}

/**
 * @param {FuzzCase} fuzzCase
 * @param {Random} random
 * @returns {FuzzCase}
 */
function metamorphose (fuzzCase, random) {
  let source = fuzzCase.source;
  switch (random.integer(4)) {
    case 0:
      source = `/* before */\n${source}\n/* after */`;
      break;
    case 1:
      source = `\n\n${source}\n`;
      break;
    case 2:
      source = source.replaceAll('\n', '\r\n');
      break;
    default:
      source = `void 0;\n${source}\nvoid 0;`;
  }
  return {
    ...fuzzCase,
    name: `${fuzzCase.name}-metamorphic`,
    source,
    kind: 'metamorphic'
  };
}

/**
 * @param {FuzzCase} fuzzCase
 * @param {Random} random
 * @returns {FuzzCase}
 */
function mutate (fuzzCase, random) {
  const source = fuzzCase.source;
  const mutation = random.integer(4);
  let mutated;
  if (mutation === 0) {
    mutated = source.slice(0, random.integer(source.length + 1));
  } else if (mutation === 1) {
    const index = random.integer(source.length + 1);
    mutated = `${source.slice(0, index)}/*${source.slice(index)}`;
  } else if (mutation === 2) {
    const index = random.integer(source.length + 1);
    mutated = `${source.slice(0, index)}'${source.slice(index)}`;
  } else {
    mutated = `${source}${')]}'.repeat(random.integer(8) + 1)}`;
  }
  return {
    name: `${fuzzCase.name}-robustness`,
    source: mutated,
    kind: 'robustness'
  };
}

/**
 * @param {FuzzCase} fuzzCase
 * @param {number} maximumSourceBytes
 * @returns {FuzzCase}
 */
function capSource (fuzzCase, maximumSourceBytes) {
  if (Buffer.byteLength(fuzzCase.source) <= maximumSourceBytes) {
    return fuzzCase;
  }
  if (fuzzCase.kind !== 'robustness') {
    return {
      name: `${fuzzCase.name}-capped`,
      source: fuzzCase.kind === 'metamorphic' ? '\nexports.x=0;\n' : 'exports.x=0;',
      expected: { exports: ['x'], reexports: [] },
      kind: fuzzCase.kind
    };
  }
  return {
    name: `${fuzzCase.name}-capped`,
    source: fuzzCase.source.slice(0, Math.floor(maximumSourceBytes / 4)),
    kind: 'robustness'
  };
}
