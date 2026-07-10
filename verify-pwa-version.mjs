import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const sw = readFileSync(join(here, 'sw.js'), 'utf8');
const html = readFileSync(join(here, 'index.html'), 'utf8');

const cacheMatch = sw.match(/CACHE_NAME\s*=\s*['"][^'"]*?(v\d+)['"]/);
const badgeMatch =
  html.match(/app-version-badge[^>]*data-version=["'](v\d+)["']/) ||
  html.match(/app-version-badge[^>]*>\s*(v\d+)\s*</);

const cacheVersion = cacheMatch && cacheMatch[1];
const badgeVersion = badgeMatch && badgeMatch[1];
const errors = [];

const cacheBustVersions = [...html.matchAll(/(?:style\.css|quiz\.js|app\.js)\?v=(\d+)/g)]
  .map((match) => `v${match[1]}`);

if (!cacheVersion) errors.push('sw.js の CACHE_NAME から版数を読み取れません。');
if (!badgeVersion) errors.push('index.html の app-version-badge から版数を読み取れません。');
if (cacheVersion && badgeVersion && cacheVersion !== badgeVersion) {
  errors.push(`画面表示(${badgeVersion})とService Worker(${cacheVersion})の版数が一致していません。`);
}
if (!sw.includes('GET_VERSION') || !sw.includes('SW_VERSION')) {
  errors.push('Service Worker の版数応答（GET_VERSION / SW_VERSION）が見つかりません。');
}
if (!html.includes('checkPwaVersion')) {
  errors.push('index.html の版数チェック処理が見つかりません。');
}
if (!/CACHE_PREFIX\s*=\s*['"]sedori-route-['"]/.test(sw)) {
  errors.push('Service Worker の専用CACHE_PREFIXが見つかりません。');
}
if (!/\.filter\(k\s*=>\s*k\.startsWith\(CACHE_PREFIX\)\s*&&\s*k\s*!==\s*CACHE_NAME\)/.test(sw)) {
  errors.push('旧cache削除がsedori-route専用prefixへ限定されていません。');
}
if (cacheBustVersions.length !== 3 || cacheBustVersions.some((version) => version !== badgeVersion)) {
  errors.push(`CSS/JSのcache bustが画面版数(${badgeVersion})と一致していません。`);
}

if (errors.length) {
  console.error('[FAIL] PWA version check');
  for (const err of errors) console.error('- ' + err);
  process.exit(1);
}

console.log(`[OK] PWA version check passed: ${badgeVersion}`);
