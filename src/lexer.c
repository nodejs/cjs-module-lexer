#include "cjs-module-lexer.h"
#include "identifier-data.h"

const uint16_t* STANDARD_IMPORT = (uint16_t*)0x1;
const uint16_t* IMPORT_META = (uint16_t*)0x2;
const uint16_t __empty_char = '\0';
const uint16_t* EMPTY_CHAR = &__empty_char;
// tracked depth of template and brackets
#define STACK_DEPTH 2048
enum TokenType {
  ClassToken = 1, ExportObjectToken = 2, WebpackTableToken = 4,
  WebpackArrayKeyToken = 8, WebpackArrayBindingToken = 16, WebpackArrayValueToken = 32
};
const uint16_t* source;

bool lastSlashWasDivision;
uint16_t templateStackDepth;
uint16_t openTokenDepth;
uint16_t templateDepth;
uint16_t braceDepth;
uint16_t* lastTokenPos;
uint16_t* pos;
uint16_t* end;
uint16_t* templateStack;
uint16_t** openTokenPosStack;
bool nextBraceIsClass;
bool allowMinifiedEnumerable;
static bool extended;
static uint16_t* exportObjectPos;

typedef struct WebpackDependency {
  const uint16_t* start;
  const uint16_t* end;
  bool star;
  struct WebpackDependency* next;
} WebpackDependency;

typedef struct WebpackModule {
  const uint16_t* start;
  const uint16_t* end;
  const uint16_t* target;
  uint32_t targetLength;
  const uint16_t* module;
  uint32_t moduleLength;
  uint32_t hash;
  uint32_t depth;
  uint8_t visited;
  uint8_t requested;
  bool queued;
  bool uncertain;
  Slice* exports;
  Slice* exportsTail;
  Slice* reexports;
  Slice* reexportsTail;
  Slice* imports;
  Slice* importsTail;
  WebpackDependency* dependencies;
  WebpackDependency* dependenciesTail;
  struct WebpackModule* next;
  struct WebpackModule* bucketNext;
  struct WebpackModule* queueNext;
} WebpackModule;

static uint16_t* webpackTablePos;
static uint16_t* webpackFactoryPos;
static uint16_t* webpackTrustedEnd;
static uint16_t* webpackArrayPos;
static const uint16_t* webpackEntryStart;
static const uint16_t* webpackEntryEnd;
static WebpackModule* webpackModules;
static WebpackModule* webpackModulesTail;
static WebpackModule* webpackCurrent;
static WebpackModule* webpackPending;
static WebpackModule webpackInlineRoot;
static WebpackModule** webpackBuckets;
static uint32_t webpackCapacity, webpackCount;
static bool webpackPublished, webpackInvalid, webpackInline, webpackAlias;
static void (*webpackAddExport)(const uint16_t*, const uint16_t*);
static void (*webpackAddReexport)(const uint16_t*, const uint16_t*);

uint16_t* lastReexportStart;
uint16_t* lastReexportEnd;

// Memory Structure:
// -> source
// -> analysis starts after source
uint32_t parse_error;
uint32_t error = 0;
uint32_t sourceLen;

uint16_t templateStack_[STACK_DEPTH];
uint16_t* openTokenPosStack_[STACK_DEPTH];
uint8_t openTokenTypeStack[STACK_DEPTH];
StarExportBinding starExportBinding_;
StarExportBinding* firstStarExport;
StarExportBinding* lastStarExport;

void (*addExport)(const uint16_t*, const uint16_t*);
void (*addReexport)(const uint16_t*, const uint16_t*);
void (*addUnsafeGetter)(const uint16_t*, const uint16_t*);
void (*clearReexports)();

static bool isStatementBrace (uint16_t* curPos, uint16_t depth);
static uint16_t readExportExpressionStart ();
static bool readWebpackToken (uint16_t ch);
static void readWebpackArrayElement (uint8_t token);
static void readWebpackFactory ();
static void finishWebpack ();
static void captureWebpackExport (const uint16_t* start, const uint16_t* end);
static void captureWebpackReexport (const uint16_t* start, const uint16_t* end);
static void addWebpackDependency (const uint16_t* start, const uint16_t* end, bool star);
enum StarBindingMode { RequireBinding, WebpackImport, WebpackImportPrefix };
static bool readWebpackCall (const uint16_t** start, const uint16_t** end, bool requireExpressionEnd);
static void backtrackStarExportBinding (uint16_t* bPos, enum StarBindingMode bindingMode);

typedef struct WebpackText {
  const uint16_t* pos;
  const uint16_t* end;
  uint16_t pending;
} WebpackText;

static WebpackText webpackText (const uint16_t* start, const uint16_t* end) {
  if (start < end && (*start == '\'' || *start == '"')) { start++; end--; }
  return (WebpackText){ start, end, 0 };
}

static uint32_t readWebpackUnit (WebpackText* text) {
  if (text->pending) {
    uint32_t unit = text->pending;
    text->pending = 0;
    return unit;
  }
  while (text->pos < text->end) {
    uint32_t unit = *text->pos++;
    if (unit != '\\' || text->pos == text->end) return unit;
    unit = *text->pos++;
    if (unit == '\n' || unit == '\r' || unit == 0x2028 || unit == 0x2029) {
      if (unit == '\r' && text->pos < text->end && *text->pos == '\n') text->pos++;
      continue;
    }
    if (unit == 'u' || unit == 'x') {
      uint32_t count = unit == 'u' ? 4 : 2;
      bool braces = unit == 'u' && text->pos < text->end && *text->pos == '{';
      if (braces) {
        text->pos++;
        while (text->pos < text->end && *text->pos == '0') text->pos++;
        count = 6;
      }
      unit = 0;
      while (count-- && text->pos < text->end && *text->pos != '}') {
        uint16_t digit = *text->pos++;
        unit = unit * 16 + (digit <= '9' ? digit - '0' : (digit | 32) - 'a' + 10);
      }
      if (braces && text->pos < text->end && *text->pos == '}') text->pos++;
      if (unit > 0xffff) {
        text->pending = 0xdc00 + ((unit - 0x10000) & 0x3ff);
        unit = 0xd800 + ((unit - 0x10000) >> 10);
      }
    }
    else if (unit >= '0' && unit <= '7') {
      unit -= '0';
      for (uint32_t i = 0; i < 2 && text->pos < text->end && *text->pos >= '0' &&
           *text->pos <= '7' && unit * 8 + *text->pos - '0' <= 255; i++)
        unit = unit * 8 + *text->pos++ - '0';
    }
    else {
      switch (unit) {
        case 'n': unit = '\n'; break;
        case 'r': unit = '\r'; break;
        case 't': unit = '\t'; break;
        case 'b': unit = '\b'; break;
        case 'f': unit = '\f'; break;
        case 'v': unit = '\v'; break;
      }
    }
    return unit;
  }
  return UINT32_MAX;
}

static uint32_t webpackHash (const uint16_t* start, const uint16_t* end) {
  WebpackText text = webpackText(start, end);
  uint32_t hash = 2166136261u, unit;
  while ((unit = readWebpackUnit(&text)) != UINT32_MAX) hash = (hash ^ unit) * 16777619u;
  return hash;
}

static bool webpackEqual (const uint16_t* start, const uint16_t* end,
                          const uint16_t* other, const uint16_t* otherEnd) {
  WebpackText left = webpackText(start, end), right = webpackText(other, otherEnd);
  uint32_t unit;
  do {
    unit = readWebpackUnit(&left);
    if (unit != readWebpackUnit(&right)) return false;
  } while (unit != UINT32_MAX);
  return true;
}

static WebpackModule* findWebpackModule (const uint16_t* start, const uint16_t* end) {
  if (!webpackCapacity) return NULL;
  uint32_t hash = webpackHash(start, end);
  for (WebpackModule* module = webpackBuckets[hash & (webpackCapacity - 1)]; module; module = module->bucketNext)
    if (module->hash == hash && webpackEqual(start, end, module->start, module->end)) return module;
  return NULL;
}

static inline void resetWebpackModule (WebpackModule* module) {
  __builtin_memset_inline(module, 0, sizeof(*module));
}

static WebpackModule* createWebpackModule (const uint16_t* start, const uint16_t* end) {
  if (!webpackCapacity || webpackCount == webpackCapacity / 2) {
    if (webpackCapacity > UINT32_MAX / 2 / sizeof(WebpackModule*)) {
      syntaxError(12);
      return NULL;
    }
    webpackCapacity = webpackCapacity ? webpackCapacity * 2 : 16;
    size_t bytes = webpackCapacity * sizeof(WebpackModule*);
    ensureAnalysisCapacity(bytes);
    webpackBuckets = (WebpackModule**)(uintptr_t)analysis_head;
    analysis_head += bytes;
    for (uint32_t i = 0; i < webpackCapacity; i++) webpackBuckets[i] = NULL;
    for (WebpackModule* module = webpackModules; module; module = module->next) {
      uint32_t bucket = module->hash & (webpackCapacity - 1);
      module->bucketNext = webpackBuckets[bucket];
      webpackBuckets[bucket] = module;
    }
  }
  if (findWebpackModule(start, end)) webpackInvalid = true;
  ensureAnalysisCapacity(sizeof(WebpackModule));
  WebpackModule* module = (WebpackModule*)(uintptr_t)analysis_head;
  analysis_head += sizeof(WebpackModule);
  resetWebpackModule(module);
  module->start = start;
  module->end = end;
  module->hash = webpackHash(start, end);
  uint32_t bucket = module->hash & (webpackCapacity - 1);
  module->bucketNext = webpackBuckets[bucket];
  webpackBuckets[bucket] = module;
  if (webpackModulesTail) webpackModulesTail->next = module;
  else webpackModules = module;
  webpackModulesTail = module;
  webpackCount++;
  return module;
}

static void captureWebpackSlice (const uint16_t* start, const uint16_t* end, Slice** first, Slice** last) {
  ensureAnalysisCapacity(sizeof(Slice));
  Slice* slice = (Slice*)(uintptr_t)analysis_head;
  analysis_head += sizeof(Slice);
  *slice = (Slice){ start, end, NULL };
  if (*last) (*last)->next = slice;
  else *first = slice;
  *last = slice;
}

static void captureWebpackExport (const uint16_t* start, const uint16_t* end) {
  captureWebpackSlice(start, end, &webpackCurrent->exports, &webpackCurrent->exportsTail);
}

static void captureWebpackReexport (const uint16_t* start, const uint16_t* end) {
  captureWebpackSlice(start, end, &webpackCurrent->reexports, &webpackCurrent->reexportsTail);
}

static void addWebpackDependency (const uint16_t* start, const uint16_t* end, bool star) {
  WebpackModule* owner = webpackCurrent ? webpackCurrent : &webpackInlineRoot;
  ensureAnalysisCapacity(sizeof(WebpackDependency));
  WebpackDependency* dependency = (WebpackDependency*)(uintptr_t)analysis_head;
  analysis_head += sizeof(WebpackDependency);
  *dependency = (WebpackDependency){ start, end, star, NULL };
  if (owner->dependenciesTail) owner->dependenciesTail->next = dependency;
  else owner->dependencies = dependency;
  owner->dependenciesTail = dependency;
}

static bool readWebpackId (const uint16_t** start, const uint16_t** finish) {
  uint16_t ch = commentWhitespace();
  *start = pos;
  if (ch == '\'' || ch == '"') { stringLiteral(ch); pos++; }
  else if (ch >= '0' && ch <= '9') { while (*pos >= '0' && *pos <= '9') pos++; }
  else if (!identifier(ch)) return false;
  *finish = pos;
  return !error;
}

static bool readWebpackExpressionEnd () {
  uint16_t ch = commentWhitespace();
  return pos > end || ch == ';' || ch == ',' || ch == ')' || ch == '}';
}

