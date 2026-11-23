#ifndef CJS_LEXER_INTERNAL_H
#define CJS_LEXER_INTERNAL_H

#include "cjs-module-lexer.h"
#include <stdbool.h>
#include <limits.h>
#include <stdlib.h>
#include <string.h>

#define STACK_DEPTH 2048
#define CJS_LEXER_ERROR_ALLOCATION 13

#ifdef CJS_LEXER_WASM
#define CJS_INLINE inline __attribute__((always_inline))
#else
#define CJS_INLINE inline
#endif

#ifdef CJS_LEXER_WASM
typedef const uint16_t* Cursor;
#define SOURCE_START parser->input
#define scanInput(input, cursor) (*(cursor))
#else
typedef ptrdiff_t Cursor;
#define SOURCE_START ((Cursor)0)
#define scanInput(input, cursor) ((input)[cursor])
#endif
#define SOURCE_BEFORE (SOURCE_START - 1)

typedef enum {
  ExportCandidate,
  ReexportCandidate,
  UnsafeGetterCandidate,
  CandidateKindCount
} CandidateKind;

typedef struct StarExportBinding {
  Cursor specifier_start;
  Cursor specifier_end;
  Cursor id_start;
  Cursor id_end;
  struct StarExportBinding* next;
} StarExportBinding;

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
  return (size_t)cursor <= parser->sourceLen &&
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
  return hasChars(parser, left, length) && hasChars(parser, right, length) &&
    memcmp(parser->input + left, parser->input + right, length * sizeof(uint16_t)) == 0;
#endif
}

void* cjs_lexer_allocate(cjs_lexer_result* result, size_t size);
void cjs_lexer_add(Parser* parser, CandidateKind kind, Cursor start, Cursor end);
void cjs_lexer_clear_reexports(cjs_lexer_result* result);
uint32_t cjs_lexer_scan(Parser* parser);

#endif
