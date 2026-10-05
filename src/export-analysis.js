/**
 * @typedef {string | number | boolean | null | undefined} FlowPrimitive
 * @typedef {{ text: string, start: number, end: number }} FlowToken
 * @typedef {{ type: 'literal', value: FlowPrimitive, start: number, end: number }} FlowLiteral
 * @typedef {{ type: 'identifier', name: string, start: number, end: number }} FlowIdentifier
 * @typedef {{ type: 'member', object: FlowExpression, key: FlowExpression, start: number, end: number }} FlowMember
 * @typedef {{ type: 'call', callee: FlowExpression, args: FlowExpression[], start: number, end: number }} FlowCall
 * @typedef {{ type: 'unary', operator: string, argument: FlowExpression, start: number, end: number }} FlowUnary
 * @typedef {{ type: 'binary', operator: string, left: FlowExpression, right: FlowExpression,
 *   start: number, end: number }} FlowBinary
 * @typedef {{ type: 'conditional', test: FlowExpression, consequent: FlowExpression, alternate: FlowExpression,
 *   start: number, end: number }} FlowConditional
 * @typedef {{ type: 'object', entries: { key?: string, value: FlowExpression }[],
 *   start: number, end: number }} FlowObject
 * @typedef {FlowLiteral | FlowIdentifier | FlowMember | FlowCall | FlowUnary | FlowBinary |
 *   FlowConditional | FlowObject} FlowExpression
 * @typedef {{ type: 'block', body: FlowStatement[], start: number, end: number } |
 *   { type: 'if', test: FlowExpression, consequent: FlowStatement, alternate?: FlowStatement,
 *     start: number, end: number } |
 *   { type: 'expression', expression: FlowExpression, start: number, end: number } |
 *   { type: 'empty', start: number, end: number }} FlowStatement
 * @typedef {import('../lexer').FlowExportValue} FlowValue
 * @typedef {{ value: FlowValue, conditions: import('../lexer').FlowCondition[] }} FlowState
 * @typedef {{ source: string, decode: (text: string) => string | undefined, tokens: FlowToken[], pos: number,
 *   depth: number, steps: number, branches: number }} FlowContext
 * @typedef {{ state: FlowState, value: FlowValue }} FlowEvaluation
 */