static bool isWebpackCallExpression () {
  uint16_t* callEnd = pos++;
  bool complete = readWebpackExpressionEnd();
  pos = callEnd;
  return complete;
}

static bool readWebpackCall (const uint16_t** start, const uint16_t** finish, bool requireExpressionEnd) {
  uint16_t* revert = pos;
  if (str_eq18(pos + 1, '_', 'w', 'e', 'b', 'p', 'a', 'c', 'k', '_', 'r', 'e', 'q', 'u', 'i', 'r', 'e', '_', '_')) {
    pos += 19;
    if (commentWhitespace() == '(') {
      pos++;
      uint16_t ch = commentWhitespace();
      if ((ch == '\'' || ch == '"' || ch >= '0' && ch <= '9') &&
          readWebpackId(start, finish) && commentWhitespace() == ')' &&
          (!requireExpressionEnd || isWebpackCallExpression())) return true;
    }
  }
  pos = revert;
  return false;
}

static uint32_t webpackCharAt (const uint16_t* at) {
  if (at > end) return 0;
  uint16_t ch = *at;
  return (ch & 0xfc00) == 0xd800 ? (((ch & 0x3ff) << 10) | (*(at + 1) & 0x3ff)) + 0x10000 : ch;
}

static bool matchesWebpackBinding (const uint16_t* binding, uint32_t length) {
  return binding && (size_t)(end - pos + 1) >= length && *pos == *binding &&
    memcmp(pos, binding, length * sizeof(uint16_t)) == 0 && !isIdentifierChar(webpackCharAt(pos + length));
}

static void trustWebpackExports (uint16_t* finish) {
  if (webpackTablePos && finish > webpackTrustedEnd) webpackTrustedEnd = finish;
}

static void markWebpackExportsUncertain () {
  if (webpackCurrent) webpackCurrent->uncertain = true;
  else if (webpackInline) webpackInvalid = true;
}

static inline __attribute__((always_inline)) bool matchesWebpackExports () {
  return end - pos >= 18 && *pos == '_' &&
    str_eq18(pos + 1, '_', 'w', 'e', 'b', 'p', 'a', 'c', 'k', '_', 'e', 'x', 'p', 'o', 'r', 't', 's', '_', '_') &&
    !isIdentifierChar(webpackCharAt(pos + 19));
}

static bool readWebpackExportsAlias (uint16_t* start) {
  if (!readPrecedingKeyword3(lastTokenPos, 'v', 'a', 'r') &&
      !readPrecedingKeyword3(lastTokenPos, 'l', 'e', 't') &&
      !readPrecedingKeyword5(lastTokenPos, 'c', 'o', 'n', 's', 't')) return false;
  uint16_t* revert = pos;
  pos = start + 7;
  bool alias = false;
  if (commentWhitespace() == '=') {
    pos++;
    commentWhitespace();
    if (matchesWebpackExports()) {
      pos += 19;
      alias = readWebpackExpressionEnd();
      if (alias) trustWebpackExports(pos);
    }
  }
  pos = revert;
  return alias;
}

static bool readWebpackToken (uint16_t ch) {
  uint16_t* start = pos;
  if (webpackCurrent) {
    if (matchesWebpackBinding(webpackCurrent->target, webpackCurrent->targetLength)) {
      if (!tryParseExportsDotAssign(false, webpackCurrent->targetLength) && start >= webpackTrustedEnd)
        webpackCurrent->uncertain = true;
      return true;
    }
    if (matchesWebpackBinding(webpackCurrent->module, webpackCurrent->moduleLength)) {
      if (!tryParseModuleExportsDotAssign(webpackCurrent->moduleLength) && start >= webpackTrustedEnd)
        webpackCurrent->uncertain = true;
      return true;
    }
  }
  if (ch != '_') return false;
  if (str_eq18(pos + 1, '_', 'w', 'e', 'b', 'p', 'a', 'c', 'k', '_', 'm', 'o', 'd', 'u', 'l', 'e', 's', '_', '_') &&
      !isIdentifierChar(webpackCharAt(pos + 19))) {
    pos += 19;
    if (commentWhitespace() == '=') {
      pos++;
      uint16_t next = commentWhitespace();
      if (next == '(') next = readExportExpressionStart();
      if (next == '{') {
        if (webpackTablePos) webpackInvalid = true;
        else webpackTablePos = pos;
      }
    }
    pos = start;
    return false;
  }
  if (matchesWebpackExports()) {
    if (!tryParseExportsDotAssign(false, 19) && webpackTablePos && !webpackCurrent && start >= webpackTrustedEnd) {
      uint16_t* revert = pos++;
      if (commentWhitespace() == '=') {
        pos++;
        uint16_t next = commentWhitespace();
        webpackInline = false;
        if (next == '{') {
          pos++;
          if (commentWhitespace() == '}') {
            pos++;
            webpackInline = readWebpackExpressionEnd();
          }
        }
        webpackEntryStart = webpackEntryEnd = NULL;
        const uint16_t *id, *idEnd;
        if (next == '_' && readWebpackCall(&id, &idEnd, true)) { webpackEntryStart = id; webpackEntryEnd = idEnd; }
        if (!webpackInline && !webpackEntryStart) webpackInvalid = true;
      } else webpackInvalid = true;
      pos = revert;
    }
    return true;
  }
  if (!str_eq18(pos + 1, '_', 'w', 'e', 'b', 'p', 'a', 'c', 'k', '_', 'r', 'e', 'q', 'u', 'i', 'r', 'e', '_', '_') ||
      isIdentifierChar(webpackCharAt(pos + 19))) return false;
  if (webpackCurrent ? openTokenDepth == webpackCurrent->depth : webpackInline) {
    const uint16_t *specifierStart, *specifierEnd;
    if (readWebpackCall(&specifierStart, &specifierEnd, false)) {
      bool complete = isWebpackCallExpression();
      if (complete) {
        starExportBinding_.specifier_start = specifierStart;
        starExportBinding_.specifier_end = specifierEnd;
        WebpackModule* owner = webpackCurrent ? webpackCurrent : &webpackInlineRoot;
        captureWebpackSlice(specifierStart, specifierEnd, &owner->imports, &owner->importsTail);
      }
      backtrackStarExportBinding(start - 1, complete ? WebpackImport : WebpackImportPrefix);
      if (complete) return true;
      pos = start;
    }
  }
  pos = start + 19;
  if (commentWhitespace() == '.') {
    pos++;
    uint16_t method = commentWhitespace();
    if (method == 'd' || method == 'r') {
      pos++;
      if (commentWhitespace() == '(') {
        pos++;
        if (readExportsOrModuleDotExports(commentWhitespace())) {
          uint16_t* argEnd = pos;
          uint16_t next = commentWhitespace();
          if (method == 'r' && next == ')') trustWebpackExports(argEnd);
          if (method == 'd' && next == ',') {
            pos++;
            uint16_t definition = commentWhitespace();
            if (definition == '{') {
              exportObjectPos = pos;
              trustWebpackExports(argEnd);
            }
            else if (definition == '[') {
              webpackArrayPos = pos;
              trustWebpackExports(argEnd);
            }
          }
        }
      }
    }
  }
  pos = start;
  return false;
}

static void readWebpackArrayElement (uint8_t token) {
  uint16_t* start = pos++;
  uint16_t ch = commentWhitespace();
  uint8_t next = WebpackArrayKeyToken;
  if (token == WebpackArrayKeyToken) {
    next = 0;
    if (ch == '"' || ch == '\'') {
      uint16_t* name = pos;
      stringLiteral(ch);
      uint16_t* nameEnd = ++pos;
      if (commentWhitespace() == ',') {
        addExport(name, nameEnd);
        next = WebpackArrayBindingToken;
      }
    }
    if (!next && ch != ']') markWebpackExportsUncertain();
  }
  else if (token == WebpackArrayBindingToken && ch == '0') {
    pos++;
    if (commentWhitespace() == ',') next = WebpackArrayValueToken;
  }
  openTokenTypeStack[openTokenDepth - 1] = next;
  if (!error) pos = start;
}

static void readWebpackFactory () {
  uint16_t* revert = pos;
  const uint16_t *id, *idEnd, *module = NULL, *moduleEnd = NULL, *target = NULL, *targetEnd = NULL, *ignored, *ignoredEnd;
  pos++;
  bool found = readWebpackId(&id, &idEnd);
  uint16_t separator = commentWhitespace();
  if (found && (separator == ':' || separator == '(')) {
    if (separator == ':') pos++;
    uint16_t ch = commentWhitespace();
    if (separator == ':' && ch == '(') {
      uint16_t* opening = pos++;
      ch = commentWhitespace();
      if (ch != '(' && !(ch == 'f' && str_eq7(pos + 1, 'u', 'n', 'c', 't', 'i', 'o', 'n'))) { pos = opening; ch = '('; }
    }
    bool fn = ch == 'f' && str_eq7(pos + 1, 'u', 'n', 'c', 't', 'i', 'o', 'n');
    if (fn) { pos += 8; ch = commentWhitespace(); }
    if (ch == '(') {
      pos++;
      if (commentWhitespace() != ')') readWebpackId(&module, &moduleEnd);
      ch = commentWhitespace();
      if (ch == ',') {
        pos++;
        readWebpackId(&target, &targetEnd);
        ch = commentWhitespace();
        if (ch == ',') { pos++; readWebpackId(&ignored, &ignoredEnd); ch = commentWhitespace(); }
      }
      if (ch == ')') {
        pos++;
        ch = commentWhitespace();
        bool arrow = !fn && separator == ':';
        if (arrow && ch == '=' && *(pos + 1) == '>') { pos += 2; ch = commentWhitespace(); }
        else if (arrow) ch = 0;
        if (ch == '{') {
        webpackFactoryPos = pos;
        trustWebpackExports(pos);
          webpackPending = createWebpackModule(id, idEnd);
          if (webpackPending) {
            webpackPending->target = target;
            webpackPending->targetLength = target ? targetEnd - target : 0;
            webpackPending->module = module;
            webpackPending->moduleLength = module ? moduleEnd - module : 0;
          }
        }
      }
    }
  }
  if (found && (!webpackFactoryPos || webpackFactoryPos <= revert)) webpackInvalid = true;
  if (!error) pos = revert;
}

static void finishWebpack () {
  WebpackModule* first = NULL;
  WebpackModule* last = NULL;
  if (webpackPublished && (webpackEntryStart || webpackInline) && !webpackInvalid) {
    first = last = webpackEntryStart ? findWebpackModule(webpackEntryStart, webpackEntryEnd) : &webpackInlineRoot;
    if (!first) webpackInvalid = true;
    else { first->requested = 2; first->queued = true; }
  }
  while (first && !webpackInvalid) {
    WebpackModule* module = first;
    if (module->uncertain) { webpackInvalid = true; break; }
    first = first->queueNext;
    if (!first) last = NULL;
    module->queued = false;
    uint8_t flag = module->requested & 2 ? 2 : 1;
    if (module->visited & flag) continue;
    module->visited |= flag;
    static const uint16_t defaultName[] = { 'd', 'e', 'f', 'a', 'u', 'l', 't' };
    static const uint16_t esModuleName[] = { '_', '_', 'e', 's', 'M', 'o', 'd', 'u', 'l', 'e' };
    for (Slice* slice = module->exports; slice; slice = slice->next)
      if (flag == 2 || !webpackEqual(slice->start, slice->end, defaultName, defaultName + 7) &&
          !webpackEqual(slice->start, slice->end, esModuleName, esModuleName + 10))
        webpackAddExport(slice->start, slice->end);
    for (Slice* slice = module->reexports; slice; slice = slice->next)
      webpackAddReexport(slice->start, slice->end);
    for (WebpackDependency* dependency = module->dependencies; dependency; dependency = dependency->next) {
      WebpackModule* target = findWebpackModule(dependency->start, dependency->end);
      if (!target) { webpackInvalid = true; break; }
      uint8_t requested = flag == 1 || dependency->star ? 1 : 2;
      target->requested |= requested;
      if (target->queued || target->visited & requested) continue;
      target->queued = true;
      target->queueNext = NULL;
      if (last) last->queueNext = target;
      else first = target;
      last = target;
    }
  }
  if (!webpackPublished || !webpackEntryStart && !webpackInline || webpackInvalid) {
    for (WebpackModule* module = webpackModules; module; module = module->next) {
      for (Slice* slice = module->exports; slice; slice = slice->next) webpackAddExport(slice->start, slice->end);
      for (Slice* slice = module->reexports; slice; slice = slice->next) webpackAddReexport(slice->start, slice->end);
    }
  }
}

