#include "cjs-module-lexer.h"
#include <stdlib.h>

int LLVMFuzzerTestOneInput(const uint8_t* data, size_t size) {
  if (!size) return 0;
  size_t length = (size - 1) / 2;
  uint16_t* source = malloc(length * sizeof(uint16_t));
  if (!source && length) return 0;
  for (size_t index = 0; index < length; index++)
    source[index] = (uint16_t)(data[index * 2 + 1] | (uint16_t)data[index * 2 + 2] << 8);
  cjs_lexer_result* result;
  cjs_lexer_error error;
  cjs_lexer_parse_utf16(source, length, data[0] & 3, &result, &error);
  if (result) {
    for (size_t index = 0; index < cjs_lexer_export_count(result); index++) {
      cjs_lexer_string16 value = cjs_lexer_export(result, index);
      volatile uint16_t unit = 0;
      for (size_t offset = 0; offset < value.length; offset++) unit = value.data[offset];
      (void)unit;
    }
  }
  cjs_lexer_result_free(result);
  free(source);
  return 0;
}
