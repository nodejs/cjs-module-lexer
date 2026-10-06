#define FLOW_TOKENS 8192
#define FLOW_DEPTH 64
#define FLOW_OUTCOMES 32
#define FLOW_STEPS 65536
#define FLOW_ANALYZED 1024
#define FLOW_INCOMPLETE 2048

enum FlowKind {
  FT_IDENTIFIER = 256, FT_STRING, FT_NUMBER, FT_EQUAL, FT_NOT_EQUAL,
  FT_AND, FT_OR, FT_NULLISH, FT_AND_ASSIGN, FT_OR_ASSIGN, FT_NULLISH_ASSIGN, FT_SPREAD,
  FN_NUMBER, FN_STRING, FN_BOOLEAN, FN_NULL, FN_UNDEFINED, FN_IDENTIFIER,
  FN_MEMBER, FN_CALL, FN_UNARY, FN_BINARY, FN_CONDITIONAL, FN_OBJECT, FN_PROPERTY, FN_SPREAD,
  FN_EXPRESSION, FN_BLOCK, FN_IF, FN_EMPTY
};

enum FlowValueKind {
  FV_UNKNOWN, FV_NUMBER, FV_STRING, FV_BOOLEAN, FV_NULL, FV_UNDEFINED,
  FV_MODULE, FV_OBJECT, FV_OPAQUE_OBJECT, FV_FUNCTION, FV_UNKNOWN_STRING,
  FV_TYPE_NUMBER, FV_TYPE_STRING, FV_TYPE_BOOLEAN, FV_TYPE_OBJECT, FV_TYPE_FUNCTION, FV_TYPE_UNDEFINED
};

typedef struct {
  uint32_t start, end;
  uint16_t kind;
} FlowToken;

typedef struct {
  uint16_t kind, op, left, right, third, next;
  uint32_t start, end;
  double number;
} FlowNode;

typedef struct {
  uint16_t kind, node;
  int8_t truth;
  double number;
} FlowValue;

typedef struct { FlowValue root, value; } FlowEvaluation;
typedef struct { uint32_t count; FlowEvaluation values[FLOW_OUTCOMES]; } FlowResult;

typedef struct {
  FlowToken* tokens;
  FlowNode* nodes;
  FlowResult* results;
  uint32_t tokenCount, nodeCount, cursor, depth, steps;
  bool failed;
} FlowContext;

static FlowContext flow;

static bool flowStep () {
  if (++flow.steps > FLOW_STEPS) flow.failed = true;
  return !flow.failed;
}

static bool flowReserve (uint32_t bytes) {
  uint64_t required = (uint64_t)(uintptr_t)analysis_head + bytes;
  if (required > UINT32_MAX) return false;
  uint64_t capacity = (uint64_t)__builtin_wasm_memory_size(0) * 65536;
  return required <= capacity ||
    __builtin_wasm_memory_grow(0, (required - capacity + 65535) / 65536) != (size_t)-1;
}

static bool flowLineBreak (uint16_t ch) {
  return ch == '\r' || ch == '\n' || ch == 0x2028 || ch == 0x2029;
}

static bool flowSpace (uint16_t ch) {
  return ch == 32 || ch >= 9 && ch <= 13 || ch == 0xA0 || ch == 0x1680 ||
    ch >= 0x2000 && ch <= 0x200A || ch == 0x2028 || ch == 0x2029 ||
    ch == 0x202F || ch == 0x205F || ch == 0x3000 || ch == 0xFEFF;
}

static bool flowIdentifier (uint16_t ch) {
  return ch >= 'a' && ch <= 'z' || ch >= 'A' && ch <= 'Z' || ch == '_' || ch == '$' ||
    ch > 127 && !flowSpace(ch);
}

static bool flowText (uint32_t start, uint32_t end, const char* text) {
  while (start < end && *text && source[start] == (uint8_t)*text) { start++; text++; }
  return start == end && !*text;
}

static bool flowName (uint16_t node, const char* name) {
  return flow.nodes[node].kind == FN_IDENTIFIER &&
    flowText(flow.nodes[node].start, flow.nodes[node].end, name);
}

static int flowDigit (uint16_t ch) {
  if (ch >= '0' && ch <= '9') return ch - '0';
  if (ch >= 'a' && ch <= 'f') return ch - 'a' + 10;
  if (ch >= 'A' && ch <= 'F') return ch - 'A' + 10;
  return -1;
}