static inline __attribute__((always_inline)) bool isTokenRunChar (uint16_t ch) {
  static const bool ascii[128] = {
    ['0' ... '9'] = true,
    ['A' ... 'Z'] = true,
    ['a' ... 'z'] = true,
    ['$'] = true,
    ['\\'] = true,
    ['_'] = true
  };
  return ch < sizeof(ascii) ? ascii[ch] : ch != 160;
}

static inline __attribute__((always_inline)) bool pushOpenToken (uint16_t* tokenPos) {
  if (openTokenDepth == STACK_DEPTH) {
    syntaxError(12);
    return false;
  }
  if (extended) openTokenTypeStack[openTokenDepth] = 0;
  openTokenPosStack[openTokenDepth++] = tokenPos;
  return true;
}

static inline __attribute__((always_inline)) bool pushTemplate () {
  if (templateStackDepth == STACK_DEPTH || openTokenDepth == STACK_DEPTH) {
    syntaxError(12);
    return false;
  }
  templateStack[templateStackDepth++] = templateDepth;
  if (extended) openTokenTypeStack[openTokenDepth] = 0;
  templateDepth = ++openTokenDepth;
  return true;
}

uint32_t parseCJS (uint16_t* _source, uint32_t _sourceLen, void (*_addExport)(const uint16_t*, const uint16_t*), void (*_addReexport)(const uint16_t*, const uint16_t*), void (*_addUnsafeGetter)(const uint16_t*, const uint16_t*), void (*_clearReexports)()) {
  return parseCJSWithOptions(_source, _sourceLen, _addExport, _addReexport, _addUnsafeGetter, _clearReexports, 0);
}

// Note: parsing is based on the _assumption_ that the source is already valid
static __attribute__((always_inline)) uint32_t parseCJSMode (uint16_t* _source, uint32_t _sourceLen, void (*_addExport)(const uint16_t*, const uint16_t*), void (*_addReexport)(const uint16_t*, const uint16_t*), void (*_addUnsafeGetter)(const uint16_t*, const uint16_t*), void (*_clearReexports)(), uint32_t options, bool extendedMode) {
  if (addExport == captureWebpackExport) addExport = webpackAddExport;
  if (addReexport == captureWebpackReexport) addReexport = webpackAddReexport;
  source = _source;
  sourceLen = _sourceLen;
  allowMinifiedEnumerable = (options & 1) != 0;
  extended = extendedMode;
  if (_addExport)
    addExport = _addExport;
  if (_addReexport)
    addReexport = _addReexport;
  if (_addUnsafeGetter)
    addUnsafeGetter = _addUnsafeGetter;

  templateStackDepth = 0;
  openTokenDepth = 0;
  templateDepth = UINT16_MAX;
  lastTokenPos = (uint16_t*)EMPTY_CHAR;
  lastSlashWasDivision = false;
  parse_error = 0;
  error = 0;
  templateStack = &templateStack_[0];
  openTokenPosStack = &openTokenPosStack_[0];
  firstStarExport = NULL;
  lastStarExport = NULL;
  StarExportBinding* outerFirstStarExport = NULL;
  StarExportBinding* outerLastStarExport = NULL;
  nextBraceIsClass = false;
  exportObjectPos = 0;
  if (extendedMode) {
    webpackTablePos = webpackFactoryPos = NULL;
    webpackEntryStart = webpackEntryEnd = NULL;
    webpackModules = webpackModulesTail = webpackCurrent = webpackPending = NULL;
    webpackBuckets = NULL;
    webpackCapacity = webpackCount = 0;
    webpackPublished = webpackInvalid = webpackInline = webpackAlias = false;
    resetWebpackModule(&webpackInlineRoot);
    webpackTrustedEnd = _source;
    webpackArrayPos = NULL;
    webpackAddExport = addExport;
    webpackAddReexport = addReexport;
  }

  pos = (uint16_t*)(source - 1);
  uint16_t ch = '\0';
  end = pos + sourceLen;

  // Handle #!
  if (*source == '#' && *(source + 1) == '!') {
    if (sourceLen == 2)
      return 0;
    pos += 2;
    while (pos++ < end) {
      ch = *pos;
      if (ch == '\n' || ch == '\r')
        break;
    }
  }

  while (pos++ < end) {
    ch = *pos;

    if (ch == 32 || ch < 14 && ch > 8)
      continue;

    if (extendedMode && (ch == '_' || webpackCurrent &&
        (webpackCurrent->target && *webpackCurrent->target == ch ||
         webpackCurrent->module && *webpackCurrent->module == ch)) && keywordStart(pos) && readWebpackToken(ch))
      goto skipTokenRun;

    if (openTokenDepth == 0 || extendedMode && webpackCurrent && webpackCurrent->depth == openTokenDepth) {
      switch (ch) {
        case 'i':
          if (str_eq5(pos + 1, 'm', 'p', 'o', 'r', 't') && keywordStart(pos))
            throwIfImportStatement();
          goto skipTokenRun;
        case 'r': {
          uint16_t* startPos = pos;
          if (tryParseRequire(Import) && keywordStart(startPos))
            tryBacktrackAddStarExportBinding(startPos - 1);
          goto skipTokenRun;
        }
        case '_':
          if (str_eq22(pos + 1, 'i', 'n', 't', 'e', 'r', 'o', 'p', 'R', 'e', 'q', 'u', 'i', 'r', 'e', 'W', 'i', 'l', 'd', 'c', 'a', 'r', 'd') && (keywordStart(pos) || *(pos - 1) == '.')) {
            uint16_t* startPos = pos;
            pos += 23;
            if (*pos == '(') {
              pos++;
              if (!pushOpenToken(lastTokenPos))
                return error;
              if (tryParseRequire(Import) && keywordStart(startPos))
                tryBacktrackAddStarExportBinding(startPos - 1);
            }
          }
          else if (str_eq7(pos + 1, '_', 'e', 'x', 'p', 'o', 'r', 't') && (keywordStart(pos) || *(pos - 1) == '.')) {
            pos += 8;
            if (str_eq4(pos, 'S', 't', 'a', 'r'))
              pos += 4;
            if (*pos == '(') {
              if (!pushOpenToken(lastTokenPos))
                return error;
              if (*(pos + 1) == 'r') {
                pos++;
                tryParseRequire(ExportStar);
              }
            }
          }
          goto skipTokenRun;
      }
    }

    switch (ch) {
      case 'e':
        if (str_eq5(pos + 1, 'x', 'p', 'o', 'r', 't') && keywordStart(pos)) {
          if (*(pos + 6) == 's') {
            uint16_t* start = pos;
            if (!tryParseExportsDotAssign(false, 7) && extendedMode && webpackInline && !webpackCurrent &&
                start >= webpackTrustedEnd && !isIdentifierChar(webpackCharAt(start + 7))) {
              if (readWebpackExportsAlias(start)) webpackAlias = true;
              else if (webpackAlias) webpackInvalid = true;
            }
          }
          else if (openTokenDepth == 0)
            throwIfExportStatement();
        }
        goto skipTokenRun;
      case 'c':
        if (keywordStart(pos) && str_eq4(pos + 1, 'l', 'a', 's', 's') && isBrOrWs(*(pos + 5)))
          nextBraceIsClass = true;
        goto skipTokenRun;
      case 'm':
        if (str_eq5(pos + 1, 'o', 'd', 'u', 'l', 'e') && keywordStart(pos))
          tryParseModuleExportsDotAssign(6);
        goto skipTokenRun;
      case 'O':
        if (str_eq5(pos + 1, 'b', 'j', 'e', 'c', 't') && keywordStart(pos))
          tryParseObjectDefineOrKeys(openTokenDepth == 0 || extendedMode &&
            (webpackCurrent ? webpackCurrent->depth == openTokenDepth : webpackInline));
        goto skipTokenRun;
      case '(':
        if (!pushOpenToken(lastTokenPos))
          return error;
        break;
      case '[':
        if (extendedMode) {
          if (!pushOpenToken(lastTokenPos))
            return error;
          if (pos == webpackArrayPos) {
            webpackArrayPos = NULL;
            readWebpackArrayElement(WebpackArrayKeyToken);
          }
        }
        break;
      case ']':
        if (extendedMode) {
          if (openTokenDepth == 0)
            return syntaxError(8), error;
          openTokenDepth--;
        }
        break;
      case ',':
        if (extendedMode && openTokenDepth) {
          uint8_t token = openTokenTypeStack[openTokenDepth - 1];
          if (token & WebpackTableToken) readWebpackFactory();
          if (token & ExportObjectToken) readExportProperty();
          if (token >= WebpackArrayKeyToken) readWebpackArrayElement(token);
        }
        break;
      case ')':
        if (openTokenDepth == 0)
          return syntaxError(8), error;
        openTokenDepth--;
        break;
      case '{':
        if (!pushOpenToken(lastTokenPos))
          return error;
        openTokenTypeStack[openTokenDepth - 1] = nextBraceIsClass ? ClassToken : 0;
        nextBraceIsClass = false;
        if (extendedMode && pos == exportObjectPos) {
          openTokenTypeStack[openTokenDepth - 1] |= ExportObjectToken;
          exportObjectPos = 0;
          readExportProperty();
        }
        if (extendedMode && pos == webpackTablePos) {
          openTokenTypeStack[openTokenDepth - 1] |= WebpackTableToken;
          readWebpackFactory();
        }
        else if (extendedMode && pos == webpackFactoryPos) {
          webpackCurrent = webpackPending;
          webpackCurrent->depth = openTokenDepth;
          outerFirstStarExport = firstStarExport;
          outerLastStarExport = lastStarExport;
          firstStarExport = lastStarExport = NULL;
          addExport = captureWebpackExport;
          addReexport = captureWebpackReexport;
        }
        break;
      case '}':
        if (openTokenDepth == 0)
          return syntaxError(2), error;
        if (extendedMode && webpackCurrent && webpackCurrent->depth == openTokenDepth) {
          webpackCurrent = NULL;
          firstStarExport = outerFirstStarExport;
          lastStarExport = outerLastStarExport;
          addExport = webpackAddExport;
          addReexport = webpackAddReexport;
        }
        if (openTokenDepth-- == templateDepth) {
          templateDepth = templateStack[--templateStackDepth];
          templateString();
        }
        else {
          if (templateDepth != UINT16_MAX && openTokenDepth < templateDepth)
            return syntaxError(3), error;
        }
        break;
      case '<':
        // TODO: <!-- XML comment support
        break;
      case '\'':
      case '"':
        stringLiteral(ch);
        break;
      case '/': {
        uint16_t next_ch = *(pos + 1);
        if (next_ch == '/') {
          lineComment();
          // dont update lastToken
          continue;
        }
        else if (next_ch == '*') {
          blockComment();
          // dont update lastToken
          continue;
        }
        else {
          // Division / regex ambiguity handling based on checking backtrack analysis of:
          // - what token came previously (lastToken)
          // - if a closing brace or paren, what token came before the corresponding
          //   opening brace or paren (lastOpenTokenIndex)
          uint16_t lastToken = *lastTokenPos;
          if (isExpressionPunctuator(lastToken) &&
              !(lastToken == '.' && (*(lastTokenPos - 1) >= '0' && *(lastTokenPos - 1) <= '9')) &&
              !(lastToken == '+' && *(lastTokenPos - 1) == '+') && !(lastToken == '-' && *(lastTokenPos - 1) == '-') ||
              lastToken == ')' && isParenKeyword(openTokenPosStack[openTokenDepth]) ||
              lastToken == '}' && (isExpressionTerminator(openTokenPosStack[openTokenDepth]) ||
              (openTokenTypeStack[openTokenDepth] & ClassToken) ||
              extendedMode && isStatementBrace(openTokenPosStack[openTokenDepth], openTokenDepth)) ||
              lastToken == '/' && lastSlashWasDivision ||
              isExpressionKeyword(lastTokenPos) ||
              !lastToken) {
            regularExpression();
            lastSlashWasDivision = false;
          }
          else {
            lastSlashWasDivision = true;
          }
        }
        break;
      }
      case '`':
        if (templateDepth == UINT16_MAX - 1)
          return syntaxError(4), error;
        templateString();
        break;
      default:
      skipTokenRun:
        if (!isTokenRunChar(*pos))
          break;
        while (isTokenRunChar(*(pos + 1)))
          pos++;
    }
    lastTokenPos = pos;
  }

  if (templateDepth != UINT16_MAX || openTokenDepth || error) {
    if (!error)
      syntaxError(1);
    return error;
  }

  if (extendedMode && webpackTablePos) finishWebpack();
  // success
  return 0;
}

