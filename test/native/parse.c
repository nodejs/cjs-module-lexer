#include "cjs-module-lexer.h"
#include <stdio.h>
#include <stdlib.h>
#ifdef _WIN32
#include <fcntl.h>
#include <io.h>
#endif

static void string(cjs_lexer_string16 value) {
  putchar('"');
  for (size_t index = 0; index < value.length; index++) printf("\\u%04x", value.data[index]);
  putchar('"');
}

int main(int argc, char** argv) {
#ifdef _WIN32
  if (_setmode(_fileno(stdin), _O_BINARY) == -1) return 1;
#endif
  uint32_t flags = argc > 1 ? (uint32_t)strtoul(argv[1], NULL, 10) : 0;
  size_t length = 0;
  size_t capacity = 1024;
  uint16_t* source = malloc(capacity * sizeof(uint16_t));
  if (!source) return 1;
  int low;
  while ((low = getchar()) != EOF) {
    int high = getchar();
    if (high == EOF) return 1;
    if (length == capacity) {
      capacity *= 2;
      uint16_t* next = realloc(source, capacity * sizeof(uint16_t));
      if (!next) { free(source); return 1; }
      source = next;
    }
    source[length++] = (uint16_t)(low | high << 8);
  }
  cjs_lexer_result* result;
  cjs_lexer_error error;
  uint32_t status = cjs_lexer_parse_utf16(source, length, flags, &result, &error);
  if (status) {
    printf("{\"status\":%u,\"code\":%u,\"idx\":%zu}\n", status, error.code, error.offset);
  } else {
    printf("{\"exports\":[");
    for (size_t index = 0; index < cjs_lexer_export_count(result); index++) {
      if (index) putchar(',');
      string(cjs_lexer_export(result, index));
    }
    printf("],\"reexports\":[");
    for (size_t index = 0; index < cjs_lexer_reexport_count(result); index++) {
      if (index) putchar(',');
      string(cjs_lexer_reexport(result, index));
    }
    printf("]}\n");
    cjs_lexer_result_free(result);
  }
  free(source);
  return 0;
}
