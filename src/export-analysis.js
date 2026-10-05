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
 *   { type: 'declaration', mode: string, declarations: { name: string, value?: FlowExpression }[],
 *     start: number, end: number } |
 *   { type: 'function', name: string, start: number, end: number } |
 *   { type: 'expression', expression: FlowExpression, start: number, end: number } |
 *   { type: 'return' | 'throw' | 'empty', start: number, end: number }} FlowStatement
 * @typedef {{ kind: 'literal', value: FlowPrimitive } |
 *   { kind: 'object', id: number } | { kind: 'module', id: number, specifier: string } |
 *   { kind: 'unknown', id: number, reason?: string } |
 *   { kind: 'module-object' | 'require' | 'uninitialized' }} FlowValue
 * @typedef {{ properties: Map<string, FlowValue>, reason?: string, start?: number, end?: number }} FlowOwnedObject
 * @typedef {{ bindings: Map<string, FlowValue>, objects: Map<number, FlowOwnedObject>,
 *   facts: Map<string, boolean>, conditions: import('../lexer').FlowCondition[], value: FlowValue,
 *   declared: Set<string>, constants: Set<string>, prototypeUnknown: boolean,
 *   completion: 'normal' | 'return' | 'throw' }} FlowState
 * @typedef {{ source: string, decode: (text: string) => string | undefined, tokens: FlowToken[], pos: number,
 *   depth: number, steps: number, branches: number, nextId: number, hasFunctions: boolean }} FlowContext
 * @typedef {{ state: FlowState, value: FlowValue }} FlowEvaluation
 * @typedef {{ kind: 'binding', name: string } | { kind: 'module' } |
 *   { kind: 'property', id: number, name: string }} FlowReference
 */

let flowPowers;
let flowPatterns;
const flowLimits = { tokens: 8192, depth: 64, outcomes: 32, steps: 65536 };

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
 * @param {import('../lexer').ParseOptions} options
 * @param {(text: string) => string | undefined} decode
 */
