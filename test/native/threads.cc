#include "cjs-module-lexer.h"
#include <cassert>
#include <condition_variable>
#include <mutex>
#include <thread>
#include <vector>

int main() {
  std::mutex mutex;
  std::condition_variable ready;
  unsigned waiting = 0;
  std::vector<std::thread> workers;
  for (unsigned worker = 0; worker < 8; worker++) {
    workers.emplace_back([&, worker]() {
      std::vector<uint16_t> source;
      for (char unit : "exports['\\u0061']=1;module.exports=require('dep');") {
        if (unit) source.push_back(static_cast<uint16_t>(unit));
      }
      std::unique_lock<std::mutex> lock(mutex);
      waiting++;
      ready.notify_all();
      ready.wait(lock, [&]() { return waiting == 8; });
      lock.unlock();
      for (unsigned iteration = 0; iteration < 1000; iteration++) {
        cjs_lexer_result* first;
        cjs_lexer_result* second;
        cjs_lexer_error error;
        assert(cjs_lexer_parse_utf16(source.data(), source.size(), worker & 3, &first, &error) == CJS_LEXER_OK);
        assert(cjs_lexer_parse_utf16(source.data(), source.size(), 0, &second, nullptr) == CJS_LEXER_OK);
        auto name = cjs_lexer_export(first, 0);
        assert(name.length == 1 && name.data[0] == 'a');
        auto specifier = cjs_lexer_reexport(second, 0);
        assert(specifier.length == 3 && specifier.data[0] == 'd');
        cjs_lexer_result_free(iteration & 1 ? first : second);
        if (!(iteration & 1)) assert(cjs_lexer_export(first, 0).data[0] == 'a');
        else assert(cjs_lexer_reexport(second, 0).data[0] == 'd');
        cjs_lexer_result_free(iteration & 1 ? second : first);
      }
    });
  }
  for (auto& worker : workers) worker.join();
}
