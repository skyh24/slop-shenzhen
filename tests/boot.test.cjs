const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');

const html = readFileSync(join(__dirname, '../index.html'), 'utf8');
const importMap = html.match(/<script type="importmap">([^]*?)<\/script>/);
const scripts = [...html.matchAll(/<script\b([^>]*)>([^]*?)<\/script>/g)];
const importMapScripts = scripts.filter((match) => /\btype="importmap"/.test(match[1]));
const moduleScripts = scripts.filter((match) => /\btype="module"/.test(match[1]));
// 启动兜底脚本必须是 classic inline：没有 src，也没有 type（import map / module 各有自己的 type）。
const inlineScripts = scripts.filter((match) => !/\bsrc=/.test(match[1]) && !match[1].includes('type='));
const inlineBoot = inlineScripts[0];
const preloads = [...html.matchAll(/<link rel="modulepreload" href="([^"]+)"\s*\/>/g)];
const entries = [...html.matchAll(/<script type="module" src="([^"]+)"><\/script>/g)];

// 从内联脚本里取出 BOOT_LABELS / BOOT_MESSAGES 对象字面量；跳过字符串里的花括号，求值后与 STR.boot 逐项比较。
function extractObjectLiteral(source, name) {
  const declaration = new RegExp(`\\b(?:const|let|var)\\s+${name}\\s*=\\s*\\{`).exec(source);
  assert.ok(declaration, `${name} is declared as an object literal in the inline boot script`);
  const start = declaration.index + declaration[0].length - 1;
  let depth = 0;
  let quote = null;
  for (let i = start; i < source.length; i++) {
    const char = source[i];
    if (quote) {
      if (char === '\\') { i++; continue; }
      if (char === quote) quote = null;
      continue;
    }
    if (char === '\'' || char === '"' || char === '`') { quote = char; continue; }
    if (char === '{') depth += 1;
    if (char === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  assert.fail(`${name} object literal is unbalanced`);
}

test('city module preloads start after the import map and the boot fallback, before stylesheets', () => {
  assert.ok(importMap);
  assert.ok(preloads.length > 0);
  assert.equal(scripts.length, 3, 'the import map, one inline boot fallback and one native module entry are the only scripts');
  assert.equal(importMapScripts.length, 1);
  assert.equal(inlineScripts.length, 1);
  assert.ok(inlineBoot, 'the inline boot fallback is a classic script');
  assert.ok(!inlineBoot[1].includes('async'), 'the fallback must run synchronously, before any module download');
  assert.ok(importMap.index < inlineBoot.index, 'the fallback is installed after the import map');
  assert.ok(inlineBoot.index < preloads[0].index, 'the fallback is installed before modulepreload starts fetching');
  const stylesheetIndex = html.indexOf('rel="stylesheet"');
  for (const preload of preloads) {
    assert.ok(importMap.index < preload.index);
    assert.ok(preload.index < stylesheetIndex);
  }
  assert.equal(entries.length, 1);
  assert.ok(preloads[0].index < entries[0].index);
  assert.ok(entries[0].index < stylesheetIndex, 'the module graph starts loading early too');
  assert.match(html, /<link rel="preconnect" href="https:\/\/cdn\.jsdelivr\.net" crossorigin\s*\/>/);
  const { imports } = JSON.parse(importMap[1]);
  assert.equal(imports.three, imports['three/webgpu'], 'Three.js aliases share one module instance');
});

test('native module entry and imports share canonical preloaded URLs on GitHub Pages', () => {
  const links = preloads.map((match) => match[1]);
  assert.equal(new Set(links).size, links.length, 'each module is preloaded once');
  assert.equal(entries.length, 1);
  assert.equal(moduleScripts.length, 1, 'the native entry stays the only module script');
  assert.equal(entries[0][1], './js/main.js');
  assert.ok(links.includes(entries[0][1]));
  assert.ok(!links.includes('./js/nyc-geodata.js'), 'the Shenzhen entry does not load New York geography');
  const base = 'https://example.test/slop-shenzhen/';
  const urls = new Set(links.map((src) => new URL(src, base).href));
  for (const src of links) {
    assert.match(src, /^\.\/js\/(?:[\w-]+\/)*[\w-]+\.js$/, 'preloads use the same unversioned paths as native imports');
    const source = readFileSync(join(__dirname, '..', src), 'utf8');
    for (const [, specifier] of source.matchAll(/(?:\bfrom\s*|\bimport\s*)['"](\.[^'"]+)['"]/g)) {
      const url = new URL(specifier, new URL(src, base));
      assert.ok(urls.has(url.href), `${src} imports an unpreloaded or mismatched URL: ${specifier}`);
    }
  }
});

test('metro layers are controlled only inside the full map', () => {
  const map = html.slice(html.indexOf('id="fullmap-modal"'));
  assert.doesNotMatch(html, /id="btn-metro"/);
  assert.equal([...html.matchAll(/popovertarget="metro-popover"/g)].length, 1);
  assert.match(map, /id="map-metro"[^>]*popovertarget="metro-popover"/);
  assert.match(map, /id="metro-popover"/);
  assert.match(map, /id="metro-lines"/);
});

test('the inline boot fallback defines __szBoot before any module evaluates', () => {
  const source = inlineBoot[2];
  assert.match(source, /window\.__szBoot\s*=\s*[\w$]+\s*;/, 'window.__szBoot is assigned by the fallback');
  assert.match(source, /\bstate\s*:\s*'loading'/, 'the fallback starts in the loading state');
  assert.match(source, /'loading-failed'/);
  assert.match(source, /location\.reload\(\)/, 'the fallback reloads when no in-page retry handler is registered');
  assert.match(source, /addEventListener\(\s*['"]error['"]/, 'failed startup scripts are observed globally');
  assert.match(source, /addEventListener\(\s*['"]unhandledrejection['"]/, 'startup promise rejections are observed globally');
  assert.match(source, /boot-retry/);
  assert.match(source, /boot-error-detail/);
  assert.match(source, /labels\s*:\s*BOOT_LABELS/);
  assert.match(source, /messages\s*:\s*BOOT_MESSAGES/);
});

test('the loading overlay ships the empty boot error markup the fallback fills in', () => {
  const overlayStart = html.indexOf('id="loading-overlay"');
  const overlayEnd = html.indexOf('<main', overlayStart);
  assert.ok(overlayStart > 0 && overlayEnd > overlayStart, 'the loading overlay sits before the canvas container');
  const overlay = html.slice(overlayStart, overlayEnd);
  const panelTag = overlay.match(/<div id="boot-error"[^>]*>/);
  assert.ok(panelTag, '#boot-error lives inside the loading overlay');
  assert.match(panelTag[0], /role="alert"/);
  assert.match(panelTag[0], /\bhidden\b/, 'the error panel starts hidden');
  for (const id of ['boot-error-title', 'boot-error-message', 'boot-error-detail', 'boot-retry', 'boot-error-hint']) {
    assert.ok(overlay.includes(`id="${id}"`), `#${id} exists`);
  }
  const detailTag = overlay.match(/<[^>]*id="boot-error-detail"[^>]*>/);
  assert.ok(detailTag);
  assert.match(detailTag[0], /\bhidden\b/, 'the technical detail starts hidden');
  const retryTag = overlay.match(/<button[^>]*id="boot-retry"[^>]*>/);
  assert.ok(retryTag, '#boot-retry is a button');
  assert.match(retryTag[0], /type="button"/);
  // HTML 只留空容器，偶到失败时由内联脚本按 STR.boot 填入，避免两份中文文案漂移。
  const copy = overlay.slice(overlay.indexOf('<div id="boot-error"')).replace(/<!--[^]*?-->/g, '').replace(/<[^>]*>/g, '').trim();
  assert.equal(copy, '', 'the boot error block carries no hard-coded copy');
});

test('STR.boot mirrors the inline boot labels and messages item by item', async () => {
  const labelLiteral = extractObjectLiteral(inlineBoot[2], 'BOOT_LABELS');
  const messageLiteral = extractObjectLiteral(inlineBoot[2], 'BOOT_MESSAGES');
  assert.match(labelLiteral, /^\{\s*failed:/, 'the label literal starts with the failed key');
  assert.match(messageLiteral, /^\{\s*engine:/, 'the message literal starts with the engine key');
  const labels = new Function(`return (${labelLiteral});`)();
  const messages = new Function(`return (${messageLiteral});`)();
  assert.deepEqual(Object.keys(labels).sort(), ['detail', 'failed', 'retry', 'retryHint', 'retrying']);
  assert.deepEqual(Object.keys(messages).sort(),
    ['dataDecompress', 'dataInvalid', 'dataRequest', 'engine', 'init', 'webgpu']);
  const { STR } = await import('../js/sz-strings.js');
  assert.ok(STR.boot, 'js/sz-strings.js exports STR.boot');
  assert.deepEqual(STR.boot.labels, labels);
  assert.deepEqual(STR.boot.messages, messages);
  for (const [key, value] of Object.entries({ ...labels, ...messages })) {
    assert.equal(typeof value, 'string', `STR.boot copy for ${key} is a string`);
    assert.match(value, /[\u4e00-\u9fff]/, `STR.boot copy for ${key} is Chinese`);
  }
});