static int32_t flowStringNext (FlowNode* node, uint32_t* cursor, uint16_t* pending) {
  if (*pending) { uint16_t ch = *pending; *pending = 0; return ch; }
  while (*cursor < node->end - 1 && flowStep()) {
    uint16_t ch = source[(*cursor)++];
    if (ch != '\\') return ch;
    ch = source[(*cursor)++];
    if (flowLineBreak(ch)) {
      if (ch == '\r' && source[*cursor] == '\n') (*cursor)++;
      continue;
    }
    switch (ch) {
      case 'b': return '\b';
      case 'f': return '\f';
      case 'n': return '\n';
      case 'r': return '\r';
      case 't': return '\t';
      case 'v': return '\v';
      case 'x':
      case 'u': {
        uint32_t code = 0, digits = ch == 'x' ? 2 : 4;
        bool brace = ch == 'u' && source[*cursor] == '{';
        if (brace) { (*cursor)++; digits = 6; }
        uint32_t read = 0;
        while (read < digits && *cursor < node->end - 1) {
          int digit = flowDigit(source[*cursor]);
          if (digit < 0) break;
          code = code * 16 + digit;
          (*cursor)++; read++;
        }
        if (brace ? !read || source[(*cursor)++] != '}' : read != digits) {
          flow.failed = true; return -1;
        }
        if (code > 0x10FFFF) { flow.failed = true; return -1; }
        if (code > 0xFFFF) {
          *pending = 0xDC00 + ((code - 0x10000) & 1023);
          return 0xD800 + ((code - 0x10000) >> 10);
        }
        return code;
      }
      default: {
        if (ch >= '0' && ch <= '7') {
          uint32_t code = ch - '0', count = ch <= '3' ? 2 : 1;
          while (count-- && source[*cursor] >= '0' && source[*cursor] <= '7')
            code = code * 8 + source[(*cursor)++] - '0';
          return code;
        }
        return ch;
      }
    }
  }
  return -1;
}

static bool flowStringText (uint16_t index, const char* text) {
  FlowNode* node = &flow.nodes[index];
  uint32_t cursor = node->start + 1;
  uint16_t pending = 0;
  int32_t ch;
  while ((ch = flowStringNext(node, &cursor, &pending)) >= 0) {
    if (!*text || ch != (uint8_t)*text++) return false;
  }
  return !*text;
}

static double flowNumber (FlowToken token) {
  uint32_t cursor = token.start, radix = 10, fraction = 0;
  int exponent = 0;
  uint64_t value = 0;
  bool point = false;
  if (token.end - cursor > 128) { flow.failed = true; return 0; }
  if (source[cursor] == '0' && cursor + 1 < token.end) {
    uint16_t prefix = source[cursor + 1] | 32;
    if (prefix == 'x' || prefix == 'b' || prefix == 'o') {
      radix = prefix == 'x' ? 16 : prefix == 'b' ? 2 : 8;
      cursor += 2;
    } else if (source[cursor + 1] >= '0' && source[cursor + 1] <= '9') {
      flow.failed = true; return 0;
    }
  }
  while (cursor < token.end) {
    uint16_t ch = source[cursor++];
    if (radix == 10 && ch == '.') { point = true; continue; }
    if (radix == 10 && (ch == 'e' || ch == 'E')) {
      bool negative = source[cursor] == '-';
      if (negative || source[cursor] == '+') cursor++;
      while (cursor < token.end && exponent <= 128) exponent = exponent * 10 + source[cursor++] - '0';
      if (negative) exponent = -exponent;
      break;
    }
    int digit = flowDigit(ch);
    if (digit < 0 || digit >= radix || value > (9007199254740991ULL - digit) / radix) {
      flow.failed = true; return 0;
    }
    value = value * radix + digit;
    if (point) fraction++;
  }
  if (!value) return 0;
  exponent -= fraction;
  if (exponent < -15 || exponent > 15) { flow.failed = true; return 0; }
  uint64_t scale = 1;
  for (uint32_t i = 0; i < (uint32_t)(exponent < 0 ? -exponent : exponent); i++) scale *= 10;
  if (exponent > 0 && value > 9007199254740991ULL / scale) { flow.failed = true; return 0; }
  return exponent > 0 ? (double)(value * scale) : (double)value / scale;
}