let flowPowers;
let flowPatterns;
const flowLimits = { tokens: 8192, depth: 64, outcomes: 32, steps: 65536 };
const flowSequence = /^(?:\s*module\.exports\s*=\s*require\(((['"])(?:\\.|(?!\2)[^\\])*\2)\);){2,}\s*$/;

class FlowFailure extends Error {
  /** @param {string} reason @param {number} start @param {number} end */
  constructor (reason, start, end) {
    super(reason);
    this.reason = reason;
    this.start = start;
    this.end = end;
  }
}

/**
 * @param {string} source
 * @param {import('../lexer').ParseOptions['baseline']} baseline
 * @param {number} [replacements]
 * @param {(text: string) => string | undefined} decode
 * @param {import('../lexer').Exports} [legacy]
 */
function analyzeExports (source, baseline, replacements, decode, legacy) {
  if (baseline === 'legacy') return legacy;
  if (baseline !== undefined && typeof baseline !== 'string')
    throw new TypeError('Detection baseline must be a string');
  if (baseline !== undefined && baseline !== 'flow-v1') throw new RangeError('Unknown detection baseline: ' + baseline);
  if (baseline === undefined) {
    // Legacy consumers do not read the report, so defer analysis until the first read.
    Object.defineProperty(legacy, 'analysis', { configurable: true, get () {
      const report = analyzeExports(source, 'flow-v1', replacements, decode);
      Object.defineProperty(legacy, 'analysis', { value: report, configurable: false });
      return report;
    } });
    return legacy;
  }
  const sequence = source.length <= 4096 ? flowSequence.exec(source) : undefined;
  if (replacements === undefined) {
    if (!sequence && source.indexOf('module', source.indexOf('module') + 6) !== -1) return;
    replacements = sequence ? 2 : 0;
  }
  const specifier = sequence ? decode(sequence[1]) : undefined;
  const report = replacements < 2 ? { baseline: 'flow-v1', complete: false,
    outcomes: [{ conditions: [], value: { kind: 'unknown', reason: 'insufficient-replacements' } }] } :
    specifier !== undefined ?
    { baseline: 'flow-v1', complete: true,
      outcomes: [{ conditions: [], value: { kind: 'module', specifier } }] } :
    analyzeReplacements(source, decode);
  return report;
}

/** @param {string} source @param {(text: string) => string | undefined} decode */
function analyzeReplacements (source, decode) {
  if (flowPowers === undefined) {
    flowPatterns = {
      whitespace: /\s/, lineBreak: /[\r\n\u2028\u2029]/, identifierStart: /[a-zA-Z_$]/,
      identifierPart: /[a-zA-Z0-9_$]/, identifier: /^[a-zA-Z_$][a-zA-Z0-9_$]*$/,
      digit: /[0-9]/, numericStart: /^\d/, legacyNumber: /^0\d/,
      number: /^(?:0[xX][\da-fA-F]+|0[bB][01]+|0[oO][0-7]+|\d+(?:\.\d*)?(?:[eE][+-]?\d+)?)/,
      operator: /^(?:\.\.\.|===|!==|&&=|\|\|=|\?\?=|&&|\|\||\?\?|==|!=|<=|>=|=>|\+\+|--)/
    };
    flowPowers = new Map([
      [',', 1], ['=', 2], ['&&=', 2], ['||=', 2], ['??=', 2], ['?', 3],
      ['||', 4], ['??', 4], ['&&', 5], ['===', 6], ['!==', 6], ['==', 6], ['!=', 6],
      ['<', 7], ['>', 7], ['<=', 7], ['>=', 7], ['+', 8], ['-', 8], ['*', 9], ['%', 9]
    ]);
  }
  /** @type {FlowContext} */
  const context = { source, decode, tokens: [], pos: 0, depth: 0, steps: 0, branches: 0 };
  try {
    tokenizeFlow(context);
    const body = [];
    while (context.pos < context.tokens.length) body.push(readFlowStatement(context));
    validateFlowDepth(context, body);
    const outcomes = executeFlowBody(context, body, [{ conditions: [], value: { kind: 'object', properties: [] } }]);
    return { baseline: 'flow-v1', complete: outcomes.every(
      /** @param {FlowState} outcome */ outcome => outcome.value.kind !== 'unknown'
    ), outcomes };
  } catch (error) {
    if (!(error instanceof FlowFailure)) throw error;
    return { baseline: 'flow-v1', complete: false, outcomes: [{ conditions: [],
      value: { kind: 'unknown', reason: error.reason, start: error.start, end: error.end } }] };
  }
}

/** @param {FlowContext} context @param {string} reason @param {number} [start] @param {number} [end] */
function failFlow (context, reason, start, end) {
  const token = context.tokens[context.pos];
  if (start === undefined) start = token ? token.start : context.source.length;
  if (end === undefined) end = token ? token.end : start;
  throw new FlowFailure(reason, start, end);
}

/** @param {FlowContext} context */
function stepFlow (context) {
  if (++context.steps > flowLimits.steps) failFlow(context, 'work-limit');
}

/** @param {string} source @param {number} start */
function flowLineEnd (source, start) {
  while (start < source.length && !flowPatterns.lineBreak.test(source[start])) start++;
  return start;
}

/** @param {FlowContext} context */
function tokenizeFlow (context) {
  const source = context.source;
  let pos = source.startsWith('#!') ? flowLineEnd(source, 2) : 0;
  while (pos < source.length) {
    stepFlow(context);
    const start = pos;
    const ch = source[pos];
    if (flowPatterns.whitespace.test(ch)) { pos++; continue; }
    if (source.startsWith('//', pos)) {
      pos = flowLineEnd(source, pos + 2);
      continue;
    }
    if (source.startsWith('/*', pos)) {
      const next = source.indexOf('*/', pos + 2);
      if (next === -1) failFlow(context, 'unterminated-comment', start, source.length);
      pos = next + 2;
      continue;
    }
    if (ch === '"' || ch === "'") {
      pos++;
      while (pos < source.length && source[pos] !== ch) {
        if (source[pos] === '\\') pos++;
        pos++;
      }
      if (pos === source.length) failFlow(context, 'unterminated-string', start, pos);
      pos++;
    } else if (flowPatterns.identifierStart.test(ch)) {
      while (++pos < source.length && flowPatterns.identifierPart.test(source[pos])) {}
    } else if (flowPatterns.digit.test(ch)) {
      const number = flowPatterns.number.exec(source.slice(pos));
      pos += number[0].length;
      if (flowPatterns.legacyNumber.test(number[0])) failFlow(context, 'unsupported-number', start, pos);
    } else {
      const operator = flowPatterns.operator.exec(source.slice(pos));
      if (operator) pos += operator[0].length;
      else if ('{}()[];:,.?=+-!*%<>'.includes(ch)) pos++;
      else failFlow(context, 'unsupported-token', start, start + 1);
    }
    context.tokens.push({ text: source.slice(start, pos), start, end: pos });
    if (context.tokens.length > flowLimits.tokens) failFlow(context, 'token-limit', start, pos);
  }
}

/** @param {FlowContext} context @param {string} text */
function takeFlow (context, text) {
  const token = context.tokens[context.pos];
  if (!token || token.text !== text) return false;
  context.pos++;
  return true;
}

/** @param {FlowContext} context @param {string} text */
function expectFlow (context, text) {
  if (!takeFlow(context, text)) failFlow(context, 'unsupported-syntax');
}

/** @param {FlowContext} context */
function flowSemicolon (context) {
  if (takeFlow(context, ';') || context.pos === context.tokens.length ||
      context.tokens[context.pos].text === '}') return;
  const previous = context.tokens[context.pos - 1];
  if (!flowPatterns.lineBreak.test(context.source.slice(previous.end, context.tokens[context.pos].start))) {
    failFlow(context, 'unsupported-syntax');
  }
}

/** @param {FlowContext} context @returns {FlowStatement} */
function readFlowStatement (context) {
  stepFlow(context);
  if (++context.depth > flowLimits.depth) failFlow(context, 'depth-limit');
  const token = context.tokens[context.pos++];
  if (!token) failFlow(context, 'unsupported-syntax');
  const start = token.start;
  let result;
  if (token.text === ';') result = { type: 'empty', start, end: token.end };
  else if (token.text === '{') {
    const body = [];
    while (!context.tokens[context.pos] || context.tokens[context.pos].text !== '}') {
      body.push(readFlowStatement(context));
    }
    expectFlow(context, '}');
    result = { type: 'block', body, start, end: context.tokens[context.pos - 1].end };
  } else if (token.text === 'if') {
    expectFlow(context, '(');
    const test = readFlowExpression(context);
    expectFlow(context, ')');
    const consequent = readFlowStatement(context);
    const alternate = takeFlow(context, 'else') ? readFlowStatement(context) : undefined;
    result = { type: 'if', test, consequent, alternate, start, end: alternate ? alternate.end : consequent.end };
  } else {
    context.pos--;
    const expression = readFlowExpression(context);
    flowSemicolon(context);
    result = { type: 'expression', expression, start, end: context.tokens[context.pos - 1].end };
  }
  context.depth--;
  return result;
}

/** @param {FlowContext} context @param {number} [minimum] @returns {FlowExpression} */
function readFlowExpression (context, minimum = 1) {
  stepFlow(context);
  if (++context.depth > flowLimits.depth) failFlow(context, 'depth-limit');
  const token = context.tokens[context.pos++];
  if (!token) failFlow(context, 'unsupported-expression');
  let left;
  if (token.text === '(') {
    left = readFlowExpression(context);
    expectFlow(context, ')');
  } else if (token.text === '{') {
    const entries = [];
    while (!takeFlow(context, '}')) {
      if (takeFlow(context, '...')) failFlow(context, 'unsupported-object');
      else {
        const key = context.tokens[context.pos++];
        if (!key) failFlow(context, 'unsupported-object');
        const name = flowPatterns.numericStart.test(key.text) ? String(Number(key.text)) :
          key.text[0] === '"' || key.text[0] === "'" ? context.decode(key.text) : key.text;
        if (name === undefined || name === '__proto__') failFlow(context, 'unsupported-object', key.start, key.end);
        const value = takeFlow(context, ':') ? readFlowExpression(context, 2) :
          { type: 'identifier', name, start: key.start, end: key.end };
        entries.push({ key: name, value });
      }
      if (!takeFlow(context, ',')) { expectFlow(context, '}'); break; }
    }
    left = { type: 'object', entries, start: token.start, end: context.tokens[context.pos - 1].end };
  } else if (['!', '+', '-', 'void', 'typeof'].includes(token.text)) {
    const argument = readFlowExpression(context, 10);
    left = { type: 'unary', operator: token.text, argument, start: token.start, end: argument.end };
  } else if (token.text[0] === '"' || token.text[0] === "'" || flowPatterns.numericStart.test(token.text) ||
      ['true', 'false', 'null'].includes(token.text)) {
    const value = token.text[0] === '"' || token.text[0] === "'" ? context.decode(token.text) :
      token.text === 'true' ? true : token.text === 'false' ? false : token.text === 'null' ? null : Number(token.text);
    if (value === undefined) failFlow(context, 'unsupported-string', token.start, token.end);
    left = { type: 'literal', value, start: token.start, end: token.end };
  } else if (flowPatterns.identifier.test(token.text)) {
    left = { type: 'identifier', name: token.text, start: token.start, end: token.end };
  } else failFlow(context, 'unsupported-expression', token.start, token.end);

  while (context.pos < context.tokens.length) {
    stepFlow(context);
    const next = context.tokens[context.pos];
    if (next.text === '.' || next.text === '[') {
      context.pos++;
      let key;
      if (next.text === '.') {
        const property = context.tokens[context.pos++];
        if (!property || !flowPatterns.identifier.test(property.text)) failFlow(context, 'unsupported-member');
        key = { type: 'literal', value: property.text, start: property.start, end: property.end };
      } else { key = readFlowExpression(context); expectFlow(context, ']'); }
      left = { type: 'member', object: left, key, start: left.start, end: context.tokens[context.pos - 1].end };
      continue;
    }
    if (next.text === '(') {
      context.pos++;
      const args = [];
      if (!takeFlow(context, ')')) {
        do { args.push(readFlowExpression(context, 2)); } while (takeFlow(context, ','));
        expectFlow(context, ')');
      }
      left = { type: 'call', callee: left, args, start: left.start, end: context.tokens[context.pos - 1].end };
      continue;
    }
    const power = flowPowers.get(next.text);
    if (power === undefined || power < minimum) break;
    context.pos++;
    if (next.text === '?') {
      const consequent = readFlowExpression(context, 2);
      expectFlow(context, ':');
      const alternate = readFlowExpression(context, 2);
      left = { type: 'conditional', test: left, consequent, alternate, start: left.start, end: alternate.end };
    } else {
      const right = readFlowExpression(context, power === 2 ? power : power + 1);
      left = { type: 'binary', operator: next.text, left, right, start: left.start, end: right.end };
    }
  }
  context.depth--;
  return left;
}

/** @param {FlowContext} context @param {FlowStatement[]} body */
function validateFlowDepth (context, body) {
  /** @type {{ node: FlowStatement | FlowExpression, depth: number }[]} */
  const pending = [];
  for (const node of body) pending.push({ node, depth: 1 });
  while (pending.length) {
    const frame = pending.pop();
    const node = frame.node;
    stepFlow(context);
    if (frame.depth > flowLimits.depth) failFlow(context, 'depth-limit', node.start, node.end);
    const depth = frame.depth + 1;
    if (node.type === 'block') {
      for (const child of node.body) pending.push({ node: child, depth });
    } else if (node.type === 'if' || node.type === 'conditional') {
      pending.push({ node: node.test, depth }, { node: node.consequent, depth });
      if (node.alternate) pending.push({ node: node.alternate, depth });
    } else if (node.type === 'expression') pending.push({ node: node.expression, depth });
    else if (node.type === 'member') {
      pending.push({ node: node.object, depth }, { node: node.key, depth });
    } else if (node.type === 'call') {
      pending.push({ node: node.callee, depth });
      for (const argument of node.args) pending.push({ node: argument, depth });
    } else if (node.type === 'unary') pending.push({ node: node.argument, depth });
    else if (node.type === 'binary') {
      pending.push({ node: node.left, depth }, { node: node.right, depth });
    } else if (node.type === 'object') {
      for (const entry of node.entries) pending.push({ node: entry.value, depth });
    }
  }
}


/** @param {FlowContext} context @param {FlowStatement[]} body @param {FlowState[]} states */
function executeFlowBody (context, body, states) {
  for (const statement of body) {
    const next = [];
    for (const state of states) next.push(...executeFlowStatement(context, statement, state));
    states = next;
    if (states.length > flowLimits.outcomes) failFlow(context, 'outcome-limit');
  }
  return states;
}

/** @param {FlowContext} context @param {FlowStatement} statement @param {FlowState} state */
function executeFlowStatement (context, statement, state) {
  stepFlow(context);
  if (statement.type === 'empty') return [state];
  if (statement.type === 'block') return executeFlowBody(context, statement.body, [state]);
  const results = [];
  if (statement.type === 'expression') {
    for (const result of evaluateFlow(context, statement.expression, state)) results.push(result.state);
  } else {
    for (const test of evaluateFlow(context, statement.test, state)) {
      for (const branch of branchFlow(context, test, statement.test, false)) {
        const arm = branch.active ? statement.consequent : statement.alternate;
        results.push(...(arm ? executeFlowStatement(context, arm, branch.state) : [branch.state]));
      }
    }
  }
  return results;
}

/** @param {FlowExpression} node */
function isFlowReplacement (node) {
  return node.type === 'member' && node.object.type === 'identifier' && node.object.name === 'module' &&
    node.key.type === 'literal' && node.key.value === 'exports';
}

/** @param {FlowContext} context @param {FlowEvaluation} result @param {FlowExpression} test
 * @param {boolean} nullish */
function branchFlow (context, result, test, nullish) {
  const value = result.value;
  if (value.kind === 'literal' || value.kind === 'object') {
    const active = value.kind === 'object' ? !nullish : nullish ? value.value == null : !!value.value;
    return [{ state: result.state, active }];
  }
  if (++context.branches >= flowLimits.outcomes) failFlow(context, 'outcome-limit', test.start, test.end);
  return [true, false].map(/** @param {boolean} active */ active => ({ active, state: {
    value: result.state.value,
    conditions: result.state.conditions.concat({ start: test.start, end: test.end,
      when: nullish ? active ? 'nullish' : 'non-nullish' : active ? 'truthy' : 'falsy' })
  } }));
}

/** @param {FlowContext} context @param {FlowExpression} node @param {FlowState} state
 * @returns {FlowEvaluation[]} */
function evaluateFlow (context, node, state) {
  stepFlow(context);
  if (node.type === 'literal') return [{ state, value: { kind: 'literal', value: node.value } }];
  if (node.type === 'identifier' || node.type === 'member') {
    if (node.type === 'identifier' &&
        ['module', 'exports', 'require', 'function', 'return', 'throw'].includes(node.name))
      failFlow(context, 'unsupported-reference', node.start, node.end);
    if (isFlowReplacement(node)) failFlow(context, 'unsupported-reference', node.start, node.end);
    state.value = { kind: 'unknown', reason: 'opaque-read-effects' };
    return [{ state, value: state.value }];
  }
  if (node.type === 'call') {
    if (node.callee.type !== 'identifier' || node.callee.name !== 'require' || node.args.length !== 1 ||
        node.args[0].type !== 'literal' || typeof node.args[0].value !== 'string')
      failFlow(context, 'unsupported-call', node.start, node.end);
    state.value = { kind: 'unknown', reason: 'dependency-effects' };
    return [{ state, value: { kind: 'module', specifier: node.args[0].value } }];
  }
  if (node.type === 'object') {
    let results = [{ state, value: { kind: 'object', properties: [] } }];
    for (const entry of node.entries) {
      const next = [];
      for (const result of results) {
        for (const value of evaluateFlow(context, entry.value, result.state)) {
          const properties = result.value.properties.slice();
          if (!properties.includes(entry.key)) properties.push(entry.key);
          next.push({ state: value.state, value: { kind: 'object', properties } });
        }
      }
      results = next;
    }
    return results;
  }
  if (node.type === 'conditional') {
    const results = [];
    for (const test of evaluateFlow(context, node.test, state)) {
      for (const branch of branchFlow(context, test, node.test, false)) {
        results.push(...evaluateFlow(context, branch.active ? node.consequent : node.alternate, branch.state));
      }
    }
    return results;
  }
  if (node.type === 'unary') {
    const results = [];
    for (const result of evaluateFlow(context, node.argument, state)) {
      const primitive = result.value.kind === 'literal';
      const value = primitive ? result.value.value : undefined;
      if (!primitive && (node.operator === '+' || node.operator === '-'))
        failFlow(context, 'unsupported-coercion', node.start, node.end);
      const computed = node.operator === 'void' ? undefined : node.operator === 'typeof' ?
        primitive ? typeof value : undefined : node.operator === '!' ? !value : node.operator === '+' ? +value : -value;
      results.push({ state: result.state, value: !primitive && node.operator !== 'void' ?
        { kind: 'unknown', reason: 'unknown-condition' } : { kind: 'literal', value: computed } });
    }
    return results;
  }
  const assignment = ['=', '&&=', '||=', '??='].includes(node.operator);
  if (assignment && !isFlowReplacement(node.left)) failFlow(context, 'unsupported-assignment', node.start, node.end);
  const logical = ['&&', '||', '??', '&&=', '||=', '??='].includes(node.operator);
  const leftResults = assignment ? [{ state, value: state.value }] : evaluateFlow(context, node.left, state);
  const results = [];
  for (const left of leftResults) {
    if (logical) {
      if (assignment && left.value.kind !== 'literal' && left.value.kind !== 'object')
        failFlow(context, 'unknown-logical-assignment', node.start, node.end);
      for (const branch of branchFlow(context, left, node.left, node.operator.startsWith('??'))) {
        const active = node.operator.startsWith('||') ? !branch.active : branch.active;
        if (!active) results.push({ state: branch.state, value: left.value });
        else for (const right of evaluateFlow(context, node.right, branch.state)) {
          if (assignment) right.state.value = right.value;
          results.push(right);
        }
      }
    } else {
      for (const right of evaluateFlow(context, node.right, left.state)) {
        if (assignment) right.state.value = right.value;
        if (assignment || node.operator === ',') results.push(right);
        else {
          if (left.value.kind !== 'literal' || right.value.kind !== 'literal') {
            failFlow(context, 'unsupported-comparison', node.start, node.end);
          }
          const value = node.operator === '===' ? left.value.value === right.value.value :
            node.operator === '!==' ? left.value.value !== right.value.value : undefined;
          if (value === undefined) failFlow(context, 'unsupported-operator', node.start, node.end);
          results.push({ state: right.state, value: { kind: 'literal', value } });
        }
      }
    }
  }
  return results;
}

module.exports = analyzeExports;
