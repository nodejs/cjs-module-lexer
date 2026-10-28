#include "lexer-internal.h"

void* cjs_lexer_allocate(cjs_lexer_result* result, size_t size) {
  const size_t alignment = _Alignof(max_align_t);
  if (size > SIZE_MAX - alignment + 1) return NULL;
  size = (size + alignment - 1) & ~(alignment - 1);
  ArenaBlock* block = result->blocks;
  if (!block || size > block->capacity - block->used) {
    size_t capacity = size > 4096 ? size : 4096;
    if (capacity > SIZE_MAX - sizeof(ArenaBlock)) return NULL;
    block = malloc(sizeof(ArenaBlock) + capacity);
    if (!block) return NULL;
    block->next = result->blocks;
    block->used = 0;
    block->capacity = capacity;
    result->blocks = block;
  }
  void* value = (unsigned char*)block->data + block->used;
  block->used += size;
  return value;
}

void cjs_lexer_add(Parser* parser, Candidates* list, ptrdiff_t start, ptrdiff_t end) {
  if (parser->error) return;
  if (start < 0 || end < start || (size_t)end > parser->sourceLen) return;
  if (list->count == list->capacity) {
    size_t capacity = list->capacity ? list->capacity * 2 : 16;
    if (capacity < list->capacity || capacity > SIZE_MAX / sizeof(Candidate)) {
      parser->error = 13;
      parser->pos = parser->end + 1;
      return;
    }
    Candidate* data = realloc(list->data, capacity * sizeof(Candidate));
    if (!data) {
      parser->error = 13;
      parser->pos = parser->end + 1;
      return;
    }
    list->data = data;
    list->capacity = capacity;
  }
  Candidate* candidate = &list->data[list->count++];
  candidate->start = start;
  candidate->end = end;
}

static int readHex(uint16_t code) {
  if (code >= '0' && code <= '9') return code - '0';
  if (code >= 'a' && code <= 'f') return code - 'a' + 10;
  if (code >= 'A' && code <= 'F') return code - 'A' + 10;
  return -1;
}

static bool validQuotedString(cjs_lexer_string16 value) {
  for (size_t index = 0; index < value.length; index++) {
    uint16_t prefix = value.data[index] & 0xfc00;
    if (prefix < 0xd800) continue;
    if (prefix != 0xd800 || ++index == value.length ||
        (value.data[index] & 0xfc00) != 0xdc00) return false;
  }
  return true;
}

/* Return -1 on allocation failure, 0 for a rejected name, 1 for a view. */
static int decode(cjs_lexer_result* result, const uint16_t* source, Candidate* candidate) {
  size_t start = (size_t)candidate->start;
  size_t end = (size_t)candidate->end;
  candidate->value.data = source + start;
  candidate->value.length = end - start;
  if (start == end || (source[start] != '\'' && source[start] != '"')) return 1;
  if (end - start < 2 || source[end - 1] != source[start]) return 0;
  start++;
  end--;
  candidate->value.data = source + start;
  candidate->value.length = end - start;
  size_t first = start;
  while (first < end && source[first] != '\\') first++;
  if (first == end) return validQuotedString(candidate->value);
  if (end - start > SIZE_MAX / sizeof(uint16_t)) return -1;
  uint16_t* output = cjs_lexer_allocate(result, (end - start) * sizeof(uint16_t));
  if (!output) return -1;
  size_t written = first - start;
  memcpy(output, source + start, written * sizeof(uint16_t));
  for (size_t index = first; index < end; index++) {
    uint32_t code = source[index];
    if (code == '\\') {
      if (++index == end) return 0;
      code = source[index];
      switch (code) {
        case '\r':
          if (index + 1 < end && source[index + 1] == '\n') index++;
          continue;
        case '\n': case 0x2028: case 0x2029: continue;
        case 'r': code = '\r'; break;
        case 'n': code = '\n'; break;
        case 't': code = '\t'; break;
        case 'b': code = '\b'; break;
        case 'f': code = '\f'; break;
        case 'v': code = '\v'; break;
        case 'x': case 'u': {
          bool braced = code == 'u' && index + 1 < end && source[index + 1] == '{';
          size_t digits = code == 'x' ? 2 : 4;
          code = 0;
          if (braced) {
            index++;
            size_t count = 0;
            while (++index < end && source[index] != '}') {
              int digit = readHex(source[index]);
              if (digit < 0 || code > (0x10ffffU - (uint32_t)digit) / 16) return 0;
              code = code * 16 + (uint32_t)digit;
              count++;
            }
            if (!count || index == end) return 0;
          } else {
            if (digits > end - index - 1) return 0;
            while (digits--) {
              int digit = readHex(source[++index]);
              if (digit < 0) return 0;
              code = code * 16 + (uint32_t)digit;
            }
          }
          break;
        }
        default:
          if (code >= '0' && code <= '7') {
            size_t remaining = code <= '3' ? 2 : 1;
            code -= '0';
            while (remaining-- && index + 1 < end && source[index + 1] >= '0' && source[index + 1] <= '7')
              code = code * 8 + source[++index] - '0';
          }
      }
    }
    if (code > 0xffff) {
      code -= 0x10000;
      output[written++] = (uint16_t)(0xd800 | (code >> 10));
      output[written++] = (uint16_t)(0xdc00 | (code & 0x3ff));
    } else {
      output[written++] = (uint16_t)code;
    }
  }
  candidate->value.data = output;
  candidate->value.length = written;
  return validQuotedString(candidate->value);
}