uint32_t parseCJSWithOptions (uint16_t* source, uint32_t sourceLen, void (*addExport)(const uint16_t*, const uint16_t*), void (*addReexport)(const uint16_t*, const uint16_t*), void (*addUnsafeGetter)(const uint16_t*, const uint16_t*), void (*clearReexports)(), uint32_t options) {
  if (options & 2)
    return parseCJSMode(source, sourceLen, addExport, addReexport, addUnsafeGetter, clearReexports, options, true);
  return parseCJSMode(source, sourceLen, addExport, addReexport, addUnsafeGetter, clearReexports, options, false);
}

void tryBacktrackAddStarExportBinding (uint16_t* bPos) {
  backtrackStarExportBinding(bPos, RequireBinding);
}

static StarExportBinding* findStarExportBinding (const uint16_t* start, ptrdiff_t length, bool latest) {
  StarExportBinding* binding = NULL;
  for (StarExportBinding* candidate = firstStarExport; candidate; candidate = candidate->next) {
    if (length == candidate->id_end - candidate->id_start &&
        memcmp(start, candidate->id_start, length * sizeof(uint16_t)) == 0) {
      binding = candidate;
      if (!latest) break;
    }
  }
  return binding;
}

static void backtrackStarExportBinding (uint16_t* bPos, enum StarBindingMode bindingMode) {
  while (*bPos == ' ' && bPos > source)
    bPos--;
  if (*bPos == '=') {
    bPos--;
    while (*bPos == ' ' && bPos > source)
      bPos--;
    uint32_t charCode;
    uint16_t* id_end = bPos;
    bool identifierStart = false;
    while ((charCode = fullCharCodeAtLast(bPos)) && bPos > source) {
      if (charCode == '\\')
        return;
      if (!isIdentifierChar(charCode))
        break;
      identifierStart = isIdentifierStart(charCode);
      bPos -= charCodeByteLen(charCode);
    }
    uint16_t* idStart = bPos + 1;
    if (!identifierStart) return;
    if (bindingMode != WebpackImportPrefix && *bPos == ' ') {
      while (*bPos == ' ' && bPos > source)
        bPos--;
      if (*bPos == 'r' && readPrecedingKeyword2(bPos - 1, 'v', 'a') ||
          *bPos == 't' && (readPrecedingKeyword2(bPos - 1, 'l', 'e') ||
                          readPrecedingKeyword4(bPos - 1, 'c', 'o', 'n', 's'))) {
        ensureAnalysisCapacity(sizeof(StarExportBinding));
        StarExportBinding* binding = (StarExportBinding*)(uintptr_t)analysis_head;
        analysis_head += sizeof(StarExportBinding);
        *binding = starExportBinding_;
        binding->id_start = idStart;
        binding->id_end = id_end + 1;
        binding->next = NULL;
        if (lastStarExport)
          lastStarExport->next = binding;
        else
          firstStarExport = binding;
        lastStarExport = binding;
        return;
      }
    }
    if (bindingMode != RequireBinding && keywordStart(idStart) && findStarExportBinding(idStart, id_end + 1 - idStart, false))
      markWebpackExportsUncertain();
  }
}

bool tryParseObjectHasOwnProperty (uint16_t* it_id_start, ptrdiff_t it_id_len) {
  uint16_t ch = commentWhitespace();
  if (ch != 'O' || !str_eq5(pos + 1, 'b', 'j', 'e', 'c', 't')) return false;
  pos += 6;
  ch = commentWhitespace();
  if (ch != '.') return false;
  pos++;
  ch = commentWhitespace();
  if (ch == 'p') {
    if (!str_eq8(pos + 1, 'r', 'o', 't', 'o', 't', 'y', 'p', 'e')) return false;
    pos += 9;
    ch = commentWhitespace();
    if (ch != '.') return false;
    pos++;
    ch = commentWhitespace();
  }
  if (ch != 'h' || !str_eq13(pos + 1, 'a', 's', 'O', 'w', 'n', 'P', 'r', 'o', 'p', 'e', 'r', 't', 'y')) return false;
  pos += 14;
  ch = commentWhitespace();
  if (ch != '.') return false;
  pos++;
  ch = commentWhitespace();
  if (ch != 'c' || !str_eq3(pos + 1, 'a', 'l', 'l')) return false;
  pos += 4;
  ch = commentWhitespace();
  if (ch != '(') return false;
  pos++;
  ch = commentWhitespace();
  if (!identifier(ch)) return false;
  ch = commentWhitespace();
  if (ch != ',') return false;
  pos++;
  ch = commentWhitespace();
  if (memcmp(pos, it_id_start, it_id_len * sizeof(uint16_t)) != 0) return false;
  pos += it_id_len;
  ch = commentWhitespace();
  if (ch != ')') return false;
  pos++;
  return true;
}

static inline bool tryParseMinifiedEnumerable (uint16_t ch) {
  if (!allowMinifiedEnumerable || ch != '!') return false;
  pos++;
  if (commentWhitespace() != '0') return false;
  pos++;
  return true;
}