static void flowTokenize () {
  uint32_t cursor = 0;
  if (sourceLen > 1 && source[0] == '#' && source[1] == '!') {
    while (cursor < sourceLen && !flowLineBreak(source[cursor]) && flowStep()) cursor++;
  }
  while (cursor < sourceLen && flowStep()) {
    uint32_t start = cursor;
    uint16_t ch = source[cursor++], kind = ch;
    if (flowSpace(ch)) continue;
    if (ch == '/' && cursor < sourceLen && source[cursor] == '/') {
      while (cursor < sourceLen && !flowLineBreak(source[cursor]) && flowStep()) cursor++;
      continue;
    }
    if (ch == '/' && cursor < sourceLen && source[cursor] == '*') {
      cursor++;
      while (cursor + 1 < sourceLen && !(source[cursor] == '*' && source[cursor + 1] == '/') && flowStep())
        cursor++;
      if (cursor + 1 >= sourceLen) { flow.failed = true; return; }
      cursor += 2; continue;
    }
    if (ch == '\'' || ch == '"') {
      kind = FT_STRING;
      while (cursor < sourceLen && source[cursor] != ch && flowStep()) {
        if (source[cursor] == '\\') cursor++;
        cursor++;
      }
      if (cursor >= sourceLen) { flow.failed = true; return; }
      cursor++;
    } else if (flowIdentifier(ch)) {
      kind = FT_IDENTIFIER;
      while (cursor < sourceLen && (flowIdentifier(source[cursor]) ||
          source[cursor] >= '0' && source[cursor] <= '9') && flowStep()) cursor++;
    } else if (ch >= '0' && ch <= '9') {
      kind = FT_NUMBER;
      bool radix = ch == '0' && cursor < sourceLen &&
        ((source[cursor] | 32) == 'x' || (source[cursor] | 32) == 'b' || (source[cursor] | 32) == 'o');
      if (radix) cursor++;
      while (cursor < sourceLen && flowStep()) {
        ch = source[cursor];
        if (radix ? flowDigit(ch) >= 0 : ch >= '0' && ch <= '9' || ch == '.') { cursor++; continue; }
        if (!radix && (ch == 'e' || ch == 'E')) {
          cursor++;
          if (source[cursor] == '+' || source[cursor] == '-') cursor++;
          while (cursor < sourceLen && source[cursor] >= '0' && source[cursor] <= '9') cursor++;
        }
        break;
      }
    } else if ((ch == '+' || ch == '-') && cursor < sourceLen && source[cursor] == ch) {
      flow.failed = true; return;
    } else if ((ch == '=' || ch == '!') && cursor + 1 < sourceLen &&
        source[cursor] == '=' && source[cursor + 1] == '=') {
      kind = ch == '=' ? FT_EQUAL : FT_NOT_EQUAL; cursor += 2;
    } else if ((ch == '&' || ch == '|' || ch == '?') && cursor < sourceLen && source[cursor] == ch) {
      cursor++;
      bool assign = cursor < sourceLen && source[cursor] == '=';
      kind = ch == '&' ? (assign ? FT_AND_ASSIGN : FT_AND) :
        ch == '|' ? (assign ? FT_OR_ASSIGN : FT_OR) : (assign ? FT_NULLISH_ASSIGN : FT_NULLISH);
      if (assign) cursor++;
    } else if (ch == '.' && cursor + 1 < sourceLen && source[cursor] == '.' && source[cursor + 1] == '.') {
      kind = FT_SPREAD; cursor += 2;
    }
    if (flow.tokenCount == FLOW_TOKENS) { flow.failed = true; return; }
    flow.tokens[flow.tokenCount++] = (FlowToken){ start, cursor, kind };
  }
}

static uint16_t flowPeek () {
  return flow.cursor < flow.tokenCount ? flow.tokens[flow.cursor].kind : 0;
}

static bool flowTake (uint16_t kind) {
  if (flowPeek() != kind) return false;
  flow.cursor++; return true;
}

static void flowExpect (uint16_t kind) {
  if (!flowTake(kind)) flow.failed = true;
}

static uint16_t flowNode (uint16_t kind, uint16_t left, uint16_t right, FlowToken token) {
  if (flow.nodeCount == FLOW_TOKENS || !flowStep()) { flow.failed = true; return 0; }
  uint16_t index = ++flow.nodeCount;
  FlowNode* node = &flow.nodes[index];
  node->kind = kind; node->op = 0;
  node->left = left; node->right = right; node->third = 0; node->next = 0;
  node->start = token.start; node->end = token.end; node->number = 0;
  return index;
}

static uint16_t flowLiteral (FlowToken token) {
  uint16_t kind = token.kind == FT_STRING ? FN_STRING : token.kind == FT_NUMBER ? FN_NUMBER : FN_IDENTIFIER;
  if (token.kind == FT_IDENTIFIER) {
    if (flowText(token.start, token.end, "true") || flowText(token.start, token.end, "false")) kind = FN_BOOLEAN;
    else if (flowText(token.start, token.end, "null")) kind = FN_NULL;
    else if (flowText(token.start, token.end, "undefined")) kind = FN_UNDEFINED;
  }
  uint16_t node = flowNode(kind, 0, 0, token);
  if (kind == FN_NUMBER) flow.nodes[node].number = flowNumber(token);
  if (kind == FN_BOOLEAN) flow.nodes[node].number = source[token.start] == 't';
  return node;
}

static uint32_t flowPower (uint16_t kind) {
  switch (kind) {
    case ',': return 1;
    case '=': case FT_AND_ASSIGN: case FT_OR_ASSIGN: case FT_NULLISH_ASSIGN: return 2;
    case '?': return 3;
    case FT_OR: case FT_NULLISH: return 4;
    case FT_AND: return 5;
    case FT_EQUAL: case FT_NOT_EQUAL: return 6;
    default: return 0;
  }
}