static bool normalize(cjs_lexer_result* result, const uint16_t* source, Candidates* list) {
  size_t count = 0;
  for (size_t index = 0; index < list->count; index++) {
    Candidate value;
    value.start = list->data[index].start;
    value.end = list->data[index].end;
    value.hash = 0;
    int status = decode(result, source, &value);
    if (status < 0) return false;
    if (!status) continue;
    list->data[count++] = value;
  }
  list->count = count;
  return true;
}

static int compareNames(const void* left, const void* right) {
  const Candidate* first = left;
  const Candidate* second = right;
  if (first->hash != second->hash) return first->hash < second->hash ? -1 : 1;
  if (first->value.length != second->value.length)
    return first->value.length < second->value.length ? -1 : 1;
  return memcmp(first->value.data, second->value.data, first->value.length * sizeof(uint16_t));
}

static void hashNames(Candidates* list) {
  for (size_t index = 0; index < list->count; index++) {
    Candidate* candidate = &list->data[index];
    uint32_t hash = UINT32_C(2166136261);
    for (size_t unit = 0; unit < candidate->value.length; unit++)
      hash = (hash ^ candidate->value.data[unit]) * UINT32_C(16777619);
    candidate->hash = hash;
  }
}

uint32_t cjs_lexer_parse_utf16(const uint16_t* source, size_t length,
                             uint32_t flags, cjs_lexer_result** result,
                             cjs_lexer_error* error) {
  if (error) *error = (cjs_lexer_error){0, 0, 0};
  if (!result) return CJS_LEXER_INVALID_ARGUMENT;
  *result = NULL;
  if ((!source && length) || (flags & ~UINT32_C(3))) return CJS_LEXER_INVALID_ARGUMENT;
  if (length > UINT32_MAX || length > (size_t)PTRDIFF_MAX - 32 ||
      length > SIZE_MAX / sizeof(uint16_t)) return CJS_LEXER_LIMIT;
  cjs_lexer_result* output = malloc(sizeof(cjs_lexer_result));
  if (!output) return CJS_LEXER_OUT_OF_MEMORY;
  *output = (cjs_lexer_result){0};
  Parser parser;
  parser.input = source;
  parser.sourceLen = length;
  parser.pos = -1;
  parser.end = (ptrdiff_t)length - 1;
  parser.lastTokenPos = -1;
  parser.exportObjectPos = -1;
  parser.templateStackDepth = 0;
  parser.openTokenDepth = 0;
  parser.templateDepth = UINT16_MAX;
  parser.lastSlashWasDivision = false;
  parser.nextBraceIsClass = false;
  parser.allowMinifiedEnumerable = (flags & CJS_LEXER_ALLOW_MINIFIED_ENUMERABLE) != 0;
  parser.extended = (flags & CJS_LEXER_EXTENDED) != 0;
  parser.error = 0;
  parser.parse_error = 0;
  parser.starExportBinding_ = (StarExportBinding){0};
  parser.firstStarExport = NULL;
  parser.lastStarExport = NULL;
  parser.result = output;
  uint32_t status = cjs_lexer_scan(&parser);
  if (status) {
    if (error && status != 13) {
      error->code = status;
      error->has_offset = 1;
      error->offset = parser.parse_error > length ? length : parser.parse_error;
    }
    status = status == 13 ? CJS_LEXER_OUT_OF_MEMORY :
      status == 12 ? CJS_LEXER_LIMIT : CJS_LEXER_SYNTAX_ERROR;
  } else if (!normalize(output, source, &output->exports) ||
             !normalize(output, source, &output->reexports) ||
             !normalize(output, source, &output->unsafe_getters)) {
    status = CJS_LEXER_OUT_OF_MEMORY;
  } else if (output->unsafe_getters.count) {
    hashNames(&output->exports);
    hashNames(&output->unsafe_getters);
    qsort(output->unsafe_getters.data, output->unsafe_getters.count, sizeof(Candidate), compareNames);
    size_t count = 0;
    for (size_t index = 0; index < output->exports.count; index++) {
      Candidate candidate = output->exports.data[index];
      if (!bsearch(&candidate, output->unsafe_getters.data, output->unsafe_getters.count,
                   sizeof(Candidate), compareNames)) output->exports.data[count++] = candidate;
    }
    output->exports.count = count;
  }
  if (status) {
    cjs_lexer_result_free(output);
    return status;
  }
  free(output->unsafe_getters.data);
  output->unsafe_getters = (Candidates){0};
  *result = output;
  return CJS_LEXER_OK;
}

size_t cjs_lexer_export_count(const cjs_lexer_result* result) {
  return result->exports.count;
}

size_t cjs_lexer_reexport_count(const cjs_lexer_result* result) {
  return result->reexports.count;
}

cjs_lexer_string16 cjs_lexer_export(const cjs_lexer_result* result, size_t index) {
  return result->exports.data[index].value;
}

cjs_lexer_string16 cjs_lexer_reexport(const cjs_lexer_result* result, size_t index) {
  return result->reexports.data[index].value;
}

void cjs_lexer_result_free(cjs_lexer_result* result) {
  if (!result) return;
  ArenaBlock* block = result->blocks;
  while (block) {
    ArenaBlock* next = block->next;
    free(block);
    block = next;
  }
  free(result->exports.data);
  free(result->reexports.data);
  free(result->unsafe_getters.data);
  free(result);
}