void tryParseObjectDefineOrKeys (bool keys) {
  pos += 6;
  uint16_t* revertPos = pos - 1;
  uint16_t ch = commentWhitespace();
  if (ch == '.') {
    pos++;
    ch = commentWhitespace();
    if (extended && ch == 'd') {
      readExportDefinition();
      pos = revertPos;
      return;
    }
    if (ch == 'd' && str_eq13(pos + 1, 'e', 'f', 'i', 'n', 'e', 'P', 'r', 'o', 'p', 'e', 'r', 't', 'y')) {
      uint16_t* exportStart = 0;
      uint16_t* exportEnd = 0;
      while (true) {
        pos += 14;
        revertPos = pos - 1;
        ch = commentWhitespace();
        if (ch != '(') break;
        pos++;
        ch = commentWhitespace();
        if (!readExportsOrModuleDotExports(ch)) break;
        ch = commentWhitespace();
        if (ch != ',') break;
        pos++;
        ch = commentWhitespace();
        if (ch != '\'' && ch != '"') break;
        exportStart = pos;
        stringLiteral(ch);
        exportEnd = ++pos;
        ch = commentWhitespace();
        if (ch != ',') break;
        pos++;
        ch = commentWhitespace();
        if (ch != '{') break;
        pos++;
        ch = commentWhitespace();
        if (ch == 'e') {
          if (!str_eq9(pos + 1, 'n', 'u', 'm', 'e', 'r', 'a', 'b', 'l', 'e')) break;
          pos += 10;
          ch = commentWhitespace();
          if (ch != ':') break;
          pos++;
          ch = commentWhitespace();
          if (ch == 't' && str_eq3(pos + 1, 'r', 'u', 'e')) {
            pos += 4;
          } else if (!tryParseMinifiedEnumerable(ch)) {
            break;
          }
          ch = commentWhitespace();
          if (ch != 44) break;
          pos++;
          ch = commentWhitespace();
        }
        if (ch == 'v') {
          if (!str_eq4(pos + 1, 'a', 'l', 'u', 'e')) break;
          pos += 5;
          ch = commentWhitespace();
          if (ch != ':') break;
          addExport(exportStart, exportEnd);
          pos = revertPos;
          return;
        }
        else if (ch == 'g') {
          if (!str_eq2(pos + 1, 'e', 't')) break;
          pos += 3;
          ch = commentWhitespace();
          if (ch == ':') {
            pos++;
            ch = commentWhitespace();
            if (ch != 'f') break;
            if (!str_eq7(pos + 1, 'u', 'n', 'c', 't', 'i', 'o', 'n')) break;
            pos += 8;
            uint16_t* lastPos = pos;
            ch = commentWhitespace();
            if (ch != '(' && (lastPos == pos || !identifier(ch))) break;
            ch = commentWhitespace();
          }
          if (ch != '(') break;
          pos++;
          ch = commentWhitespace();
          if (ch != ')') break;
          pos++;
          ch = commentWhitespace();
          if (ch != '{') break;
          pos++;
          ch = commentWhitespace();
          if (ch != 'r') break;
          if (!str_eq5(pos + 1, 'e', 't', 'u', 'r', 'n')) break;
          pos += 6;
          ch = commentWhitespace();
          if (!identifier(ch)) break;
          ch = commentWhitespace();
          if (ch == '.') {
            pos++;
            ch = commentWhitespace();
            if (!identifier(ch)) break;
            ch = commentWhitespace();
          }
          else if (ch == '[') {
            pos++;
            ch = commentWhitespace();
            if (ch == '\'' || ch == '"') stringLiteral(ch);
            else break;
            pos++;
            ch = commentWhitespace();
            if (ch != ']') break;
            pos++;
            ch = commentWhitespace();
          }
          if (ch == ';') {
            pos++;
            ch = commentWhitespace();
          }
          if (ch != '}') break;
          pos++;
          ch = commentWhitespace();
          if (ch == ',') {
            pos++;
            ch = commentWhitespace();
          }
          if (ch != '}') break;
          pos++;
          ch = commentWhitespace();
          if (ch != ')') break;
          addExport(exportStart, exportEnd);
          return;
        }
        break;
      }
      if (exportEnd > 0) {
        addUnsafeGetter(exportStart, exportEnd);
      }
    }
    else if (keys && ch == 'k' && str_eq3(pos + 1, 'e', 'y', 's')) {
      while (true) {
        pos += 4;
        revertPos = pos - 1;
        ch = commentWhitespace();
        if (ch != '(') break;
        pos++;
        ch = commentWhitespace();
        uint16_t* id_start = pos;
        if (!identifier(ch)) break;
        ptrdiff_t id_len = pos - id_start;
        ch = commentWhitespace();
        if (ch != ')') break;

        revertPos = pos++;
        ch = commentWhitespace();
        if (ch != '.') break;
        pos++;
        ch = commentWhitespace();
        if (ch != 'f' || !str_eq6(pos + 1, 'o', 'r', 'E', 'a', 'c', 'h')) break;
        pos += 7;
        ch = commentWhitespace();
        revertPos = pos - 1;
        if (ch != '(') break;
        pos++;
        ch = commentWhitespace();
        if (ch != 'f' || !str_eq7(pos + 1, 'u', 'n', 'c', 't', 'i', 'o', 'n')) break;
        pos += 8;
        ch = commentWhitespace();
        if (ch != '(') break;
        pos++;
        ch = commentWhitespace();
        uint16_t* it_id_start = pos;
        if (!identifier(ch)) break;
        ptrdiff_t it_id_len = pos - it_id_start;
        ch = commentWhitespace();
        if (ch != ')') break;
        pos++;
        ch = commentWhitespace();
        if (ch != '{') break;
        pos++;
        ch = commentWhitespace();
        if (ch != 'i' || *(pos + 1) != 'f') break;
        pos += 2;
        ch = commentWhitespace();
        if (ch != '(') break;
        pos++;
        ch = commentWhitespace();
        if (memcmp(pos, it_id_start, it_id_len * sizeof(uint16_t)) != 0) break;
        pos += it_id_len;
        ch = commentWhitespace();
        // `if (` IDENTIFIER$2 `===` ( `'default'` | `"default"` ) `||` IDENTIFIER$2 `===` ( '__esModule' | `"__esModule"` ) `) return` `;`? |
        if (ch == '=') {
          if (!str_eq2(pos + 1, '=', '=')) break;
          pos += 3;
          ch = commentWhitespace();
          if (ch != '"' && ch != '\'') break;
          uint16_t quot = ch;
          if (!str_eq7(pos + 1, 'd', 'e', 'f', 'a', 'u', 'l', 't')) break;
          pos += 8;
          ch = commentWhitespace();
          if (ch != quot) break;
          pos += 1;
          ch = commentWhitespace();
          if (ch != '|' || *(pos + 1) != '|') break;
          pos += 2;
          ch = commentWhitespace();
          if (memcmp(pos, it_id_start, it_id_len * sizeof(uint16_t)) != 0) break;
          pos += it_id_len;
          ch = commentWhitespace();
          if (ch != '=' || !str_eq2(pos + 1, '=', '=')) break;
          pos += 3;
          ch = commentWhitespace();
          if (ch != '"' && ch != '\'') break;
          quot = ch;
          if (!str_eq10(pos + 1, '_', '_', 'e', 's', 'M', 'o', 'd', 'u', 'l', 'e')) break;
          pos += 11;
          ch = commentWhitespace();
          if (ch != quot) break;
          pos += 1;
          ch = commentWhitespace();
          if (ch != ')') break;
          pos += 1;
          ch = commentWhitespace();
          if (ch != 'r' || !str_eq5(pos + 1, 'e', 't', 'u', 'r', 'n')) break;
          pos += 6;
          ch = commentWhitespace();
          if (ch == ';')
            pos++;
          ch = commentWhitespace();

          // `if (`
          if (ch == 'i' && *(pos + 1) == 'f') {
            bool inIf = true;
            pos += 2;
            ch = commentWhitespace();
            if (ch != '(') break;
            pos++;
            uint16_t *ifInnerPos = pos;

            // `Object.prototype.hasOwnProperty.call(`  IDENTIFIER `, ` IDENTIFIER$2 `)) return` `;`?
            if (tryParseObjectHasOwnProperty(it_id_start, it_id_len)) {
              ch = commentWhitespace();
              if (ch != ')') break;
              pos++;
              ch = commentWhitespace();
              if (ch != 'r' || !str_eq5(pos + 1, 'e', 't', 'u', 'r', 'n')) break;
              pos += 6;
              ch = commentWhitespace();
              if (ch == ';')
                pos++;
              ch = commentWhitespace();
              // match next if
              if (ch == 'i' && *(pos + 1) == 'f') {
                pos += 2;
                ch = commentWhitespace();
                if (ch != '(') break;
                pos++;
              }
              else {
                inIf = false;
              }
            }
            else {
              pos = ifInnerPos;
            }

            // `if (` IDENTIFIER$2 `in` EXPORTS_IDENTIFIER `&&` EXPORTS_IDENTIFIER `[` IDENTIFIER$2 `] ===` IDENTIFIER$1 `[` IDENTIFIER$2 `]) return` `;`?
            if (inIf) {
              if (memcmp(pos, it_id_start, it_id_len * sizeof(uint16_t)) != 0) break;
              pos += it_id_len;
              ch = commentWhitespace();
              if (ch != 'i' || !str_eq2(pos + 1, 'n', ' ')) break;
              pos += 3;
              ch = commentWhitespace();
              if (!readExportsOrModuleDotExports(ch)) break;
              ch = commentWhitespace();
              if (ch != '&' || *(pos + 1) != '&') break;
              pos += 2;
              ch = commentWhitespace();
              if (!readExportsOrModuleDotExports(ch)) break;
              ch = commentWhitespace();
              if (ch != '[') break;
              pos++;
              ch = commentWhitespace();
              if (memcmp(pos, it_id_start, it_id_len * sizeof(uint16_t)) != 0) break;
              pos += it_id_len;
              ch = commentWhitespace();
              if (ch != ']') break;
              pos++;
              ch = commentWhitespace();
              if (ch != '=' || !str_eq2(pos + 1, '=', '=')) break;
              pos += 3;
              ch = commentWhitespace();
              if (memcmp(pos, id_start, id_len * sizeof(uint16_t)) != 0) break;
              pos += id_len;
              ch = commentWhitespace();
              if (ch != '[') break;
              pos++;
              ch = commentWhitespace();
              if (memcmp(pos, it_id_start, it_id_len * sizeof(uint16_t)) != 0) break;
              pos += it_id_len;
              ch = commentWhitespace();
              if (ch != ']') break;
              pos++;
              ch = commentWhitespace();
              if (ch != ')') break;
              pos++;
              ch = commentWhitespace();
              if (ch != 'r' || !str_eq5(pos + 1, 'e', 't', 'u', 'r', 'n')) break;
              pos += 6;
              ch = commentWhitespace();
              if (ch == ';')
                pos++;
              ch = commentWhitespace();
            }
          }
        }
        // `if (` IDENTIFIER$2 `!==` ( `'default'` | `"default"` ) (`&& !` IDENTIFIER `.hasOwnProperty(` IDENTIFIER$2 `)`  )? `)`
        else if (ch == '!') {
          if (!str_eq2(pos + 1, '=', '=')) break;
          pos += 3;
          ch = commentWhitespace();
          if (ch != '"' && ch != '\'') break;
          uint16_t quot = ch;
          if (!str_eq7(pos + 1, 'd', 'e', 'f', 'a', 'u', 'l', 't')) break;
          pos += 8;
          ch = commentWhitespace();
          if (ch != quot) break;
          pos += 1;
          ch = commentWhitespace();
          if (ch == '&') {
            if (*(pos + 1) != '&') break;
            pos += 2;
            ch = commentWhitespace();
            if (ch != '!') break;
            pos += 1;
            ch = commentWhitespace();
            if (ch == 'O' && str_eq6(pos + 1, 'b', 'j', 'e', 'c', 't', '.')) {
              if (!tryParseObjectHasOwnProperty(it_id_start, it_id_len)) break;
            }
            else if (identifier(ch)) {
              ch = commentWhitespace();
              if (ch != '.') break;
              pos++;
              ch = commentWhitespace();
              if (ch != 'h' || !str_eq13(pos + 1, 'a', 's', 'O', 'w', 'n', 'P', 'r', 'o', 'p', 'e', 'r', 't', 'y')) break;
              pos += 14;
              ch = commentWhitespace();
              if (ch != '(') break;
              pos += 1;
              ch = commentWhitespace();
              if (memcmp(pos, it_id_start, it_id_len * sizeof(uint16_t)) != 0) break;
              pos += it_id_len;
              ch = commentWhitespace();
              if (ch != ')') break;
              pos += 1;
            }
            ch = commentWhitespace();
          }
          if (ch != ')') break;
          pos += 1;
          ch = commentWhitespace();
        }
        else break;

        // EXPORTS_IDENTIFIER `[` IDENTIFIER$2 `] =` IDENTIFIER$1 `[` IDENTIFIER$2 `]`
        if (readExportsOrModuleDotExports(ch)) {
          ch = commentWhitespace();
          if (ch != '[') break;
          pos++;
          ch = commentWhitespace();
          if (memcmp(pos, it_id_start, it_id_len * sizeof(uint16_t)) != 0) break;
          pos += it_id_len;
          ch = commentWhitespace();
          if (ch != ']') break;
          pos++;
          ch = commentWhitespace();
          if (ch != '=') break;
          pos++;
          ch = commentWhitespace();
          if (memcmp(pos, id_start, id_len * sizeof(uint16_t)) != 0) break;
          pos += id_len;
          ch = commentWhitespace();
          if (ch != '[') break;
          pos++;
          ch = commentWhitespace();
          if (memcmp(pos, it_id_start, it_id_len * sizeof(uint16_t)) != 0) break;
          pos += it_id_len;
          ch = commentWhitespace();
          if (ch != ']') break;
          pos++;
          ch = commentWhitespace();
          if (ch == ';') {
            pos++;
            ch = commentWhitespace();
          }
        }
        // `Object.defineProperty(` EXPORTS_IDENTIFIER `, ` IDENTIFIER$2 `, { enumerable: true, get: function () { return ` IDENTIFIER$1 `[` IDENTIFIER$2 `]; } })`
        else if (ch == 'O') {
          if (!str_eq5(pos + 1, 'b', 'j', 'e', 'c', 't')) break;
          pos += 6;
          ch = commentWhitespace();
          if (ch != '.') break;
          pos++;
          ch = commentWhitespace();
          if (ch != 'd' || !str_eq13(pos + 1, 'e', 'f', 'i', 'n', 'e', 'P', 'r', 'o', 'p', 'e', 'r', 't', 'y')) break;
          pos += 14;
          ch = commentWhitespace();
          if (ch != '(') break;
          pos++;
          ch = commentWhitespace();
          if (!readExportsOrModuleDotExports(ch)) break;
          ch = commentWhitespace();
          if (ch != ',') break;
          pos++;
          ch = commentWhitespace();
          if (memcmp(pos, it_id_start, it_id_len * sizeof(uint16_t)) != 0) break;
          pos += it_id_len;
          ch = commentWhitespace();
          if (ch != ',') break;
          pos++;
          ch = commentWhitespace();
          if (ch != '{') break;
          pos++;
          ch = commentWhitespace();
          if (ch != 'e' || !str_eq9(pos + 1, 'n', 'u', 'm', 'e', 'r', 'a', 'b', 'l', 'e')) break;
          pos += 10;
          ch = commentWhitespace();
          if (ch != ':') break;
          pos++;
          ch = commentWhitespace();
          if (ch == 't' && str_eq3(pos + 1, 'r', 'u', 'e')) {
            pos += 4;
          } else if (!tryParseMinifiedEnumerable(ch)) {
            break;
          }
          ch = commentWhitespace();
          if (ch != ',') break;
          pos++;
          ch = commentWhitespace();
          if (ch != 'g' || !str_eq2(pos + 1, 'e', 't')) break;
          pos += 3;
          ch = commentWhitespace();
          if (ch == ':') {
            pos++;
            ch = commentWhitespace();
            if (ch != 'f') break;
            if (!str_eq7(pos + 1, 'u', 'n', 'c', 't', 'i', 'o', 'n')) break;
            pos += 8;
            uint16_t* lastPos = pos;
            ch = commentWhitespace();
            if (ch != '(' && (lastPos == pos || !identifier(ch))) break;
            ch = commentWhitespace();
          }
          if (ch != '(') break;
          pos++;
          ch = commentWhitespace();
          if (ch != ')') break;
          pos++;
          ch = commentWhitespace();
          if (ch != '{') break;
          pos++;
          ch = commentWhitespace();
          if (ch != 'r' || !str_eq5(pos + 1, 'e', 't', 'u', 'r', 'n')) break;
          pos += 6;
          ch = commentWhitespace();
          if (memcmp(pos, id_start, id_len * sizeof(uint16_t)) != 0) break;
          pos += id_len;
          ch = commentWhitespace();
          if (ch != '[') break;
          pos++;
          ch = commentWhitespace();
          if (memcmp(pos, it_id_start, it_id_len * sizeof(uint16_t)) != 0) break;
          pos += it_id_len;
          ch = commentWhitespace();
          if (ch != ']') break;
          pos++;
          ch = commentWhitespace();
          if (ch == ';') {
            pos++;
            ch = commentWhitespace();
          }
          if (ch != '}') break;
          pos++;
          ch = commentWhitespace();
          if (ch == ',') {
            pos++;
            ch = commentWhitespace();
          }
          if (ch != '}') break;
          pos++;
          ch = commentWhitespace();
          if (ch != ')') break;
          pos++;
          ch = commentWhitespace();
          if (ch == ';') {
            pos++;
            ch = commentWhitespace();
          }
        }
        else break;

        if (ch != '}') break;
        pos++;
        ch = commentWhitespace();
        if (ch != ')') break;

        // search through export bindings to see if this is a star export
        // this is done last because it is a linear search through all require bindings
        // and by doing this search last after verifying the structure match,
        // we don't have to worry about the slow search algorithm
        bool projectingWebpack = extended && (webpackCurrent || webpackInline);
        StarExportBinding* binding = findStarExportBinding(id_start, id_len, projectingWebpack);
        if (binding) {
          bool internal = false;
          if (projectingWebpack) {
            trustWebpackExports(pos);
            WebpackModule* owner = webpackCurrent ? webpackCurrent : &webpackInlineRoot;
            for (Slice* slice = owner->imports; slice; slice = slice->next)
              if (slice->start == binding->specifier_start) { internal = true; break; }
          }
          if (internal)
            addWebpackDependency(binding->specifier_start, binding->specifier_end, true);
          else
            addReexport(binding->specifier_start, binding->specifier_end);
          pos = revertPos;
        }
        else if (projectingWebpack) markWebpackExportsUncertain();
        return;
      }
    }
  }
  pos = revertPos;
}

