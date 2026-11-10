const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');

const root = join(__dirname, '..');
const geodataSource = readFileSync(join(root, 'js/sz-geodata.js'), 'utf8');
const uri = (source) => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
let sequence = 0;

// 用 data: URL 独立求值 js/sz-geodata.js，只把 './sz-data-format.js' 换成可观察的 stub：
// 第一次请求失败，第二次成功，用来复现“城市包失败 → 启动页提示 → 页内重试”的整条链路。
function stubDataFormat({ failEveryRead = false, readErrorCode = 'request' } = {}) {
  const marker = `geodata-stub-${++sequence}`;
  return uri(`
    export class CityDataError extends Error {
      constructor(code, message) {
        super(message);
        this.name = 'CityDataError';
        this.code = code;
      }
    }
    const calls = globalThis.__szGeodataStubCalls = { marker: ${JSON.stringify(marker)}, read: 0, decode: 0 };
    export async function readCityPayload(url, fetcher, metrics) {
      calls.read++;
      if (${failEveryRead} || calls.read === 1) throw new CityDataError(${JSON.stringify(readErrorCode)}, 'City data ' + ${JSON.stringify(readErrorCode)} + ' failed: 404');
      return { version: 2 };
    }
    export function decodeCityPayload(raw, metrics) {
      calls.decode++;
      return { geo: { version: raw.version }, buildings: [] };
    }
  `);
}

function loadGeodata(stubUrl, tag) {
  const replaced = geodataSource
    .replace(/(['"])[.]\/sz-data-format[.]js\1/, JSON.stringify(stubUrl))
    .replace(/import[.]meta[.]url/g, JSON.stringify('https://example.test/js/sz-geodata.js'));
  assert.notEqual(replaced, geodataSource, 'js/sz-geodata.js keeps its static ./sz-data-format.js import');
  return import(uri(`// ${tag} ${++sequence}\n${replaced}`));
}

function createBootStub() {
  const calls = { fail: [], clear: 0, setRetryHandler: [] };
  const boot = {
    state: 'loading',
    labels: {},
    messages: {},
    resolveFail: null,
    fail(kind, error) {
      calls.fail.push({ kind, error });
      return new Promise((resolve) => { boot.resolveFail = resolve; });
    },
    setRetryHandler(handler) {
      calls.setRetryHandler.push(handler);
    },
    clear() {
      calls.clear++;
      boot.resolveFail = null;
    },
    ready() {}
  };
  return { boot, calls };
}

// 模拟玩家按下 #boot-retry：启动页会调用页内重试处理函数并 resolve fail() 的等待，两者都做掉，
// 这样无论加载器等的是哪一个 Promise，都能继续重试。
function clickRetry(boot, calls) {
  const handler = calls.setRetryHandler.at(-1);
  assert.ok(handler, 'the city loader registered an in-page retry handler');
  handler();
  const resolve = boot.resolveFail;
  boot.resolveFail = null;
  if (resolve) resolve();
}

async function waitFor(predicate, message, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function within(promise, message, timeoutMs = 5000) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

test('city data failures wait for an in-page retry before the module graph resolves', async () => {
  const { boot, calls } = createBootStub();
  globalThis.__szBoot = boot;
  try {
    const pending = loadGeodata(stubDataFormat(), 'retry');
    await waitFor(() => calls.fail.length === 1, 'the first city data failure reports to __szBoot.fail');
    assert.equal(calls.setRetryHandler.length, 1, 'a page-level retry handler is registered before the first request');
    assert.equal(typeof calls.setRetryHandler[0], 'function');
    const [{ kind, error }] = calls.fail;
    assert.equal(kind, 'dataRequest', 'request failures map to the dataRequest message');
    assert.equal(error.name, 'CityDataError');
    assert.equal(error.code, 'request');
    assert.match(error.message, /404/);
    assert.equal(globalThis.__szGeodataStubCalls.read, 1);
    assert.equal(globalThis.__szGeodataStubCalls.decode, 0, 'nothing is decoded before a payload is read');
    assert.equal(calls.clear, 0);

    clickRetry(boot, calls);
    const namespace = await within(pending, 'the geodata module stays pending until the retry click');
    assert.equal(globalThis.__szGeodataStubCalls.read, 2, 'the click retries the request inside the same page');
    assert.equal(globalThis.__szGeodataStubCalls.decode, 1);
    assert.equal(calls.clear, 1, 'a successful retry dismisses the failure panel');
    assert.equal(namespace.CITY_PAYLOAD.version, 2);
    assert.equal(namespace.GEO.version, 2);
    assert.deepEqual(namespace.REAL_BUILDINGS, []);
  } finally {
    delete globalThis.__szBoot;
    delete globalThis.__szGeodataStubCalls;
  }
});

test('decompress and validation failures map to their own boot message kinds', async () => {
  for (const [code, kind] of [['decompress', 'dataDecompress'], ['invalid', 'dataInvalid']]) {
    const { boot, calls } = createBootStub();
    globalThis.__szBoot = boot;
    try {
      const pending = loadGeodata(stubDataFormat({ readErrorCode: code }), `kind-${code}`);
      await waitFor(() => calls.fail.length === 1, `the ${code} failure reports to __szBoot.fail`);
      assert.equal(calls.fail[0].kind, kind, `code ${code} maps to the ${kind} message`);
      assert.equal(calls.fail[0].error.code, code);
      clickRetry(boot, calls);
      await within(pending, `the ${code} failure must recover after an in-page retry`);
      assert.equal(calls.clear, 1);
    } finally {
      delete globalThis.__szBoot;
      delete globalThis.__szGeodataStubCalls;
    }
  }
});

test('without the boot fallback a city data failure rejects module evaluation with the original error', async () => {
  delete globalThis.__szBoot;
  try {
    const pending = loadGeodata(stubDataFormat({ failEveryRead: true }), 'no-boot');
    await assert.rejects(within(pending, 'without __szBoot the module must reject'), (error) => {
      assert.equal(error.name, 'CityDataError');
      assert.equal(error.code, 'request');
      assert.match(error.message, /404/);
      return true;
    });
    assert.equal(globalThis.__szGeodataStubCalls.read, 1, 'no __szBoot means no retry loop');
    assert.equal(globalThis.__szGeodataStubCalls.decode, 0);
  } finally {
    delete globalThis.__szGeodataStubCalls;
  }
});

test('the loader keeps a static data-format import and a top-level await', () => {
  assert.match(geodataSource,
    /^import\s+\{[^}]*\breadCityPayload\b[^}]*\}\s+from\s+'\.\/sz-data-format\.js';/m,
    'the city loader imports the data-format helpers statically');
  assert.match(geodataSource, /\n(?:export )?const [\w$]+ = await [\w$]+\(/,
    'module evaluation awaits the city data before the entry module runs');
});