function analyzeExports (source, options, decode) {
  const baseline = options.baseline;
  if (baseline === undefined || baseline === 'legacy') return;
  if (typeof baseline !== 'string') throw new TypeError('Detection baseline must be a string');
  if (baseline !== 'flow-v1') throw new RangeError('Unknown detection baseline: ' + baseline);
  if (flowPowers === undefined) {
    flowPatterns = {
      whitespace: /\s/, lineBreak: /[\r\n]/, identifierStart: /[a-zA-Z_$]/,
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
  const context = { source, decode, tokens: [], pos: 0, depth: 0, steps: 0, branches: 0, nextId: 1,
    hasFunctions: false };
  try {
    tokenizeFlow(context);
    const body = [];
    while (context.pos < context.tokens.length) body.push(readFlowStatement(context));
    validateFlowDepth(context, body);
    /** @type {FlowValue} */
    const initial = { kind: 'object', id: 0 };
    /** @type {FlowState} */
    const state = {
      bindings: new Map([
        ['module', { kind: 'module-object' }], ['exports', initial], ['require', { kind: 'require' }]
      ]),
      objects: new Map([[0, { properties: new Map() }]]), facts: new Map(), conditions: [], value: initial,
      declared: new Set(['module', 'exports', 'require']), constants: new Set(), prototypeUnknown: false,
      completion: 'normal'
    };
    hoistFlowVars(body, state);
    const states = executeFlowBody(context, body, [state]);
    const outcomes = [];
    for (const result of states) {
      if (result.completion === 'throw') continue;
      outcomes.push({ conditions: result.conditions, value: reportFlowValue(result, result.value) });
    }
    return { baseline, complete: outcomes.every(
      /** @param {import('../lexer').ExportAnalysis['outcomes'][number]} outcome */
      outcome => outcome.value.kind !== 'unknown'
    ), outcomes };
  } catch (error) {
    if (!(error instanceof FlowFailure)) throw error;
    return { baseline, complete: false, outcomes: [{ conditions: [],
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

/** @param {FlowContext} context */
function tokenizeFlow (context) {
  const source = context.source;
  let pos = source.startsWith('#!') ? source.indexOf('\n') : 0;
  if (pos === -1) return;
  while (pos < source.length) {
    stepFlow(context);
    const start = pos;
    const ch = source[pos];
    if (flowPatterns.whitespace.test(ch)) { pos++; continue; }
    if (source.startsWith('//', pos)) {
      const next = source.indexOf('\n', pos + 2);
      pos = next === -1 ? source.length : next;
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
  } else if (['const', 'let', 'var'].includes(token.text)) {
    const declarations = [];
    do {
      const name = context.tokens[context.pos++];
      if (!name || !flowPatterns.identifier.test(name.text)) failFlow(context, 'unsupported-binding');
      const value = takeFlow(context, '=') ? readFlowExpression(context, 2) : undefined;
      declarations.push({ name: name.text, value });
    } while (takeFlow(context, ','));
    flowSemicolon(context);
    result = { type: 'declaration', mode: token.text, declarations, start,
      end: context.tokens[context.pos - 1].end };
  } else if (token.text === 'function') {
    context.hasFunctions = true;
    const name = context.tokens[context.pos++];
    if (!name || !flowPatterns.identifier.test(name.text)) failFlow(context, 'unsupported-function');
    skipFlowGroup(context, '(', ')');
    skipFlowGroup(context, '{', '}');
    result = { type: 'function', name: name.text, start, end: context.tokens[context.pos - 1].end };
  } else if (token.text === 'return' || token.text === 'throw') {
    if (context.tokens[context.pos] && ![';', '}'].includes(context.tokens[context.pos].text) &&
        !flowPatterns.lineBreak.test(context.source.slice(token.end, context.tokens[context.pos].start))) {
      failFlow(context, 'unsupported-completion-value', start, token.end);
    }
    flowSemicolon(context);
    result = { type: token.text, start, end: context.tokens[context.pos - 1].end };
  } else {
    context.pos--;
    const expression = readFlowExpression(context);
    flowSemicolon(context);
    result = { type: 'expression', expression, start, end: context.tokens[context.pos - 1].end };
  }
  context.depth--;
  return result;
}

/** @param {FlowContext} context @param {string} open @param {string} close */
function skipFlowGroup (context, open, close) {
  expectFlow(context, open);
  let depth = 1;
  while (depth) {
    stepFlow(context);
    const token = context.tokens[context.pos++];
    if (!token) failFlow(context, 'unsupported-syntax');
    if (token.text === open) depth++;
    else if (token.text === close) depth--;
  }
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
      if (takeFlow(context, '...')) entries.push({ value: readFlowExpression(context, 2) });
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
  } else if (['!', '+', '-', 'void', 'typeof', 'delete'].includes(token.text)) {
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
    } else if (node.type === 'declaration') {
      for (const declaration of node.declarations) {
        if (declaration.value) pending.push({ node: declaration.value, depth });
      }
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

/** @param {FlowState} state */
function cloneFlowState (state) {
  const objects = new Map();
  for (const [id, object] of state.objects) {
    objects.set(id, {
      properties: new Map(object.properties), reason: object.reason, start: object.start, end: object.end
    });
  }
  return { bindings: new Map(state.bindings), objects, facts: new Map(state.facts),
    conditions: state.conditions.slice(), value: state.value, declared: new Set(state.declared),
    constants: new Set(state.constants), prototypeUnknown: state.prototypeUnknown, completion: state.completion };
}

/** @param {FlowStatement[]} body @param {FlowState} state */
function hoistFlowVars (body, state) {
  for (const statement of body) {
    if (statement.type === 'declaration' && statement.mode === 'var') {
      for (const declaration of statement.declarations) {
        state.declared.add(declaration.name);
        if (!state.bindings.has(declaration.name)) {
          state.bindings.set(declaration.name, { kind: 'literal', value: undefined });
        }
      }
    } else if (statement.type === 'block') hoistFlowVars(statement.body, state);
    else if (statement.type === 'if') {
      hoistFlowVars([statement.consequent], state);
      if (statement.alternate) hoistFlowVars([statement.alternate], state);
    }
  }
}

/** @param {FlowContext} context @param {FlowStatement[]} body @param {FlowState[]} states */
function executeFlowBody (context, body, states) {
  for (const statement of body) {
    for (const state of states) {
      if (statement.type === 'function') {
        state.declared.add(statement.name);
        state.bindings.set(statement.name, { kind: 'unknown', id: context.nextId++ });
      }
      if (statement.type === 'declaration') {
        for (const declaration of statement.declarations) {
          state.declared.add(declaration.name);
          if (statement.mode !== 'var') {
            state.constants.delete(declaration.name);
            state.bindings.set(declaration.name, { kind: 'uninitialized' });
          }
          else if (!state.bindings.has(declaration.name)) {
            state.bindings.set(declaration.name, { kind: 'literal', value: undefined });
          }
        }
      }
    }
  }
  for (const statement of body) {
    const next = [];
    for (const state of states) {
      if (state.completion !== 'normal') next.push(state);
      else next.push(...executeFlowStatement(context, statement, state));
    }
    if (next.length > flowLimits.outcomes) failFlow(context, 'outcome-limit', statement.start, statement.end);
    states = next;
  }
  return states;
}

/** @param {FlowContext} context @param {FlowStatement} statement @param {FlowState} state */
function executeFlowStatement (context, statement, state) {
  stepFlow(context);
  if (statement.type === 'empty' || statement.type === 'function') return [state];
  if (statement.type === 'return' || statement.type === 'throw') { state.completion = statement.type; return [state]; }
  if (statement.type === 'block') {
    const bindings = new Map();
    for (const child of statement.body) {
      if (child.type === 'declaration' && child.mode !== 'var') {
        for (const declaration of child.declarations) bindings.set(declaration.name, {
          value: state.bindings.get(declaration.name), declared: state.declared.has(declaration.name),
          constant: state.constants.has(declaration.name)
        });
      }
      if (child.type === 'function') failFlow(context, 'block-function', child.start, child.end);
    }
    const results = executeFlowBody(context, statement.body, [state]);
    for (const result of results) {
      for (const [name, binding] of bindings) {
        const value = binding.value;
        if (value === undefined) result.bindings.delete(name);
        else result.bindings.set(name, value);
        if (!binding.declared) result.declared.delete(name);
        if (binding.constant) result.constants.add(name);
        else result.constants.delete(name);
      }
    }
    return results;
  }
  if (statement.type === 'declaration') {
    let states = [state];
    for (const declaration of statement.declarations) {
      const next = [];
      for (const current of states) {
        if (statement.mode === 'var' && !declaration.value) { next.push(current); continue; }
        const results = declaration.value ? evaluateFlow(context, declaration.value, current) :
          [{ state: current, value: { kind: 'literal', value: undefined } }];
        for (const result of results) {
          result.state.bindings.set(declaration.name, result.value);
          if (statement.mode === 'const') result.state.constants.add(declaration.name);
          next.push(result.state);
        }
      }
      states = next;
    }
    return states;
  }
  if (statement.type === 'expression') {
    return evaluateFlow(context, statement.expression, state).map(
      /** @param {FlowEvaluation} result */
      result => result.state
    );
  }
  const results = [];
  for (const result of evaluateFlow(context, statement.test, state)) {
    for (const branch of branchFlow(context, result, statement.test, 'truthy')) {
      const child = branch.pass ? statement.consequent : statement.alternate;
      if (child) results.push(...executeFlowStatement(context, child, branch.state));
      else results.push(branch.state);
    }
  }
  return results;
}

/**
 * @param {FlowContext} context
 * @param {FlowEvaluation} result
 * @param {FlowExpression} test
 * @param {string} predicate
 */
function branchFlow (context, result, test, predicate) {
  const value = result.value;
  if (value.kind === 'literal' || value.kind === 'object' ||
      value.kind === 'module-object' || value.kind === 'require') {
    const pass = predicate === 'nullish' ? value.kind === 'literal' && value.value == null :
      value.kind !== 'literal' || Boolean(value.value);
    return [{ state: result.state, value, pass }];
  }
  const fact = predicate + ':' + value.id;
  if (predicate === 'truthy' && result.state.facts.get('nullish:' + value.id) === true) {
    return [{ state: result.state, value, pass: false }];
  }
  if (predicate === 'nullish' && result.state.facts.get('truthy:' + value.id) === true) {
    return [{ state: result.state, value, pass: false }];
  }
  if (result.state.facts.has(fact)) return [{ state: result.state, value, pass: result.state.facts.get(fact) }];
  const branches = [];
  context.branches += 2;
  if (context.branches > flowLimits.outcomes * 2) failFlow(context, 'outcome-limit', test.start, test.end);
  for (const pass of [true, false]) {
    const state = cloneFlowState(result.state);
    state.facts.set(fact, pass);
    state.conditions.push({ start: test.start, end: test.end,
      when: predicate === 'nullish' ? pass ? 'nullish' : 'non-nullish' : pass ? 'truthy' : 'falsy' });
    branches.push({ state, value, pass });
  }
  return branches;
}

/**
 * @param {FlowContext} context
 * @param {FlowExpression} expression
 * @param {FlowState} state
 * @returns {FlowEvaluation[]}
 */
function evaluateFlow (context, expression, state) {
  stepFlow(context);
  if (expression.type === 'literal') return [{ state, value: { kind: 'literal', value: expression.value } }];
  if (expression.type === 'identifier') {
    let value = state.bindings.get(expression.name);
    if (!value) {
      if (expression.name === 'undefined') value = { kind: 'literal', value: undefined };
      else {
        invalidateFlowEffects(context, state, 'opaque-read-effects');
        value = { kind: 'unknown', id: context.nextId++ };
      }
    }
    if (value.kind === 'uninitialized') failFlow(context, 'uninitialized-binding', expression.start, expression.end);
    return [{ state, value }];
  }
  if (expression.type === 'object') {
    const id = context.nextId++;
    state.objects.set(id, { properties: new Map(), start: expression.start, end: expression.end });
    let states = [state];
    for (const entry of expression.entries) {
      const next = [];
      for (const current of states) {
        for (const result of evaluateFlow(context, entry.value, current)) {
          const object = result.state.objects.get(id);
          if (entry.key !== undefined) object.properties.set(entry.key, result.value);
          else if (result.value.kind === 'object' && !result.state.objects.get(result.value.id).reason) {
            for (const [key, value] of result.state.objects.get(result.value.id).properties) {
              object.properties.set(key, value);
            }
          } else {
            if (result.value.kind !== 'literal') {
              invalidateFlowEffects(context, result.state, 'opaque-spread-effects');
            }
            object.reason = 'unresolved-spread';
          }
          next.push(result.state);
        }
      }
      states = next;
    }
    return states.map(
      /** @param {FlowState} current */
      current => ({ state: current, value: { kind: 'object', id } })
    );
  }
  if (expression.type === 'member') {
    const results = [];
    for (const receiver of evaluateFlow(context, expression.object, state)) {
      for (const key of evaluateFlow(context, expression.key, receiver.state)) {
        const name = flowPropertyName(context, key.value, expression);
        let value;
        if (receiver.value.kind === 'module-object' && name === 'exports') value = key.state.value;
        else if (receiver.value.kind === 'object') {
          const object = key.state.objects.get(receiver.value.id);
          if (object.reason) failFlow(context, object.reason, expression.start, expression.end);
          value = object.properties.get(name);
          if (value === undefined) invalidateFlowEffects(context, key.state, 'opaque-read-effects');
        } else invalidateFlowEffects(context, key.state, 'opaque-read-effects');
        results.push({ state: key.state, value: value || { kind: 'unknown', id: context.nextId++ } });
      }
    }
    return results;
  }
  if (expression.type === 'call') {
    const requireBinding = state.bindings.get('require');
    if (expression.callee.type !== 'identifier' || expression.callee.name !== 'require' ||
        !requireBinding || requireBinding.kind !== 'require' || expression.args.length !== 1) {
      failFlow(context, 'unsupported-call', expression.start, expression.end);
    }
    const results = [];
    for (const argument of evaluateFlow(context, expression.args[0], state)) {
      if (argument.value.kind !== 'literal' || typeof argument.value.value !== 'string') {
        failFlow(context, 'dynamic-require', expression.start, expression.end);
      }
      invalidateFlowEffects(context, argument.state, 'dependency-effects');
      results.push({ state: argument.state,
        value: { kind: 'module', id: context.nextId++, specifier: argument.value.value } });
    }
    return results;
  }
  if (expression.type === 'conditional') {
    const results = [];
    for (const test of evaluateFlow(context, expression.test, state)) {
      for (const branch of branchFlow(context, test, expression.test, 'truthy')) {
        const child = branch.pass ? expression.consequent : expression.alternate;
        results.push(...evaluateFlow(context, child, branch.state));
      }
    }
    return results;
  }
  if (expression.type === 'unary') {
    if (expression.operator === 'delete') {
      if (expression.argument.type !== 'member') {
        failFlow(context, 'unsupported-delete', expression.start, expression.end);
      }
      return writeFlow(context, expression.argument, undefined, state);
    }
    const results = [];
    for (const result of evaluateFlow(context, expression.argument, state)) {
      if (expression.operator === '!') {
        for (const branch of branchFlow(context, result, expression.argument, 'truthy')) {
          results.push({ state: branch.state, value: { kind: 'literal', value: !branch.pass } });
        }
      } else if (expression.operator === 'void') {
        results.push({ state: result.state, value: { kind: 'literal', value: undefined } });
      }
      else if (result.value.kind === 'literal') {
        const value = expression.operator === '+' ? +result.value.value : expression.operator === '-' ?
          -result.value.value : typeof result.value.value;
        results.push({ state: result.state, value: { kind: 'literal', value } });
      } else {
        if (expression.operator === '+' || expression.operator === '-') {
          invalidateFlowEffects(context, result.state, 'opaque-coercion-effects');
        }
        results.push({ state: result.state, value: { kind: 'unknown', id: context.nextId++ } });
      }
    }
    return results;
  }
  if (expression.operator === '=') {
    const results = [];
    for (const target of referenceFlow(context, expression.left, state)) {
      for (const right of evaluateFlow(context, expression.right, target.state)) {
        assignFlowReference(context, target.reference, right.value, right.state);
        results.push(right);
      }
    }
    return results;
  }
  if (['&&=', '||=', '??='].includes(expression.operator)) {
    const results = [];
    for (const target of referenceFlow(context, expression.left, state)) {
      const reference = target.reference;
      const value = reference.kind === 'binding' ? target.state.bindings.get(reference.name) :
        reference.kind === 'module' ? target.state.value :
          target.state.objects.get(reference.id).properties.get(reference.name);
      if (reference.kind === 'property' && value === undefined) {
        invalidateFlowEffects(context, target.state, 'opaque-read-effects');
      }
      const left = { state: target.state, value: value || { kind: 'unknown', id: context.nextId++ } };
      for (const branch of branchFlow(context, left, expression.left,
        expression.operator === '??=' ? 'nullish' : 'truthy')) {
        const evaluateRight = expression.operator === '||=' ? !branch.pass : branch.pass;
        if (!evaluateRight) { results.push({ state: branch.state, value: left.value }); continue; }
        for (const right of evaluateFlow(context, expression.right, branch.state)) {
          assignFlowReference(context, reference, right.value, right.state);
          results.push(right);
        }
      }
    }
    return results;
  }
  const results = [];
  for (const left of evaluateFlow(context, expression.left, state)) {
    const logical = ['&&', '||', '??'].includes(expression.operator);
    if (logical) {
      const predicate = expression.operator.startsWith('??') ? 'nullish' : 'truthy';
      for (const branch of branchFlow(context, left, expression.left, predicate)) {
        const evaluateRight = expression.operator.startsWith('||') ? !branch.pass : branch.pass;
        if (!evaluateRight) { results.push({ state: branch.state, value: left.value }); continue; }
        for (const right of evaluateFlow(context, expression.right, branch.state)) {
          results.push(right);
        }
      }
    } else {
      for (const right of evaluateFlow(context, expression.right, left.state)) {
        if (expression.operator !== ',' && expression.operator !== '===' && expression.operator !== '!==' &&
            (left.value.kind !== 'literal' || right.value.kind !== 'literal')) {
          invalidateFlowEffects(context, right.state, 'opaque-coercion-effects');
        }
        const value = expression.operator === ',' ? right.value :
          left.value.kind === 'literal' && right.value.kind === 'literal' ?
            foldFlowBinary(expression.operator, left.value.value, right.value.value) :
            { kind: 'unknown', id: context.nextId++ };
        results.push({ state: right.state, value });
      }
    }
  }
  return results;
}

/** @param {FlowContext} context @param {FlowValue} value @param {FlowExpression} expression */
function flowPropertyName (context, value, expression) {
  if (value.kind !== 'literal') failFlow(context, 'dynamic-property', expression.start, expression.end);
  const name = String(value.value);
  if (name === '__proto__') failFlow(context, 'prototype-mutation', expression.start, expression.end);
  return name;
}

/**
 * @param {FlowContext} context
 * @param {FlowExpression} target
 * @param {FlowValue | undefined} value
 * @param {FlowState} state
 */
function writeFlow (context, target, value, state) {
  const results = [];
  for (const result of referenceFlow(context, target, state)) {
    assignFlowReference(context, result.reference, value, result.state);
    results.push({ state: result.state, value: value || { kind: 'literal', value: true } });
  }
  return results;
}

/** @param {FlowContext} context @param {FlowExpression} target @param {FlowState} state */
function referenceFlow (context, target, state) {
  if (target.type === 'identifier') {
    const binding = state.bindings.get(target.name);
    if (!state.declared.has(target.name) || state.constants.has(target.name) ||
        binding && binding.kind === 'uninitialized') {
      failFlow(context, 'unsupported-binding-write', target.start, target.end);
    }
    return [{ state, reference: { kind: 'binding', name: target.name } }];
  }
  if (target.type !== 'member') failFlow(context, 'unsupported-assignment', target.start, target.end);
  const results = [];
  for (const receiver of evaluateFlow(context, target.object, state)) {
    for (const key of evaluateFlow(context, target.key, receiver.state)) {
      const name = flowPropertyName(context, key.value, target);
      let reference;
      if (receiver.value.kind === 'module-object' && name === 'exports') reference = { kind: 'module' };
      else if (receiver.value.kind === 'object') {
        const object = key.state.objects.get(receiver.value.id);
        if (object.reason) failFlow(context, object.reason, target.start, target.end);
        reference = { kind: 'property', id: receiver.value.id, name };
      }
      else failFlow(context, 'unknown-mutation', target.start, target.end);
      results.push({ state: key.state, reference });
    }
  }
  return results;
}

/** @param {FlowContext} context @param {FlowReference} reference
 * @param {FlowValue | undefined} value @param {FlowState} state */
function assignFlowReference (context, reference, value, state) {
  if (reference.kind === 'binding') state.bindings.set(reference.name, value);
  else if (reference.kind === 'module') state.value = value || { kind: 'literal', value: undefined };
  else {
    const object = state.objects.get(reference.id);
    if (object.reason) failFlow(context, object.reason);
    if (value === undefined) object.properties.delete(reference.name);
    else {
      if (state.prototypeUnknown && !object.properties.has(reference.name)) failFlow(context, 'dependency-effects');
      object.properties.set(reference.name, value);
    }
  }
}

/** @param {FlowContext} context @param {FlowState} state @param {string} reason */
function invalidateFlowEffects (context, state, reason) {
  if (context.hasFunctions) failFlow(context, 'unresolved-function-effects');
  const pending = [state.value];
  const visited = new Set();
  while (pending.length) {
    const value = pending.pop();
    if (value.kind !== 'object' || visited.has(value.id)) continue;
    visited.add(value.id);
    const object = state.objects.get(value.id);
    object.reason = reason;
    for (const child of object.properties.values()) pending.push(child);
  }
  state.value = { kind: 'unknown', id: context.nextId++, reason };
  state.prototypeUnknown = true;
}

/** @param {string} operator @param {FlowPrimitive} left @param {FlowPrimitive} right @returns {FlowValue} */
function foldFlowBinary (operator, left, right) {
  let value;
  switch (operator) {
    case '===': value = left === right; break;
    case '!==': value = left !== right; break;
    case '==': value = left == right; break;
    case '!=': value = left != right; break;
    case '<': value = left < right; break;
    case '>': value = left > right; break;
    case '<=': value = left <= right; break;
    case '>=': value = left >= right; break;
    case '+': value = left + right; break;
    case '-': value = left - right; break;
    case '*': value = left * right; break;
    case '%': value = left % right; break;
  }
  return { kind: 'literal', value };
}

/** @param {FlowState} state @param {FlowValue} value @returns {import('../lexer').FlowExportValue} */
function reportFlowValue (state, value) {
  if (value.kind === 'module') return { kind: 'module', specifier: value.specifier };
  if (value.kind === 'object') {
    const object = state.objects.get(value.id);
    if (object.reason) return { kind: 'unknown', reason: object.reason, start: object.start, end: object.end };
    return { kind: 'object', properties: [...object.properties.keys()] };
  }
  if (value.kind === 'literal') return { kind: 'literal', value: value.value };
  return { kind: 'unknown', reason: value.kind === 'unknown' && value.reason || 'unknown-export-value' };
}

module.exports = analyzeExports;