bool readExportsOrModuleDotExports (uint16_t ch) {
  uint16_t* revertPos = pos;
  if (extended) {
    if (webpackCurrent && matchesWebpackBinding(webpackCurrent->target, webpackCurrent->targetLength)) {
      pos += webpackCurrent->targetLength;
      return true;
    }
    if (!webpackCurrent && ch == '_' &&
        str_eq18(pos + 1, '_', 'w', 'e', 'b', 'p', 'a', 'c', 'k', '_', 'e', 'x', 'p', 'o', 'r', 't', 's', '_', '_') &&
        !isIdentifierChar(webpackCharAt(pos + 19))) { pos += 19; return true; }
  }
  bool moduleAlias = extended && webpackCurrent && matchesWebpackBinding(webpackCurrent->module, webpackCurrent->moduleLength);
  if (moduleAlias || ch == 'm' && str_eq5(pos + 1, 'o', 'd', 'u', 'l', 'e')) {
    pos += moduleAlias ? webpackCurrent->moduleLength : 6;
    ch = commentWhitespace();
    if (ch != '.') {
      pos = revertPos;
      return false;
    }
    pos++;
    ch = commentWhitespace();
  }
  if (ch == 'e' && str_eq6(pos + 1, 'x', 'p', 'o', 'r', 't', 's')) {
    pos += 7;
    return true;
  }
  else {
    pos = revertPos;
    return false;
  }
}

bool tryParseModuleExportsDotAssign (uint32_t length) {
  pos += length;
  uint16_t* revertPos = pos - 1;
  uint16_t ch = commentWhitespace();
  if (ch == '.') {
    pos++;
    ch = commentWhitespace();
    if (ch == 'e' && str_eq6(pos + 1, 'x', 'p', 'o', 'r', 't', 's')) {
      return tryParseExportsDotAssign(true, 7);
    }
  }
  pos = revertPos;
  return false;
}

bool tryParseExportsDotAssign (bool assign, uint32_t length) {
  pos += length;
  uint16_t* revertPos = pos - 1;
  uint16_t ch = commentWhitespace();
  switch (ch) {
    // exports.asdf
    case '.': {
      pos++;
      ch = commentWhitespace();
      uint16_t* startPos = pos;
      if (identifier(ch)) {
        uint16_t* endPos = pos;
        ch = commentWhitespace();
        if (ch == '=') {
          addExport(startPos, endPos);
          return true;
        }
      }
      break;
    }
    // exports['asdf']
    case '[': {
      pos++;
      ch = commentWhitespace();
      if (ch == '\'' || ch == '"') {
        uint16_t* startPos = pos;
        stringLiteral(ch);
        uint16_t* endPos = ++pos;
        ch = commentWhitespace();
        if (ch != ']') break;
        pos++;
        ch = commentWhitespace();
        if (ch != '=') break;
        addExport(startPos, endPos);
        pos = revertPos;
        return true;
      }
      break;
    }
    // module.exports =
    case '=': {
      if (assign) {
        if (!extended) clearReexports();
        pos++;
        ch = commentWhitespace();
        if (extended) {
          bool recognized = false;
          if (ch == '_') {
            uint16_t* start = pos;
            const uint16_t *id, *idEnd;
            if (webpackTablePos && readWebpackCall(&id, &idEnd, true)) {
              recognized = true;
              if (webpackCurrent) addWebpackDependency(id, idEnd, false);
              else { webpackEntryStart = id; webpackEntryEnd = idEnd; webpackPublished = true; }
            }
            pos = start;
            if (webpackTablePos && !webpackCurrent && matchesWebpackExports()) {
              pos += 19;
              if (readWebpackExpressionEnd()) {
                trustWebpackExports(pos);
                webpackPublished = true;
              } else webpackInvalid = true;
            }
          }
          if (ch == '(') ch = readExportExpressionStart();
          if (ch == '{') {
            exportObjectPos = pos;
            recognized = true;
          }
          else if (ch == 'r') recognized = tryParseRequire(ExportAssign);
          pos = revertPos;
          return recognized;
        }
        // { ... }
        if (ch == '{') {
          tryParseLiteralExports();
          return true;
        }

        // require('...')
        if (ch == 'r')
          tryParseRequire(ExportAssign);
      }
    }
  }
  pos = revertPos;
  return false;
}

bool tryParseRequire (enum RequireType requireType) {
  uint16_t* revertPos = pos;
  // require('...')
  if (str_eq6(pos + 1, 'e', 'q', 'u', 'i', 'r', 'e')) {
    pos += 7;
    uint16_t ch = commentWhitespace();
    if (ch == '(') {
      pos++;
      ch = commentWhitespace();
      uint16_t* reexportStart = pos;
      if (ch == '\'' || ch == '"') {
        stringLiteral(ch);
        uint16_t* reexportEnd = ++pos;
        ch = commentWhitespace();
        if (ch == ')') {
          switch (requireType) {
            case ExportStar:
              addReexport(reexportStart, reexportEnd);
              return true;
            case ExportAssign:
              addReexport(reexportStart, reexportEnd);
              return true;
            default:
              starExportBinding_.specifier_start = reexportStart;
              starExportBinding_.specifier_end = reexportEnd;
              return true;
          }
        }
      }
    }
    pos = revertPos;
  }
  return false;
}

static bool matchesKeyword (const char* keyword, uint32_t length) {
  if (pos > end || (uint32_t)(end - pos + 1) < length) return false;
  for (uint32_t i = 0; i < length; i++) {
    if (pos[i] != keyword[i]) return false;
  }
  return true;
}

static uint16_t readExportExpressionStart () {
  while (true) {
    pos++;
    uint16_t ch = commentWhitespace();
    if (ch == '(') continue;
    uint16_t* start = pos;
    if (ch == '\'' || ch == '"') {
      stringLiteral(ch);
      pos++;
    }
    else if (ch == '{') {
      pos++;
      if (commentWhitespace() == '}') pos++;
      else {
        pos = start;
        return ch;
      }
    }
    else {
      while (pos <= end && isIdentifierChar(fullCharCode(*pos)))
        pos += charCodeByteLen(fullCharCode(*pos));
    }
    if (pos == start || commentWhitespace() != ',') {
      pos = start;
      return ch;
    }
  }
}

void readExportDefinition () {
  bool property = matchesKeyword("defineProperty", 14);
  bool properties = matchesKeyword("defineProperties", 16);
  if (!property && !properties) return;
  pos += property ? 14 : 16;
  uint16_t ch = commentWhitespace();
  if (ch != '(') return;
  pos++;
  ch = commentWhitespace();
  if (!readExportsOrModuleDotExports(ch)) return;
  uint16_t* argEnd = pos;
  if (commentWhitespace() != ',') return;
  pos++;
  ch = commentWhitespace();
  if (properties) {
    if (ch == '(') ch = readExportExpressionStart();
    if (ch == '{') {
      exportObjectPos = pos;
      trustWebpackExports(argEnd);
    }
  }
  else if (ch == '\'' || ch == '"') {
    uint16_t* nameStart = pos;
    stringLiteral(ch);
    uint16_t* nameEnd = ++pos;
    if (commentWhitespace() == ',') {
      addExport(nameStart, nameEnd);
      trustWebpackExports(argEnd);
    }
  }
}

void readExportProperty () {
  uint16_t* revertPos = pos;
  pos++;
  uint16_t ch = commentWhitespace();
  uint16_t propertyStart = ch;
  if (ch == '.' && end - pos >= 2 && str_eq2(pos + 1, '.', '.')) {
    pos += 3;
    ch = commentWhitespace();
    if (!(ch == 'r' && tryParseRequire(ExportAssign))) markWebpackExportsUncertain();
    pos = revertPos;
    return;
  }
  if (ch == '*') {
    pos++;
    ch = commentWhitespace();
  }
  bool computed = ch == '[';
  if (computed) {
    pos++;
    ch = commentWhitespace();
  }
  uint16_t* nameStart = pos;
  uint16_t* nameEnd = 0;
  if (ch == '\'' || ch == '"') {
    stringLiteral(ch);
    nameEnd = ++pos;
  }
  else if (!computed && identifier(ch)) {
    nameEnd = pos;
    ch = commentWhitespace();
    if ((nameEnd - nameStart == 3 && (str_eq3(nameStart, 'g', 'e', 't') || str_eq3(nameStart, 's', 'e', 't')) ||
         nameEnd - nameStart == 5 && str_eq5(nameStart, 'a', 's', 'y', 'n', 'c')) &&
        ch != ':' && ch != '(' && ch != ',' && ch != '}') {
      if (ch == '*') {
        pos++;
        ch = commentWhitespace();
      }
      computed = ch == '[';
      if (computed) {
        pos++;
        ch = commentWhitespace();
      }
      nameStart = pos;
      if (ch == '\'' || ch == '"') {
        stringLiteral(ch);
        nameEnd = ++pos;
      }
      else if (!computed && identifier(ch)) nameEnd = pos;
      else nameEnd = 0;
    }
  }
  ch = commentWhitespace();
  if (computed) {
    if (ch != ']') nameEnd = 0;
    else {
      pos++;
      ch = commentWhitespace();
    }
  }
  if (nameEnd && (ch == ':' || ch == '(' || !computed && (ch == ',' || ch == '}')))
    addExport(nameStart, nameEnd);
  else if (propertyStart != '}')
    markWebpackExportsUncertain();
  pos = revertPos;
}