static uint16_t flowExpression (uint32_t minimum);

static uint16_t flowObject (FlowToken token) {
  uint16_t object = flowNode(FN_OBJECT, 0, 0, token), tail = 0;
  while (flowPeek() != '}' && !flow.failed) {
    if (!flowPeek()) { flow.failed = true; break; }
    uint16_t entry, key = 0;
    if (flowTake(FT_SPREAD)) {
      entry = flowNode(FN_SPREAD, flowExpression(2), 0, token);
    } else {
      FlowToken name = flow.tokens[flow.cursor++];
      if (name.kind != FT_IDENTIFIER && name.kind != FT_STRING && name.kind != FT_NUMBER) {
        flow.failed = true; break;
      }
      key = name.kind == FT_IDENTIFIER ? flowNode(FN_IDENTIFIER, 0, 0, name) : flowLiteral(name);
      uint16_t value;
      if (flowTake(':')) {
        if (flowName(key, "__proto__") || name.kind == FT_STRING && flowStringText(key, "__proto__"))
          flow.failed = true;
        value = flowExpression(2);
      } else {
        if (name.kind != FT_IDENTIFIER) flow.failed = true;
        value = flowLiteral(name);
      }
      entry = flowNode(FN_PROPERTY, key, value, name);
    }
    if (tail) flow.nodes[tail].next = entry;
    else flow.nodes[object].left = entry;
    tail = entry;
    if (!flowTake(',')) break;
  }
  flowExpect('}');
  return object;
}

static uint16_t flowExpression (uint32_t minimum) {
  if (++flow.depth > FLOW_DEPTH || !flowPeek() || !flowStep()) { flow.failed = true; flow.depth--; return 0; }
  FlowToken token = flow.tokens[flow.cursor++];
  uint16_t left;
  if (token.kind == '(') {
    left = flowExpression(1); flowExpect(')');
  } else if (token.kind == '{') left = flowObject(token);
  else if (token.kind == '!' || token.kind == '+' || token.kind == '-' ||
      token.kind == FT_IDENTIFIER && (flowText(token.start, token.end, "void") ||
      flowText(token.start, token.end, "typeof"))) {
    left = flowNode(FN_UNARY, flowExpression(12), 0, token);
    flow.nodes[left].op = token.kind == FT_IDENTIFIER ? (source[token.start] == 'v' ? 'v' : 't') : token.kind;
  } else if (token.kind == FT_IDENTIFIER || token.kind == FT_STRING || token.kind == FT_NUMBER)
    left = flowLiteral(token);
  else { flow.failed = true; left = 0; }
  while (!flow.failed && flowStep()) {
    if (flowPeek() == '.' || flowPeek() == '[') {
      uint16_t op = flow.tokens[flow.cursor++].kind, key;
      if (op == '.') {
        if (flowPeek() != FT_IDENTIFIER) { flow.failed = true; break; }
        key = flowNode(FN_IDENTIFIER, 0, 0, flow.tokens[flow.cursor++]);
      } else { key = flowExpression(1); flowExpect(']'); }
      left = flowNode(FN_MEMBER, left, key, token); flow.nodes[left].op = op;
    } else if (flowTake('(')) {
      uint16_t call = flowNode(FN_CALL, left, 0, token), tail = 0;
      while (flowPeek() != ')' && !flow.failed) {
        uint16_t argument = flowExpression(2);
        if (tail) flow.nodes[tail].next = argument;
        else flow.nodes[call].right = argument;
        tail = argument;
        if (!flowTake(',')) break;
      }
      flowExpect(')'); left = call;
    } else {
      uint32_t power = flowPower(flowPeek());
      if (!power || power < minimum) break;
      FlowToken operator = flow.tokens[flow.cursor++];
      if (operator.kind == '?') {
        uint16_t consequent = flowExpression(2);
        flowExpect(':');
        uint16_t alternate = flowExpression(2);
        left = flowNode(FN_CONDITIONAL, left, consequent, operator); flow.nodes[left].third = alternate;
      } else {
        uint16_t right = flowExpression(power == 2 ? power : power + 1);
        left = flowNode(FN_BINARY, left, right, operator); flow.nodes[left].op = operator.kind;
      }
    }
  }
  flow.depth--; return left;
}

