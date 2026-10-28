#ifndef CJS_MODULE_LEXER_H
#define CJS_MODULE_LEXER_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct cjs_lexer_result cjs_lexer_result;

typedef struct {
  const uint16_t* data;
  size_t length;
} cjs_lexer_string16;

typedef struct {
  uint32_t code;
  uint32_t has_offset;
  size_t offset;
} cjs_lexer_error;

#define CJS_LEXER_OK UINT32_C(0)
#define CJS_LEXER_INVALID_ARGUMENT UINT32_C(1)
#define CJS_LEXER_SYNTAX_ERROR UINT32_C(2)
#define CJS_LEXER_LIMIT UINT32_C(3)
#define CJS_LEXER_OUT_OF_MEMORY UINT32_C(4)

#define CJS_LEXER_ALLOW_MINIFIED_ENUMERABLE UINT32_C(1)
#define CJS_LEXER_EXTENDED UINT32_C(2)

/* Source is borrowed, in UTF-16 code units, without padding or a terminator.
 * Keep it unchanged until result_free. Null source is valid only with length 0.
 * Output locations must not alias source or each other. On failure *result is
 * null and error, when supplied, describes this call only. */
uint32_t cjs_lexer_parse_utf16(const uint16_t* source, size_t length,
                             uint32_t flags, cjs_lexer_result** result,
                             cjs_lexer_error* error);

/* Views require a live result and index below the corresponding count.
 * Candidates are decoded and filtered, in source order, with duplicates.
 * Views remain valid until result_free, including across independent parses. */
size_t cjs_lexer_export_count(const cjs_lexer_result* result);
size_t cjs_lexer_reexport_count(const cjs_lexer_result* result);
cjs_lexer_string16 cjs_lexer_export(const cjs_lexer_result* result, size_t index);
cjs_lexer_string16 cjs_lexer_reexport(const cjs_lexer_result* result, size_t index);
void cjs_lexer_result_free(cjs_lexer_result* result);

#ifdef __cplusplus
}
#endif
#endif