void tryParseLiteralExports () {
  uint16_t* revertPos = pos - 1;
  while (pos++ < end) {
    uint16_t ch = commentWhitespace();
    uint16_t* startPos = pos;
    if (identifier(ch)) {
      uint16_t* endPos = pos;
      ch = commentWhitespace();
      if (ch == ':') {
        pos++;
        ch = commentWhitespace();
        // nothing more complex than identifier expressions for now
        if (!identifier(ch) && *pos != '\\') {
          pos = revertPos;
          return;
        }
        ch = *pos;
      }
      else if (ch != ',' && ch != '}' && ch != '=' && ch != '(') {
        pos = revertPos;
        return;
      }
      addExport(startPos, endPos);
    }
    else if (ch == '\'' || ch == '"') {
      uint16_t* startPos = pos;
      stringLiteral(ch);
      uint16_t* endPos = ++pos;
      ch = commentWhitespace();
      if (ch == ':') {
        pos++;
        ch = commentWhitespace();
        // nothing more complex than identifier expressions for now
        if (!identifier(ch) && *pos != '\\') {
          pos = revertPos;
          return;
        }
        ch = *pos;
        addExport(startPos, endPos);
      }
    }
    else if (ch == '.' && str_eq2(pos + 1, '.', '.')) {
      pos += 3;
      if (*pos == 'r' && tryParseRequire(ExportAssign)) {
        pos++;
      }
      else if (!identifier(*pos)) {
        pos = revertPos;
        return;
      }
      ch = commentWhitespace();
    }
    else {
      pos = revertPos;
      return;
    }

    if (ch == '}')
      return;

    if (ch != ',') {
      pos = revertPos;
      return;
    }
  }
}

// Identifier detection, ported from Acorn
// ## Character categories

static bool isInBmpIdentifierSet (uint16_t code, const uint8_t* pageTable) {
  uint8_t block = bmpPages[pageTable[code >> 8]][(code >> 6) & 3];
  return (bmpMasks[block] >> (code & 63)) & 1;
}

// This has a complexity linear to the value of the code. The
// assumption is that looking up astral identifier characters is
// rare.
bool isInAstralIdentifierStartCodes (uint32_t code) {
  uint32_t cur = 0x10000;
  for (unsigned int i = 0; i < sizeof(astralIdentifierStartCodes) / sizeof(*astralIdentifierStartCodes); i += 2) {
    cur += astralIdentifierStartCodes[i];
    if (cur > code)
      return false;
    cur += astralIdentifierStartCodes[i + 1];
    if (cur >= code)
      return true;
  }
  return false;
}

bool isInAstralIdentifierCodes (uint32_t code) {
  uint32_t cur = 0x10000;
  for (unsigned int i = 0; i < sizeof(astralIdentifierCodes) / sizeof(*astralIdentifierCodes); i += 2) {
    cur += astralIdentifierCodes[i];
    if (cur > code)
      return false;
    cur += astralIdentifierCodes[i + 1];
    if (cur >= code)
      return true;
  }
  return false;
}

// Test whether a given character code starts an identifier.
bool isIdentifierStart(uint32_t code) {
  if (code < 65) return code == 36;
  if (code < 91) return true;
  if (code < 97) return code == 95;
  if (code < 123) return true;
  if (code <= 0xffff) return code >= 0xaa && isInBmpIdentifierSet((uint16_t)code, bmpStart);
  return isInAstralIdentifierStartCodes(code);
}

// Test whether a given character is part of an identifier.

bool isIdentifierChar(uint32_t code) {
  if (code < 48) return code == 36;
  if (code < 58) return true;
  if (code < 65) return false;
  if (code < 91) return true;
  if (code < 97) return code == 95;
  if (code < 123) return true;
  if (code <= 0xffff) return code >= 0xaa && isInBmpIdentifierSet((uint16_t)code, bmpContinue);
  return isInAstralIdentifierStartCodes(code) || isInAstralIdentifierCodes(code);
}

inline int charCodeByteLen(uint32_t ch) {
  if (ch < 0x10000) return 1;
  return 2;
}

uint32_t fullCharCodeAtLast(uint16_t* bPos) {
  // Gives the UTF char for backtracking surrogates
  uint16_t ch = *bPos;
  if ((ch & 0xFC00) == 0xDC00)
    return (((*(bPos - 1) & 0x3FF) << 10) | (ch & 0x3FF)) + 0x10000;
  return ch;
}

uint32_t fullCharCode(uint16_t ch) {
  // Read UTF Surrogates if necessary
  if ((ch & 0xFC00) == 0xD800)
    return (((ch & 0x3FF) << 10) | (*(pos + 1) & 0x3FF)) + 0x10000;
  return ch;
}

bool identifier (uint16_t startCh) {
  uint32_t ch = fullCharCode(startCh);
  if (!isIdentifierStart(ch))
    return false;
  pos += charCodeByteLen(ch);
  while (ch = fullCharCode(*pos)) {
    if (isIdentifierChar(ch)) {
      pos += charCodeByteLen(ch);
    }
    else if (ch == '\\') {
      // no identifier escapes support for now
      return false;
    }
    else {
      break;
    }
  }
  return true;
}

void throwIfImportStatement () {
  uint16_t* startPos = pos;
  pos += 6;
  uint16_t ch = commentWhitespace();
  switch (ch) {
    // dynamic import
    case '(':
      if (!pushOpenToken(startPos))
        return;
      return;
    // import.meta
    case '.':
      syntaxError(5);
      return;
    
    default:
      // no space after "import" -> not an import keyword
      if (pos == startPos + 6)
        break;
    case '"':
    case '\'':
    case '{':
    case '*':
      // import statement only permitted at base-level
      if (openTokenDepth != 0) {
        pos--;
        return;
      }
      // import statements are a syntax error in CommonJS
      syntaxError(6);
  }
}

void throwIfExportStatement () {
  pos += 6;
  uint16_t* curPos = pos;
  uint16_t ch = commentWhitespace();
  if (pos == curPos && !isPunctuator(ch))
    return;
  syntaxError(7);
}

uint16_t commentWhitespace () {
  uint16_t ch;
  do {
    ch = *pos;
    if (ch == '/') {
      uint16_t next_ch = *(pos + 1);
      if (next_ch == '/')
        lineComment();
      else if (next_ch == '*')
        blockComment();
      else
        return ch;
    }
    else if (!isBrOrWs(ch)) {
      return ch;
    }
  } while (pos++ < end);
  return ch;
}

void templateString () {
  while (pos++ < end) {
    uint16_t ch = *pos;
    if (ch == '$' && *(pos + 1) == '{') {
      pos++;
      if (!pushTemplate())
        return;
      return;
    }
    if (ch == '`')
      return;
    if (ch == '\\')
      pos++;
  }
  syntaxError(8);
}

void blockComment () {
  pos++;
  while (pos++ < end) {
    uint16_t ch = *pos;
    if (ch == '*' && *(pos + 1) == '/') {
      pos++;
      return;
    }
  }
}

void lineComment () {
  while (pos++ < end) {
    uint16_t ch = *pos;
    if (ch == '\n' || ch == '\r')
      return;
  }
}

void stringLiteral (uint16_t quote) {
  while (pos++ < end) {
    uint16_t ch = *pos;
    if (ch == quote)
      return;
    if (ch == '\\') {
      ch = *++pos;
      if (ch == '\r' && *(pos + 1) == '\n')
        pos++;
    }
    else if (isBr(ch))
      break;
  }
  syntaxError(9);
}

uint16_t regexCharacterClass () {
  while (pos++ < end) {
    uint16_t ch = *pos;
    if (ch == ']')
      return ch;
    if (ch == '\\')
      pos++;
    else if (ch == '\n' || ch == '\r')
      break;
  }
  syntaxError(10);
  return '\0';
}

void regularExpression () {
  while (pos++ < end) {
    uint16_t ch = *pos;
    if (ch == '/')
      return;
    if (ch == '[')
      ch = regexCharacterClass();
    else if (ch == '\\')
      pos++;
    else if (ch == '\n' || ch == '\r')
      break;
  }
  syntaxError(11);
}

uint16_t readToWsOrPunctuator (uint16_t ch) {
  do {
    if (isBrOrWs(ch) || isPunctuator(ch))
      return ch;
  } while (ch = *(++pos));
  return ch;
}

// Note: non-asii BR and whitespace checks omitted for perf / footprint
// if there is a significant user need this can be reconsidered
bool isBr (uint16_t c) {
  return c == '\r' || c == '\n';
}

bool isBrOrWs (uint16_t c) {
  return c > 8 && c < 14 || c == 32 || c == 160;
}

bool isBrOrWsOrPunctuatorNotDot (uint16_t c) {
  return c > 8 && c < 14 || c == 32 || c == 160 || isPunctuator(c) && c != '.';
}

bool str_eq2 (uint16_t* pos, uint16_t c1, uint16_t c2) {
  return *pos == c1 && *(pos + 1) == c2;
}

bool str_eq3 (uint16_t* pos, uint16_t c1, uint16_t c2, uint16_t c3) {
  return *pos == c1 && *(pos + 1) == c2 && *(pos + 2) == c3;
}

bool str_eq4 (uint16_t* pos, uint16_t c1, uint16_t c2, uint16_t c3, uint16_t c4) {
  return *pos == c1 && *(pos + 1) == c2 && *(pos + 2) == c3 && *(pos + 3) == c4;
}

bool str_eq5 (uint16_t* pos, uint16_t c1, uint16_t c2, uint16_t c3, uint16_t c4, uint16_t c5) {
  return *pos == c1 && *(pos + 1) == c2 && *(pos + 2) == c3 && *(pos + 3) == c4 && *(pos + 4) == c5;
}

bool str_eq6 (uint16_t* pos, uint16_t c1, uint16_t c2, uint16_t c3, uint16_t c4, uint16_t c5, uint16_t c6) {
  return *pos == c1 && *(pos + 1) == c2 && *(pos + 2) == c3 && *(pos + 3) == c4 && *(pos + 4) == c5 && *(pos + 5) == c6;
}

bool str_eq7 (uint16_t* pos, uint16_t c1, uint16_t c2, uint16_t c3, uint16_t c4, uint16_t c5, uint16_t c6, uint16_t c7) {
  return *pos == c1 && *(pos + 1) == c2 && *(pos + 2) == c3 && *(pos + 3) == c4 && *(pos + 4) == c5 && *(pos + 5) == c6 && *(pos + 6) == c7;
}

bool str_eq8 (uint16_t* pos, uint16_t c1, uint16_t c2, uint16_t c3, uint16_t c4, uint16_t c5, uint16_t c6, uint16_t c7, uint16_t c8) {
  return *pos == c1 && *(pos + 1) == c2 && *(pos + 2) == c3 && *(pos + 3) == c4 && *(pos + 4) == c5 && *(pos + 5) == c6 && *(pos + 6) == c7 && *(pos + 7) == c8;
}

bool str_eq9 (uint16_t* pos, uint16_t c1, uint16_t c2, uint16_t c3, uint16_t c4, uint16_t c5, uint16_t c6, uint16_t c7, uint16_t c8, uint16_t c9) {
  return *pos == c1 && *(pos + 1) == c2 && *(pos + 2) == c3 && *(pos + 3) == c4 && *(pos + 4) == c5 && *(pos + 5) == c6 && *(pos + 6) == c7 && *(pos + 7) == c8 && *(pos + 8) == c9;
}

bool str_eq10 (uint16_t* pos, uint16_t c1, uint16_t c2, uint16_t c3, uint16_t c4, uint16_t c5, uint16_t c6, uint16_t c7, uint16_t c8, uint16_t c9, uint16_t c10) {
  return *pos == c1 && *(pos + 1) == c2 && *(pos + 2) == c3 && *(pos + 3) == c4 && *(pos + 4) == c5 && *(pos + 5) == c6 && *(pos + 6) == c7 && *(pos + 7) == c8 && *(pos + 8) == c9 && *(pos + 9) == c10;
}