static uint16_t flowStatement () {
  if (++flow.depth > FLOW_DEPTH || !flowPeek() || !flowStep()) { flow.failed = true; flow.depth--; return 0; }
  FlowToken token = flow.tokens[flow.cursor++];
  if (token.kind == FT_IDENTIFIER) {
    static const char* const unsupported[] = {
      "return", "throw", "break", "continue", "function", "class", "var", "let", "const",
      "for", "while", "do", "switch", "case", "try", "catch", "finally", "with", "debugger", "in", "instanceof"
    };
    for (uint32_t i = 0; i < sizeof(unsupported) / sizeof(unsupported[0]); i++)
      if (flowText(token.start, token.end, unsupported[i])) { flow.failed = true; flow.depth--; return 0; }
  }
  uint16_t node;
  if (token.kind == ';') node = flowNode(FN_EMPTY, 0, 0, token);
  else if (token.kind == '{') {
    node = flowNode(FN_BLOCK, 0, 0, token);
    uint16_t tail = 0;
    while (flowPeek() != '}' && !flow.failed) {
      uint16_t statement = flowStatement();
      if (tail) flow.nodes[tail].next = statement;
      else flow.nodes[node].left = statement;
      tail = statement;
    }
    flowExpect('}');
  } else if (token.kind == FT_IDENTIFIER && flowText(token.start, token.end, "if")) {
    flowExpect('('); uint16_t condition = flowExpression(1); flowExpect(')');
    node = flowNode(FN_IF, condition, flowStatement(), token);
    if (flowPeek() == FT_IDENTIFIER &&
        flowText(flow.tokens[flow.cursor].start, flow.tokens[flow.cursor].end, "else")) {
      flow.cursor++; flow.nodes[node].third = flowStatement();
    }
  } else {
    flow.cursor--;
    node = flowNode(FN_EXPRESSION, flowExpression(1), 0, token);
    if (!flowTake(';') && flowPeek() && flowPeek() != '}') {
      uint32_t start = flow.tokens[flow.cursor - 1].end, next = flow.tokens[flow.cursor].start;
      while (start < next && !flowLineBreak(source[start])) start++;
      if (start == next || flowPeek() == '+' || flowPeek() == '-') flow.failed = true;
    }
  }
  flow.depth--; return node;
}

static FlowValue flowValue (uint16_t kind, uint16_t node, int8_t truth, double number) {
  return (FlowValue){ kind, node, truth, number };
}

static bool flowSame (FlowValue first, FlowValue second) {
  return first.kind == second.kind && first.node == second.node &&
    first.truth == second.truth && first.number == second.number;
}

static void flowAppend (FlowResult* result, FlowValue root, FlowValue value) {
  for (uint32_t i = 0; i < result->count && flowStep(); i++)
    if (flowSame(result->values[i].root, root) && flowSame(result->values[i].value, value)) return;
  if (result->count == FLOW_OUTCOMES) { flow.failed = true; return; }
  result->values[result->count++] = (FlowEvaluation){ root, value };
}

static void flowMerge (FlowResult* target, FlowResult* values) {
  for (uint32_t i = 0; i < values->count && flowStep(); i++)
    flowAppend(target, values->values[i].root, values->values[i].value);
}

static bool flowRoot (uint16_t index) {
  FlowNode* node = &flow.nodes[index];
  return node->kind == FN_MEMBER && flowName(node->left, "module") &&
    (node->op == '.' ? flowName(node->right, "exports") :
      flow.nodes[node->right].kind == FN_STRING && flowStringText(node->right, "exports"));
}

static bool flowRequire (uint16_t index) {
  FlowNode* node = &flow.nodes[index];
  return node->kind == FN_CALL && flowName(node->left, "require") && node->right &&
    !flow.nodes[node->right].next && flow.nodes[node->right].kind == FN_STRING;
}

static bool flowStringsEqual (uint16_t first, uint16_t second) {
  uint32_t firstCursor = flow.nodes[first].start + 1, secondCursor = flow.nodes[second].start + 1;
  uint16_t firstPending = 0, secondPending = 0;
  int32_t ch;
  do {
    ch = flowStringNext(&flow.nodes[first], &firstCursor, &firstPending);
    if (ch != flowStringNext(&flow.nodes[second], &secondCursor, &secondPending)) return false;
  } while (ch >= 0 && !flow.failed);
  return true;
}

static const char* flowTypeText (uint16_t kind) {
  switch (kind) {
    case FV_TYPE_NUMBER: return "number";
    case FV_TYPE_STRING: return "string";
    case FV_TYPE_BOOLEAN: return "boolean";
    case FV_TYPE_OBJECT: return "object";
    case FV_TYPE_FUNCTION: return "function";
    case FV_TYPE_UNDEFINED: return "undefined";
    default: return NULL;
  }
}

