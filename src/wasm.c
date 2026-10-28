#define CJS_LEXER_WASM
#include "lexer-internal.h"

extern unsigned char __heap_base;
static Parser parser;
static cjs_lexer_result result;
static uint64_t analysis_head;
static uint64_t analysis_limit;

static __attribute__((noinline)) void growAnalysis(uint64_t required) {
  uint32_t pages = (required - analysis_limit + 65535) >> 16;
  if (__builtin_wasm_memory_grow(0, pages) == (size_t)-1) __builtin_trap();
  analysis_limit += (uint64_t)pages << 16;
}

void* cjs_lexer_allocate(cjs_lexer_result* unused, size_t size) {
  uint64_t required = analysis_head + size;
  if (required > analysis_limit) growAnalysis(required);
  void* allocation = (void*)(uintptr_t)analysis_head;
  analysis_head = required;
  return allocation;
}

__attribute__((noinline)) void cjs_lexer_add(Parser* parser, Candidates* list, Cursor start, Cursor end) {
  Slice* slice = cjs_lexer_allocate(parser->result, sizeof(Slice));
  slice->start = start;
  slice->end = end;
  slice->next = NULL;
  if (list->last) list->last->next = slice;
  else list->first = slice;
  list->last = slice;
}

uint16_t* sa(uint32_t length) {
  if (length > (size_t)PTRDIFF_MAX - 32) __builtin_trap();
  uint16_t* source = (uint16_t*)(void*)&__heap_base + 32;
  source[length] = 0;
  analysis_head = ((uintptr_t)(source + length + 1) + _Alignof(Slice) - 1) &
    ~((uintptr_t)_Alignof(Slice) - 1);
  analysis_limit = (uint64_t)__builtin_wasm_memory_size(0) << 16;
  clearCandidates(&result.exports);
  clearCandidates(&result.reexports);
  clearCandidates(&result.unsafe_getters);
  return source;
}

uint32_t parseCJSWithOptions(uint16_t* source, uint32_t length, uint32_t unused1,
                             uint32_t unused2, uint32_t unused3, uint32_t unused4,
                             uint32_t flags) {
  parser.input = source;
  parser.sourceLen = length;
  parser.pos = source - 1;
  parser.end = source + length - 1;
  parser.lastTokenPos = source - 1;
  parser.exportObjectPos = source - 1;
  parser.templateStackDepth = 0;
  parser.openTokenDepth = 0;
  parser.templateDepth = UINT16_MAX;
  parser.lastSlashWasDivision = false;
  parser.nextBraceIsClass = false;
  parser.allowMinifiedEnumerable = (flags & CJS_LEXER_ALLOW_MINIFIED_ENUMERABLE) != 0;
  parser.extended = (flags & CJS_LEXER_EXTENDED) != 0;
  parser.error = 0;
  parser.parse_error = 0;
  parser.firstStarExport = NULL;
  parser.lastStarExport = NULL;
  parser.result = &result;
  return cjs_lexer_scan(&parser);
}

uint32_t parseCJS(uint16_t* source, uint32_t length, uint32_t unused1,
                  uint32_t unused2, uint32_t unused3, uint32_t unused4) {
  return parseCJSWithOptions(source, length, 0, 0, 0, 0, 0);
}

uint32_t e(void) { return parser.parse_error; }
uint32_t es(void) { return result.exports.read->start - parser.input; }
uint32_t ee(void) { return result.exports.read->end - parser.input; }
uint32_t res(void) { return result.reexports.read->start - parser.input; }
uint32_t ree(void) { return result.reexports.read->end - parser.input; }
uint32_t us(void) { return result.unsafe_getters.read->start - parser.input; }
uint32_t ue(void) { return result.unsafe_getters.read->end - parser.input; }

static bool readCandidate(Candidates* list) {
  list->read = list->read ? list->read->next : list->first;
  return list->read != NULL;
}

bool re(void) { return readCandidate(&result.exports); }
bool rre(void) { return readCandidate(&result.reexports); }
bool ru(void) { return readCandidate(&result.unsafe_getters); }

#include "lexer.c"
