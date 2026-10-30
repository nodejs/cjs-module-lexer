#include "cjs-module-lexer.h"
#include <assert.h>
#include <stdlib.h>
#include <string.h>

static uint16_t* copy(const char* source, size_t length) {
  uint16_t* data = malloc(length * sizeof(uint16_t));
  assert(data || !length);
  for (size_t index = 0; index < length; index++) data[index] = (unsigned char)source[index];
  return data;
}

static void name(cjs_lexer_string16 value, const char* expected) {
  assert(value.length == strlen(expected));
  for (size_t index = 0; index < value.length; index++) assert(value.data[index] == (unsigned char)expected[index]);
}

int main(void) {
  cjs_lexer_result* result = NULL;
  cjs_lexer_error error = {99, 99, 99};
  assert(cjs_lexer_parse_utf16(NULL, 0, 0, &result, &error) == CJS_LEXER_OK);
  assert(cjs_lexer_export_count(result) == 0);
  assert(!error.code && !error.has_offset && !error.offset);
  cjs_lexer_result_free(result);
  assert(cjs_lexer_parse_utf16(NULL, 1, 0, &result, &error) == CJS_LEXER_INVALID_ARGUMENT);
  assert(!result && !error.has_offset);
  assert(cjs_lexer_parse_utf16(NULL, 0, 4, &result, &error) == CJS_LEXER_INVALID_ARGUMENT);
  assert(!result);
  assert(cjs_lexer_parse_utf16(NULL, 0, 0, NULL, &error) == CJS_LEXER_INVALID_ARGUMENT);
  uint16_t unit = 0;
  assert(cjs_lexer_parse_utf16(&unit, SIZE_MAX, 0, &result, &error) == CJS_LEXER_LIMIT);
  assert(!result && !error.has_offset);
  const char* divisions[] = {
    "module.exports={a}/1;exports.b=2;",
    "class A{};module.exports={a}/1;exports.b=2;",
    "if(x){};require('x')/1;exports.b=2;",
    "if(x){};Object.defineProperty(exports,'a',{value:1})/1;exports.b=2;"
  };
  for (size_t index = 0; index < sizeof(divisions) / sizeof(*divisions); index++) {
    size_t count = strlen(divisions[index]);
    uint16_t* division = copy(divisions[index], count);
    assert(cjs_lexer_parse_utf16(division, count, 0, &result, &error) == CJS_LEXER_OK);
    name(cjs_lexer_export(result, cjs_lexer_export_count(result) - 1), "b");
    cjs_lexer_result_free(result);
    free(division);
  }
  const char* text = "exports.a=1;exports['\\u0061']=2;exports.b=3;"
    "Object.defineProperty(exports,'b',{get(){return effect()}});"
    "__exportStar(require('first'));module.exports=require('last');";
  size_t length = strlen(text);
  uint16_t* source = copy(text, length);
  assert(cjs_lexer_parse_utf16(source, length, 0, &result, &error) == CJS_LEXER_OK);
  assert(cjs_lexer_export_count(result) == 2);
  name(cjs_lexer_export(result, 0), "a");
  name(cjs_lexer_export(result, 1), "a");
  assert(cjs_lexer_reexport_count(result) == 1);
  name(cjs_lexer_reexport(result, 0), "last");
  cjs_lexer_result* other;
  assert(cjs_lexer_parse_utf16(source, length, CJS_LEXER_EXTENDED, &other, NULL) == CJS_LEXER_OK);
  assert(cjs_lexer_export_count(other) == 4);
  assert(cjs_lexer_reexport_count(other) == 2);
  cjs_lexer_result_free(other);
  name(cjs_lexer_export(result, 1), "a");
  cjs_lexer_result_free(result);
  // Every prefix uses an exact allocation, including truncated lookahead and escapes.
  for (size_t count = 0; count <= length; count++) {
    uint16_t* prefix = copy(text, count);
    uint32_t status = cjs_lexer_parse_utf16(prefix, count, 0, &result, &error);
    assert(status == CJS_LEXER_OK || status == CJS_LEXER_SYNTAX_ERROR);
    assert(!error.has_offset || error.offset <= count);
    cjs_lexer_result_free(result);
    free(prefix);
  }
  free(source);
  const char* scans[] = {
    "const value=`a\\`b${1}c`;exports.after=1;",
    "/* a* * / **/exports.after=1;",
    "// a\\\r\nexports.after=1;",
    "const value=/a\\/[b\\]c]*/;exports.after=1;",
    "module.exports=(first,second,{});exports.after=1;",
    "Object.defineProperty(exports,'item',{value:1});exports.after=1;",
    "Object.defineProperties(exports,{item:{value:1}});exports.after=1;",
    "_interopRequireWildcard(require('item'));__exportStar(require('other'));exports.after=1;"
  };
  for (size_t index = 0; index < sizeof(scans) / sizeof(*scans); index++) {
    length = strlen(scans[index]);
    for (uint32_t flags = 0; flags <= 3; flags++) {
      for (size_t count = 0; count <= length; count++) {
        source = copy(scans[index], count);
        uint32_t status = cjs_lexer_parse_utf16(source, count, flags, &result, &error);
        assert(status == CJS_LEXER_OK || status == CJS_LEXER_SYNTAX_ERROR);
        assert(!error.has_offset || error.offset <= count);
        if (count == length) {
          assert(status == CJS_LEXER_OK);
          assert(cjs_lexer_export_count(result));
          name(cjs_lexer_export(result, cjs_lexer_export_count(result) - 1), "after");
        }
        cjs_lexer_result_free(result);
        free(source);
      }
    }
  }
  // The nesting boundary and recovery share the public parse path.
  for (size_t depth = 2047; depth <= 2049; depth++) {
    source = malloc(depth * 4);
    assert(source);
    for (size_t index = 0; index < depth; index++) {
      source[index] = '(';
      source[depth + index] = ')';
    }
    uint32_t status = cjs_lexer_parse_utf16(source, depth * 2, 0, &result, &error);
    assert(status == (depth <= 2048 ? CJS_LEXER_OK : CJS_LEXER_LIMIT));
    if (depth > 2048) assert(error.has_offset && error.offset == 2048);
    cjs_lexer_result_free(result);
    free(source);
  }
  assert(cjs_lexer_parse_utf16(&unit, 1, 0, &result, NULL) == CJS_LEXER_OK);
  cjs_lexer_result_free(result);
  // Deterministic malformed UTF-16 exercises both modes without padding.
  uint32_t random = 42;
  for (size_t iteration = 0; iteration < 20000; iteration++) {
    length = iteration % 128;
    source = malloc(length * sizeof(uint16_t));
    for (size_t index = 0; index < length; index++) {
      random = random * UINT32_C(1664525) + UINT32_C(1013904223);
      source[index] = (iteration & 1) ? (uint16_t)(random >> 16) : (uint16_t)(random % 128);
    }
    uint32_t status = cjs_lexer_parse_utf16(source, length, (uint32_t)iteration & 3, &result, &error);
    assert(status == CJS_LEXER_OK || status == CJS_LEXER_SYNTAX_ERROR || status == CJS_LEXER_LIMIT);
    assert(!error.has_offset || error.offset <= length);
    cjs_lexer_result_free(result);
    free(source);
  }
  cjs_lexer_result_free(NULL);
  return 0;
}