static int8_t flowEqual (FlowValue first, FlowValue second) {
  if (first.kind == FV_UNKNOWN || second.kind == FV_UNKNOWN ||
      first.kind == FV_MODULE || second.kind == FV_MODULE ||
      first.kind == FV_UNKNOWN_STRING || second.kind == FV_UNKNOWN_STRING) return -1;
  if ((first.kind == FV_OPAQUE_OBJECT && (second.kind == FV_OBJECT || second.kind == FV_OPAQUE_OBJECT)) ||
      (second.kind == FV_OPAQUE_OBJECT && first.kind == FV_OBJECT)) return -1;
  const char* firstType = flowTypeText(first.kind), *secondType = flowTypeText(second.kind);
  if (firstType || secondType) {
    if (firstType && secondType) return first.kind == second.kind;
    FlowValue string = firstType ? second : first;
    return string.kind == FV_STRING && flowStringText(string.node, firstType ? firstType : secondType);
  }
  if (first.kind != second.kind) return 0;
  if (first.kind == FV_STRING) return flowStringsEqual(first.node, second.node);
  if (first.kind == FV_NUMBER || first.kind == FV_BOOLEAN) {
    if (first.kind == FV_BOOLEAN && (first.truth < 0 || second.truth < 0)) return -1;
    return first.number == second.number;
  }
  if (first.kind == FV_OBJECT) return first.node == second.node;
  if (first.kind == FV_FUNCTION) return 1;
  if (first.kind == FV_OPAQUE_OBJECT) return -1;
  return 1;
}

static FlowValue flowTypeof (FlowValue value) {
  uint16_t kind;
  switch (value.kind) {
    case FV_NUMBER: kind = FV_TYPE_NUMBER; break;
    case FV_BOOLEAN: kind = FV_TYPE_BOOLEAN; break;
    case FV_NULL: case FV_OBJECT: case FV_OPAQUE_OBJECT: kind = FV_TYPE_OBJECT; break;
    case FV_FUNCTION: kind = FV_TYPE_FUNCTION; break;
    case FV_UNDEFINED: kind = FV_TYPE_UNDEFINED; break;
    case FV_UNKNOWN: case FV_MODULE: return flowValue(FV_UNKNOWN_STRING, 0, 1, 0);
    default: kind = FV_TYPE_STRING;
  }
  return flowValue(kind, 0, 1, 0);
}

static int8_t flowRoute (uint16_t op, FlowValue value) {
  if (op == FT_NULLISH || op == FT_NULLISH_ASSIGN)
    return value.kind == FV_UNKNOWN || value.kind == FV_MODULE ? -1 :
      value.kind == FV_NULL || value.kind == FV_UNDEFINED;
  return value.truth < 0 ? -1 : (op == FT_OR || op == FT_OR_ASSIGN ? !value.truth : value.truth);
}

static void flowEvaluate (uint16_t index, FlowValue root, FlowResult* result, uint32_t depth);

