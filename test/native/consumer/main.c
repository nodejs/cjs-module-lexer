#include <cjs-module-lexer.h>

int main(void) {
  const uint16_t source[] = {'e', 'x', 'p', 'o', 'r', 't', 's', '.', 'a', '=', '1'};
  cjs_lexer_result* result;
  if (cjs_lexer_parse_utf16(source, sizeof(source) / sizeof(source[0]), 0, &result, NULL)) return 1;
  if (cjs_lexer_export_count(result) != 1 || cjs_lexer_reexport_count(result)) return 1;
  cjs_lexer_string16 name = cjs_lexer_export(result, 0);
  int status = name.length != 1 || name.data[0] != 'a';
  cjs_lexer_result_free(result);
  return status;
}