bool str_eq13 (uint16_t* pos, uint16_t c1, uint16_t c2, uint16_t c3, uint16_t c4, uint16_t c5, uint16_t c6, uint16_t c7, uint16_t c8, uint16_t c9, uint16_t c10, uint16_t c11, uint16_t c12, uint16_t c13) {
  return *pos == c1 && *(pos + 1) == c2 && *(pos + 2) == c3 && *(pos + 3) == c4 && *(pos + 4) == c5 && *(pos + 5) == c6 && *(pos + 6) == c7 && *(pos + 7) == c8 && *(pos + 8) == c9 && *(pos + 9) == c10 && *(pos + 10) == c11 && *(pos + 11) == c12 && *(pos + 12) == c13;
}

bool str_eq18 (uint16_t* pos, uint16_t c1, uint16_t c2, uint16_t c3, uint16_t c4, uint16_t c5, uint16_t c6, uint16_t c7, uint16_t c8, uint16_t c9, uint16_t c10, uint16_t c11, uint16_t c12, uint16_t c13, uint16_t c14, uint16_t c15, uint16_t c16, uint16_t c17, uint16_t c18) {
  return *pos == c1 && *(pos + 1) == c2 && *(pos + 2) == c3 && *(pos + 3) == c4 && *(pos + 4) == c5 && *(pos + 5) == c6 && *(pos + 6) == c7 && *(pos + 7) == c8 && *(pos + 8) == c9 && *(pos + 9) == c10 && *(pos + 10) == c11 && *(pos + 11) == c12 && *(pos + 12) == c13 && *(pos + 13) == c14 && *(pos + 14) == c15 && *(pos + 15) == c16 && *(pos + 16) == c17 && *(pos + 17) == c18;
}

bool str_eq22 (uint16_t* pos, uint16_t c1, uint16_t c2, uint16_t c3, uint16_t c4, uint16_t c5, uint16_t c6, uint16_t c7, uint16_t c8, uint16_t c9, uint16_t c10, uint16_t c11, uint16_t c12, uint16_t c13, uint16_t c14, uint16_t c15, uint16_t c16, uint16_t c17, uint16_t c18, uint16_t c19, uint16_t c20, uint16_t c21, uint16_t c22) {
  return *pos == c1 && *(pos + 1) == c2 && *(pos + 2) == c3 && *(pos + 3) == c4 && *(pos + 4) == c5 && *(pos + 5) == c6 && *(pos + 6) == c7 && *(pos + 7) == c8 && *(pos + 8) == c9 && *(pos + 9) == c10 && *(pos + 10) == c11 && *(pos + 11) == c12 && *(pos + 12) == c13 && *(pos + 13) == c14 && *(pos + 14) == c15 && *(pos + 15) == c16 && *(pos + 16) == c17 && *(pos + 17) == c18 && *(pos + 18) == c19 && *(pos + 19) == c20 && *(pos + 20) == c21 && *(pos + 21) == c22;
}

bool keywordStart (uint16_t* pos) {
  return pos == source || isBrOrWsOrPunctuatorNotDot(*(pos - 1));
}

bool readPrecedingKeyword1 (uint16_t* pos, uint16_t c1) {
  if (pos < source) return false;
  return *pos == c1 && (pos == source || isBrOrWsOrPunctuatorNotDot(*(pos - 1)));
}
bool readPrecedingKeyword2 (uint16_t* pos, uint16_t c1, uint16_t c2) {
  if (pos - 1 < source) return false;
  return str_eq2(pos - 1, c1, c2) && (pos - 1 == source || isBrOrWsOrPunctuatorNotDot(*(pos - 2)));
}
bool readPrecedingKeyword3 (uint16_t* pos, uint16_t c1, uint16_t c2, uint16_t c3) {
  if (pos - 2 < source) return false;
  return str_eq3(pos - 2, c1, c2, c3) && (pos - 2 == source || isBrOrWsOrPunctuatorNotDot(*(pos - 3)));
}
bool readPrecedingKeyword4 (uint16_t* pos, uint16_t c1, uint16_t c2, uint16_t c3, uint16_t c4) {
  if (pos - 3 < source) return false;
  return str_eq4(pos - 3, c1, c2, c3, c4) && (pos - 3 == source || isBrOrWsOrPunctuatorNotDot(*(pos - 4)));
}
bool readPrecedingKeyword5 (uint16_t* pos, uint16_t c1, uint16_t c2, uint16_t c3, uint16_t c4, uint16_t c5) {
  if (pos - 4 < source) return false;
  return str_eq5(pos - 4, c1, c2, c3, c4, c5) && (pos - 4 == source || isBrOrWsOrPunctuatorNotDot(*(pos - 5)));
}
bool readPrecedingKeyword6 (uint16_t* pos, uint16_t c1, uint16_t c2, uint16_t c3, uint16_t c4, uint16_t c5, uint16_t c6) {
  if (pos - 5 < source) return false;
  return str_eq6(pos - 5, c1, c2, c3, c4, c5, c6) && (pos - 5 == source || isBrOrWsOrPunctuatorNotDot(*(pos - 6)));
}
bool readPrecedingKeyword7 (uint16_t* pos, uint16_t c1, uint16_t c2, uint16_t c3, uint16_t c4, uint16_t c5, uint16_t c6, uint16_t c7) {
  if (pos - 6 < source) return false;
  return str_eq7(pos - 6, c1, c2, c3, c4, c5, c6, c7) && (pos - 6 == source || isBrOrWsOrPunctuatorNotDot(*(pos - 7)));
}

// Detects one of case, debugger, delete, do, else, in, instanceof, new,
//   return, throw, typeof, void, yield ,await
bool isExpressionKeyword (uint16_t* pos) {
  switch (*pos) {
    case 'd':
      switch (*(pos - 1)) {
        case 'i':
          // void
          return readPrecedingKeyword2(pos - 2, 'v', 'o');
        case 'l':
          // yield
          return readPrecedingKeyword3(pos - 2, 'y', 'i', 'e');
        default:
          return false;
      }
    case 'e':
      switch (*(pos - 1)) {
        case 's':
          switch (*(pos - 2)) {
            case 'l':
              // else
              return readPrecedingKeyword1(pos - 3, 'e');
            case 'a':
              // case
              return readPrecedingKeyword1(pos - 3, 'c');
            default:
              return false;
          }
        case 't':
          // delete
          return readPrecedingKeyword4(pos - 2, 'd', 'e', 'l', 'e');
        default:
          return false;
      }
    case 'f':
      if (*(pos - 1) != 'o' || *(pos - 2) != 'e')
        return false;
      switch (*(pos - 3)) {
        case 'c':
          // instanceof
          return readPrecedingKeyword6(pos - 4, 'i', 'n', 's', 't', 'a', 'n');
        case 'p':
          // typeof
          return readPrecedingKeyword2(pos - 4, 't', 'y');
        default:
          return false;
      }
    case 'n':
      // in, return
      return readPrecedingKeyword1(pos - 1, 'i') || readPrecedingKeyword5(pos - 1, 'r', 'e', 't', 'u', 'r');
    case 'o':
      // do
      return readPrecedingKeyword1(pos - 1, 'd');
    case 'r':
      // debugger
      return readPrecedingKeyword7(pos - 1, 'd', 'e', 'b', 'u', 'g', 'g', 'e');
    case 't':
      // await
      return readPrecedingKeyword4(pos - 1, 'a', 'w', 'a', 'i');
    case 'w':
      switch (*(pos - 1)) {
        case 'e':
          // new
          return readPrecedingKeyword1(pos - 2, 'n');
        case 'o':
          // throw
          return readPrecedingKeyword3(pos - 2, 't', 'h', 'r');
        default:
          return false; 
      }
  }
  return false;
}

bool isParenKeyword (uint16_t* curPos) {
  return readPrecedingKeyword5(curPos, 'w', 'h', 'i', 'l', 'e') ||
      readPrecedingKeyword3(curPos, 'f', 'o', 'r') ||
      readPrecedingKeyword2(curPos, 'i', 'f');
}

bool isPunctuator (uint16_t ch) {
  // 23 possible punctuator endings: !%&()*+,-./:;<=>?[]^{}|~
  return ch == '!' || ch == '%' || ch == '&' ||
    ch > 39 && ch < 48 || ch > 57 && ch < 64 ||
    ch == '[' || ch == ']' || ch == '^' ||
    ch > 122 && ch < 127;
}

bool isExpressionPunctuator (uint16_t ch) {
  // 20 possible expression endings: !%&(*+,-.:;<=>?[^{|~
  return ch == '!' || ch == '%' || ch == '&' ||
    ch > 39 && ch < 47 && ch != 41 || ch > 57 && ch < 64 ||
    ch == '[' || ch == '^' || ch > 122 && ch < 127 && ch != '}';
}

static uint16_t* precedingToken (uint16_t* curPos) {
  while (curPos) {
    while (isBrOrWs(*curPos)) {
      if (curPos == source) return NULL;
      curPos--;
    }
    if (*curPos != '/' || curPos == source || *(curPos - 1) != '*')
      return curPos;
    if (curPos == source + 1) return NULL;
    curPos -= 2;
    while (curPos > source && !(*curPos == '*' && *(curPos - 1) == '/')) curPos--;
    if (curPos <= source + 1) return NULL;
    curPos -= 2;
  }
  return NULL;
}

static bool isStatementBrace (uint16_t* curPos, uint16_t depth) {
  while (curPos && curPos != EMPTY_CHAR) {
    uint16_t ch = *curPos;
    if (ch == '{' && depth) {
      curPos = openTokenPosStack[--depth];
      continue;
    }
    if (ch != ':')
      return ch == '}' || isExpressionTerminator(curPos);
    if (curPos == source) return false;
    curPos = precedingToken(curPos - 1);
    if (!curPos) return false;
    uint16_t* start = curPos;
    bool identifierStart = false;
    uint16_t quote = *start;
    if (quote == '\'' || quote == '"') {
      while (start > source) {
        start--;
        if (*start != quote) continue;
        uint16_t* before = start;
        while (before > source && *(before - 1) == '\\') before--;
        if ((start - before) % 2 == 0) break;
      }
      if (start == source) return false;
      start--;
    }
    else {
      while (start >= source && isIdentifierChar(fullCharCodeAtLast(start))) {
        uint32_t codePoint = fullCharCodeAtLast(start);
        identifierStart = isIdentifierStart(codePoint);
        uint32_t length = charCodeByteLen(codePoint);
        if ((size_t)(start - source) < length) return identifierStart;
        start -= length;
      }
    }
    curPos = precedingToken(start);
    if (curPos && (*curPos == '+' || *curPos == '-'))
      curPos = curPos == source ? NULL : precedingToken(curPos - 1);
    if (curPos && curPos - source >= 3 && str_eq4(curPos - 3, 'c', 'a', 's', 'e') &&
        (curPos == source + 3 || !isIdentifierChar(fullCharCodeAtLast(curPos - 4)) && *(curPos - 4) != '.'))
      return true;
    if (!identifierStart)
      return false;
  }
  return true;
}

bool isExpressionTerminator (uint16_t* curPos) {
  // detects:
  // > ; ) -1 finally catch
  // as all of these followed by a { will indicate a statement brace
  switch (*curPos) {
    case '>':
      return *(curPos - 1) == '=';
    case ';':
    case ')':
      return true;
    case 'h':
      return readPrecedingKeyword4(curPos - 1, 'c', 'a', 't', 'c');
    case 'y':
      return readPrecedingKeyword6(curPos - 1, 'f', 'i', 'n', 'a', 'l', 'l');
    case 'e':
      return readPrecedingKeyword3(curPos - 1, 'e', 'l', 's');
  }
  return false;
}

void bail (uint32_t err) {
  error = 1;
  parse_error = err;
  pos = end + 1;
}

void syntaxError (uint32_t code) {
  if (error == 0) error = code;
  parse_error = pos - source;
  pos = end + 1;
}