static void flowEvaluate (uint16_t index, FlowValue root, FlowResult* result, uint32_t depth) {
  result->count = 0;
  if (depth == FLOW_DEPTH || !flowStep()) { flow.failed = true; return; }
  FlowNode* node = &flow.nodes[index];
  FlowResult* first = &flow.results[depth * 3], *second = first + 1;
  FlowValue unknown = flowValue(FV_UNKNOWN, 0, -1, 0);
  switch (node->kind) {
    case FN_NUMBER: flowAppend(result, root, flowValue(FV_NUMBER, 0, node->number != 0, node->number)); return;
    case FN_BOOLEAN: flowAppend(result, root, flowValue(FV_BOOLEAN, 0, node->number != 0, node->number)); return;
    case FN_NULL: flowAppend(result, root, flowValue(FV_NULL, 0, 0, 0)); return;
    case FN_UNDEFINED: flowAppend(result, root, flowValue(FV_UNDEFINED, 0, 0, 0)); return;
    case FN_STRING: {
      uint32_t cursor = node->start + 1; uint16_t pending = 0;
      flowAppend(result, root, flowValue(FV_STRING, index, flowStringNext(node, &cursor, &pending) >= 0, 0)); return;
    }
    case FN_IDENTIFIER: {
      if (flowName(index, "require")) flowAppend(result, root, flowValue(FV_FUNCTION, 0, 1, 0));
      else if (flowName(index, "module") || flowName(index, "exports"))
        flowAppend(result, root, flowValue(FV_OPAQUE_OBJECT, 0, 1, 0));
      else flowAppend(result, unknown, unknown);
      return;
    }
    case FN_MEMBER:
      if (flowRoot(index)) flowAppend(result, root, root);
      else flowAppend(result, unknown, unknown);
      return;
    case FN_CALL:
      if (flowRequire(index)) flowAppend(result, unknown, flowValue(FV_MODULE, index, -1, 0));
      else { flow.failed = true; }
      return;
    case FN_OBJECT: {
      first->count = 0; flowAppend(first, root, root);
      for (uint16_t entry = node->left; entry && !flow.failed; entry = flow.nodes[entry].next) {
        FlowNode* property = &flow.nodes[entry];
        uint16_t expression = property->kind == FN_SPREAD ? property->left : property->right;
        if (property->kind == FN_SPREAD && !flowRequire(expression) &&
            flow.nodes[expression].kind != FN_OBJECT &&
            flow.nodes[expression].kind != FN_NULL && flow.nodes[expression].kind != FN_UNDEFINED) {
          flow.failed = true; break;
        }
        second->count = 0;
        for (uint32_t i = 0; i < first->count && !flow.failed; i++) {
          FlowResult* child = &flow.results[depth * 3 + 2];
          flowEvaluate(expression, first->values[i].root, child, depth + 1);
          for (uint32_t j = 0; j < child->count && !flow.failed; j++)
            flowAppend(second, child->values[j].root, child->values[j].root);
        }
        FlowResult* swap = first; first = second; second = swap;
      }
      for (uint32_t i = 0; i < first->count && !flow.failed; i++)
        flowAppend(result, first->values[i].root, flowValue(FV_OBJECT, index, 1, 0));
      return;
    }
    case FN_UNARY:
      flowEvaluate(node->left, root, first, depth + 1);
      for (uint32_t i = 0; i < first->count && !flow.failed; i++) {
        FlowEvaluation item = first->values[i]; FlowValue value;
        if (node->op == '!') value = flowValue(FV_BOOLEAN, 0,
          item.value.truth < 0 ? -1 : !item.value.truth, item.value.truth < 0 ? 0 : !item.value.truth);
        else if (node->op == 'v') value = flowValue(FV_UNDEFINED, 0, 0, 0);
        else if (node->op == 't') value = flowTypeof(item.value);
        else if (item.value.kind == FV_NUMBER) value = flowValue(FV_NUMBER, 0,
          item.value.number != 0, node->op == '-' ? -item.value.number : item.value.number);
        else { flow.failed = true; break; }
        flowAppend(result, item.root, value);
      }
      return;
    case FN_CONDITIONAL:
      flowEvaluate(node->left, root, first, depth + 1);
      for (uint32_t i = 0; i < first->count && !flow.failed; i++) {
        FlowEvaluation item = first->values[i];
        if (item.value.truth != 0) {
          flowEvaluate(node->right, item.root, second, depth + 1); flowMerge(result, second);
        }
        if (item.value.truth != 1) {
          flowEvaluate(node->third, item.root, second, depth + 1); flowMerge(result, second);
        }
      }
      return;
    case FN_BINARY: {
      bool assign = node->op == '=' || node->op == FT_AND_ASSIGN ||
        node->op == FT_OR_ASSIGN || node->op == FT_NULLISH_ASSIGN;
      if (assign && !flowRoot(node->left)) { flow.failed = true; return; }
      if (node->op == '=') {
        flowEvaluate(node->right, root, first, depth + 1);
        for (uint32_t i = 0; i < first->count && !flow.failed; i++)
          flowAppend(result, first->values[i].value, first->values[i].value);
        return;
      }
      if (assign) { first->count = 0; flowAppend(first, root, root); }
      else flowEvaluate(node->left, root, first, depth + 1);
      for (uint32_t i = 0; i < first->count && !flow.failed; i++) {
        FlowEvaluation item = first->values[i];
        if (node->op == FT_AND || node->op == FT_OR || node->op == FT_NULLISH || assign) {
          int8_t route = flowRoute(node->op, item.value);
          if (route != 1) flowAppend(result, item.root, item.value);
          if (route != 0) {
            flowEvaluate(node->right, item.root, second, depth + 1);
            for (uint32_t j = 0; j < second->count && !flow.failed; j++)
              flowAppend(result, assign ? second->values[j].value : second->values[j].root, second->values[j].value);
          }
        } else {
          flowEvaluate(node->right, item.root, second, depth + 1);
          for (uint32_t j = 0; j < second->count && !flow.failed; j++) {
            FlowEvaluation right = second->values[j];
            if (node->op == ',') flowAppend(result, right.root, right.value);
            else {
              int8_t equal = flowEqual(item.value, right.value);
              if (equal >= 0 && node->op == FT_NOT_EQUAL) equal = !equal;
              flowAppend(result, right.root, flowValue(FV_BOOLEAN, 0, equal, equal < 0 ? 0 : equal));
            }
          }
        }
      }
      return;
    }
    default: flow.failed = true;
  }
}

static void flowExecute (uint16_t index, FlowValue root, FlowResult* result, uint32_t depth) {
  result->count = 0;
  if (depth == FLOW_DEPTH || !flowStep()) { flow.failed = true; return; }
  FlowNode* node = &flow.nodes[index];
  FlowResult* first = &flow.results[depth * 3], *second = first + 1, *child = first + 2;
  if (node->kind == FN_EMPTY) { flowAppend(result, root, root); return; }
  if (node->kind == FN_EXPRESSION) {
    flowEvaluate(node->left, root, first, depth + 1);
    for (uint32_t i = 0; i < first->count && !flow.failed; i++)
      flowAppend(result, first->values[i].root, first->values[i].root);
  } else if (node->kind == FN_BLOCK) {
    first->count = 0; flowAppend(first, root, root);
    for (uint16_t statement = node->left; statement && !flow.failed; statement = flow.nodes[statement].next) {
      second->count = 0;
      for (uint32_t i = 0; i < first->count && !flow.failed; i++) {
        flowExecute(statement, first->values[i].root, child, depth + 1); flowMerge(second, child);
      }
      FlowResult* swap = first; first = second; second = swap;
    }
    flowMerge(result, first);
  } else if (node->kind == FN_IF) {
    flowEvaluate(node->left, root, first, depth + 1);
    for (uint32_t i = 0; i < first->count && !flow.failed; i++) {
      FlowEvaluation item = first->values[i];
      if (item.value.truth != 0) {
        flowExecute(node->right, item.root, second, depth + 1); flowMerge(result, second);
      }
      if (item.value.truth != 1) {
        if (node->third) {
          flowExecute(node->third, item.root, second, depth + 1); flowMerge(result, second);
        } else flowAppend(result, item.root, item.root);
      }
    }
  } else flow.failed = true;
}

