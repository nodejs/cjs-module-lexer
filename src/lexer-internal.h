#ifndef CJS_LEXER_INTERNAL_H
#define CJS_LEXER_INTERNAL_H

#include "cjs-module-lexer.h"
#include <stdbool.h>
#include <limits.h>
#include <stdlib.h>
#include <string.h>

#define STACK_DEPTH 2048
#ifdef CJS_LEXER_WASM
#define CJS_INLINE inline __attribute__((always_inline))
#else
#define CJS_INLINE inline
#endif

#ifdef CJS_LEXER_WASM
typedef const uint16_t* Cursor;
#define SOURCE_START parser->input
#else
typedef ptrdiff_t Cursor;
#define SOURCE_START ((Cursor)0)
#endif
#define SOURCE_BEFORE (SOURCE_START - 1)

typedef struct StarExportBinding {
  Cursor specifier_start;
  Cursor specifier_end;
  Cursor id_start;
  Cursor id_end;
  struct StarExportBinding* next;
} StarExportBinding;

#ifdef CJS_LEXER_WASM
typedef struct Slice {
  Cursor start;
  Cursor end;
  struct Slice* next;
} Slice;

typedef struct {
  Slice* first;
  Slice* last;
  Slice* read;
} Candidates;

struct cjs_lexer_result {
  Candidates exports;
  Candidates reexports;
  Candidates unsafe_getters;
};

#else
typedef union {
  uint16_t code;
  StarExportBinding binding;
} ArenaValue;

typedef struct ArenaBlock {
  struct ArenaBlock* next;
  size_t used;
  size_t capacity;
  ArenaValue data[];
} ArenaBlock;

typedef struct {
  Cursor start;
  Cursor end;
  cjs_lexer_string16 value;
  uint32_t hash;
} Candidate;

typedef struct {
  Candidate* data;
  size_t count;
  size_t capacity;
} Candidates;

struct cjs_lexer_result {
  Candidates exports;
  Candidates reexports;
  Candidates unsafe_getters;
  ArenaBlock* blocks;
};

#endif

typedef struct {
  const uint16_t* input;
  size_t sourceLen;
  Cursor pos;
  Cursor end;
  Cursor lastTokenPos;
  Cursor exportObjectPos;
  uint16_t templateStackDepth;
  uint16_t openTokenDepth;
  uint16_t templateDepth;
  bool lastSlashWasDivision;
  bool nextBraceIsClass;
  bool allowMinifiedEnumerable;
  bool extended;
  uint32_t error;
  size_t parse_error;
  uint16_t templateStack[STACK_DEPTH];
  Cursor openTokenPosStack[STACK_DEPTH];
  uint8_t openTokenTypeStack[STACK_DEPTH];
  StarExportBinding starExportBinding_;
  StarExportBinding* firstStarExport;
  StarExportBinding* lastStarExport;
  cjs_lexer_result* result;
} Parser;

#ifdef CJS_LEXER_WASM
#define scanInput(input, cursor) (*(cursor))
#else
#define scanInput(input, cursor) ((input)[cursor])
#endif

enum RequireType { Import, ExportAssign, ExportStar };

static inline ptrdiff_t sourceIndex(const Parser* parser, Cursor cursor) {
#ifdef CJS_LEXER_WASM
  return cursor - parser->input;
#else
  (void)parser;
  return cursor;
#endif
}

static inline uint16_t at(const Parser* parser, Cursor cursor) {
#ifdef CJS_LEXER_WASM
  return *cursor;
#else
  return (size_t)cursor < parser->sourceLen ? parser->input[cursor] : 0;
#endif
}

static inline bool hasChars(const Parser* parser, Cursor cursor, size_t length) {
#ifdef CJS_LEXER_WASM
  return true;
#else
  return cursor >= 0 && (size_t)cursor <= parser->sourceLen &&
    length <= parser->sourceLen - (size_t)cursor;
#endif
}

#ifdef CJS_LEXER_WASM
__attribute__((noinline))
#endif

static inline bool matches(const Parser* parser, Cursor left, Cursor right, size_t length) {
#ifdef CJS_LEXER_WASM
  if (left > parser->end + 1 || length > (size_t)(parser->end + 1 - left)) return false;
  return memcmp(left, right, length * sizeof(uint16_t)) == 0;
#else
  ptrdiff_t leftIndex = sourceIndex(parser, left);
  ptrdiff_t rightIndex = sourceIndex(parser, right);
  return leftIndex >= 0 && rightIndex >= 0 && (size_t)leftIndex <= parser->sourceLen &&
    (size_t)rightIndex <= parser->sourceLen && length <= parser->sourceLen - (size_t)leftIndex &&
    length <= parser->sourceLen - (size_t)rightIndex &&
    memcmp(parser->input + leftIndex, parser->input + rightIndex, length * sizeof(uint16_t)) == 0;
#endif
}

#ifdef CJS_LEXER_WASM
__attribute__((noinline))
#endif
static inline void clearCandidates(Candidates* list) {
#ifdef CJS_LEXER_WASM
  list->first = NULL;
  list->last = NULL;
  list->read = NULL;
#else
  list->count = 0;
#endif
}

void* cjs_lexer_allocate(cjs_lexer_result* result, size_t size);
void cjs_lexer_add(Parser* parser, Candidates* list, Cursor start, Cursor end);
uint32_t cjs_lexer_scan(Parser* parser);

#endif
