import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { setTimeout } from 'node:timers/promises';

const files = new Map([
  ['/dist/lexer.mjs', ['dist/lexer.mjs', 'application/javascript']],
  ['/test/legacy.html', ['test/legacy.html', 'text/html']]
]);

/**
 * @param {import('node:http').IncomingMessage} request
 * @param {import('node:http').ServerResponse} response
 */
async function serve (request, response) {
  const file = files.get(request.url.split('?')[0]);
  if (file === undefined) {
    response.writeHead(404);
    response.end();
    return;
  }

  try {
    response.writeHead(200, { 'content-type': file[1] });
    response.end(await readFile(file[0]));
  }
  catch {
    response.writeHead(500);
    response.end();
  }
}

const server = createServer(serve);
await new Promise(resolve => server.listen(8123, resolve));

const driver = spawn(process.env.GECKODRIVER, ['--port', '4444'], {
  stdio: 'inherit',
  env: { ...process.env, MOZ_DISABLE_CONTENT_SANDBOX: '1', MOZ_FORCE_DISABLE_E10S: '1' }
});

/**
 * @param {string} method
 * @param {string} path
 * @param {object} [body]
 * @returns {Promise<unknown>}
 */
async function drive (method, path, body) {
  const options = { method, signal: AbortSignal.timeout(10000) };
  if (body !== undefined) {
    options.headers = { 'content-type': 'application/json' };
    options.body = JSON.stringify(body);
  }
  const response = await fetch('http://127.0.0.1:4444' + path, options);
  const json = await response.json();
  if (!response.ok)
    throw new Error(`${path}: ${JSON.stringify(json).slice(0, 400)}`);
  return json.value;
}

async function waitForDriver () {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      await drive('GET', '/status');
      return;
    }
    catch (error) {
      if (attempt === 99)
        throw error;
    }
    await setTimeout(100);
  }
}

let failure;
let sessionId;
try {
  await waitForDriver();
  const session = await drive('POST', '/session', {
    capabilities: {
      alwaysMatch: {
        'moz:firefoxOptions': {
          binary: process.env.FIREFOX_BIN,
          args: ['-headless']
        }
      }
    }
  });
  sessionId = session.sessionId;
  await drive('POST', `/session/${sessionId}/url`, { url: 'http://127.0.0.1:8123/test/legacy.html' });
  let title = 'RUNNING';
  for (let attempt = 0; attempt < 30 && title === 'RUNNING'; attempt++) {
    await setTimeout(500);
    title = await drive('GET', `/session/${sessionId}/title`);
  }
  if (title !== 'PASS')
    failure = title === 'RUNNING' ? 'timed out' : title;
}
catch (error) {
  failure = error.message;
}
finally {
  if (sessionId !== undefined) {
    try {
      await drive('DELETE', `/session/${sessionId}`);
    }
    catch (error) {
      failure = failure === undefined ? error.message : `${failure}; cleanup: ${error.message}`;
    }
  }
  if (driver.exitCode === null && driver.signalCode === null) {
    const exit = once(driver, 'exit');
    driver.kill();
    await exit;
  }
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

if (failure) {
  console.error(`legacy browser test: ${failure}`);
  process.exitCode = 1;
}
else {
  console.log('legacy browser test: PASS');
}
