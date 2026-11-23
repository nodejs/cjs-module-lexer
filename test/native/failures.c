#include "cjs-module-lexer.h"
#include <assert.h>
#include <stdlib.h>
#include <string.h>

static size_t calls;
static size_t fail_at;
static size_t live;

void* cjs_test_malloc(size_t size) {
  if (++calls == fail_at) return NULL;
  void* result = malloc(size);
  if (result) live++;
  return result;
}

void* cjs_test_realloc(void* pointer, size_t size) {
  if (++calls == fail_at) return NULL;
  int fresh = pointer == NULL;
  void* result = realloc(pointer, size);
  if (result && fresh) live++;
  return result;
}

void cjs_test_free(void* pointer) {
  if (pointer) live--;
  free(pointer);
}

int main(void) {
  const char* pattern = "var dep=require('dep');exports['a\\u0062']=1;"
    "Object.defineProperty(exports,'ab',{get(){return effect()}});__exportStar(require('side'));";
  size_t length = strlen(pattern) * 256;
  uint16_t* source = malloc(length * sizeof(uint16_t));
  assert(source);
  for (size_t index = 0; index < length; index++) source[index] = (unsigned char)pattern[index % strlen(pattern)];
  size_t allocations = 0;
  for (size_t failure = 0; failure <= allocations + 1; failure++) {
    calls = 0;
    fail_at = failure;
    cjs_lexer_result* result;
    cjs_lexer_error error;
    uint32_t status = cjs_lexer_parse_utf16(source, length, 0, &result, &error);
    if (!failure) allocations = calls;
    if (failure && failure <= allocations) {
      assert(status == CJS_LEXER_OUT_OF_MEMORY);
      assert(!result);
      assert(!error.code && !error.has_offset && !error.offset);
    } else {
      assert(status == CJS_LEXER_OK);
      assert(cjs_lexer_export_count(result) == 0);
      assert(cjs_lexer_reexport_count(result) == 256);
      cjs_lexer_result_free(result);
    }
    assert(!live);
    fail_at = 0;
    assert(cjs_lexer_parse_utf16(source, length, 0, &result, NULL) == CJS_LEXER_OK);
    cjs_lexer_result_free(result);
    assert(!live);
  }
  free(source);
  return 0;
}