static void flowEmitObject (uint16_t index, uint32_t depth) {
  if (depth == FLOW_DEPTH) { flow.failed = true; return; }
  for (uint16_t entry = flow.nodes[index].left; entry && flowStep(); entry = flow.nodes[entry].next) {
    FlowNode* property = &flow.nodes[entry], *value = &flow.nodes[property->left];
    if (property->kind == FN_PROPERTY) _addExport(source + value->start, source + value->end);
    else if (flowRequire(property->left)) {
      FlowNode* specifier = &flow.nodes[value->right];
      _addReexport(source + specifier->start, source + specifier->end);
    } else if (value->kind == FN_OBJECT) flowEmitObject(property->left, depth + 1);
  }
}

static void flowClear () {
  first_export = export_read_head = export_write_head = NULL;
  first_reexport = reexport_read_head = reexport_write_head = NULL;
  first_unsafe_getter = unsafe_getter_read_head = unsafe_getter_write_head = NULL;
}

uint32_t parseCJSGrouped (uint16_t* input, uint32_t length) {
  uint32_t status = parseCJS(input, length, NULL, NULL, NULL, NULL);
  if ((status & 255) || moduleExportCount < 2) return status;
  flowClear();
  flow.tokenCount = 0; flow.nodeCount = 0; flow.cursor = 0; flow.depth = 0; flow.steps = 0; flow.failed = false;
  uint64_t aligned = ((uint64_t)(uintptr_t)analysis_head + 7) & ~7ULL;
  uint32_t bytes = sizeof(FlowToken) * FLOW_TOKENS + sizeof(FlowNode) * (FLOW_TOKENS + 1) +
    sizeof(FlowResult) * (FLOW_DEPTH * 3 + 1);
  if (aligned > UINT32_MAX || aligned - (uintptr_t)analysis_head > UINT32_MAX - bytes ||
      !flowReserve(bytes + aligned - (uintptr_t)analysis_head)) return status | FLOW_ANALYZED | FLOW_INCOMPLETE;
  flow.tokens = (FlowToken*)(uintptr_t)aligned;
  flow.nodes = (FlowNode*)(flow.tokens + FLOW_TOKENS);
  flow.results = (FlowResult*)(flow.nodes + FLOW_TOKENS + 1);
  analysis_head = (void*)(flow.results + FLOW_DEPTH * 3 + 1);
  flow.nodes[0].kind = FN_OBJECT; flow.nodes[0].left = 0;
  flowTokenize();
  uint16_t block = flowNode(FN_BLOCK, 0, 0, (FlowToken){0}), tail = 0;
  while (flowPeek() && !flow.failed) {
    uint16_t statement = flowStatement();
    if (tail) flow.nodes[tail].next = statement;
    else flow.nodes[block].left = statement;
    tail = statement;
  }
  FlowResult* result = &flow.results[FLOW_DEPTH * 3];
  if (!flow.failed) flowExecute(block, flowValue(FV_OBJECT, 0, 1, 0), result, 0);
  if (flow.failed || !flowReserve((flow.nodeCount + FLOW_OUTCOMES) * sizeof(Slice)))
    return status | FLOW_ANALYZED | FLOW_INCOMPLETE;
  bool complete = true;
  for (uint32_t i = 0; i < result->count && flowStep(); i++) {
    FlowValue value = result->values[i].root;
    if (value.kind == FV_UNKNOWN || value.kind == FV_OPAQUE_OBJECT || value.kind == FV_FUNCTION) {
      complete = false; continue;
    }
    _addReexport(NULL, NULL);
    if (value.kind == FV_MODULE) {
      FlowNode* specifier = &flow.nodes[flow.nodes[value.node].right];
      _addReexport(source + specifier->start, source + specifier->end);
    } else if (value.kind == FV_OBJECT) flowEmitObject(value.node, 0);
  }
  if (flow.failed) { flowClear(); complete = false; }
  return status | FLOW_ANALYZED | (complete ? 0 : FLOW_INCOMPLETE);
}
