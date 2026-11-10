const assert = require('node:assert/strict');
const { existsSync, readFileSync, readdirSync } = require('node:fs');
const { dirname, join, relative, resolve } = require('node:path');
const test = require('node:test');

const root = join(__dirname, '..');
const jsRoot = join(root, 'js');
const entry = join(jsRoot, 'main.js');

// 仓库不打包，浏览器按相对 URL 直接取模块；这里只跟静态 import/export 的相对说明符。
// 函数体内的动态 import 被规范禁止，所以全部模块关系都能被这条正则遍历到。
// js/sz-mvp/ 是待删除的临时预览页，用户确认删除前不纳入可达性要求。
const importPattern = /(?:import|export)\s[^'"]*?from\s+['"](\.[^'"]+)['"]|import\s+['"](\.[^'"]+)['"]/gs;

function staticRelativeImports(file) {
  const source = readFileSync(file, 'utf8');
  return [...source.matchAll(importPattern)].map((match) => resolve(dirname(file), match[1] || match[2]));
}

function listRuntimeModules(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'sz-mvp' ? [] : listRuntimeModules(path);
    return entry.name.endsWith('.js') ? [path] : [];
  });
}

function traverseRuntimeGraph() {
  const seen = new Set();
  const missing = new Set();
  const stack = [entry];
  while (stack.length) {
    const file = stack.pop();
    if (seen.has(file)) continue;
    if (!existsSync(file)) {
      missing.add(file);
      continue;
    }
    seen.add(file);
    stack.push(...staticRelativeImports(file));
  }
  return { seen, missing };
}

test('every runtime module is reachable from js/main.js', () => {
  const { seen } = traverseRuntimeGraph();
  const unreachable = listRuntimeModules(jsRoot)
    .filter((file) => !seen.has(file))
    .map((file) => relative(root, file))
    .sort();
  assert.deepEqual(unreachable, [],
    'js/ must only hold modules the official entry loads; dead New York copies belong to ref/');
});

test('relative imports in the runtime graph resolve to existing files', () => {
  const { missing } = traverseRuntimeGraph();
  const unresolved = [...missing].map((file) => relative(root, file)).sort();
  assert.deepEqual(unresolved, [], 'every relative import must point at a shipped file');
});
