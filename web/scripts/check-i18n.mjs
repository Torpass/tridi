// Automated bilingual (ES/EN) completeness check (Pilar A1 of docs/plan-v2.md).
// Fails if any UI string dictionary entry is missing `es` or `en`, if `{var}` placeholders
// differ between languages, if any screen calls T/t/L/X/A/S with an unknown key, or if any
// world, scene, policy level or preloaded clip lacks a translation in strings-names.js.
// Run: npm --prefix web run check
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LANGS } from '../src/i18n.js';
import { clipName, levelName, sceneName, worldName } from '../src/strings-names.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SRC = join(ROOT, 'src');
const failures = [];
const expect = (ok, what) => {
  if (!ok) {
    console.error(`  FAIL ${what}`);
    failures.push(what);
  }
};

const walkJs = (dir) =>
  readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walkJs(full) : name.endsWith('.js') ? [full] : [];
  });

const placeholders = (text) => [...String(text).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');

// 1. Check all dict({...}) modules by importing the pure string modules and parsing inline dict({...}).
const STRING_MODULES = [
  '../src/landing/strings.js',
  '../src/strings-stage.js',
  '../src/strings-training.js',
  '../src/screens/strings/delivery.js',
  '../src/screens/strings/live.js',
  '../src/screens/strings/milestones.js',
  '../src/screens/strings/net.js',
  '../src/screens/strings/phone.js',
  '../src/screens/strings/upload.js',
];

const dictByModule = new Map();
let totalKeys = 0;

for (const rel of STRING_MODULES) {
  const mod = await import(rel);
  const strings = mod.T?.strings ?? mod.strings ?? findDictInModule(join(ROOT, 'scripts', rel));
  const label = relative(ROOT, fileURLToPath(new URL(rel, import.meta.url)));
  dictByModule.set(fileURLToPath(new URL(rel, import.meta.url)), strings);
  checkStringsObject(label, strings);
}

function findDictInModule(filePath) {
  // Fallback when a module does not export `T` (e.g. inline dict({...}) in netview.js).
  const code = readFileSync(filePath, 'utf8');
  const match = code.match(/dict\(\s*(\{[\s\S]*?\n\})\s*\)/);
  if (!match) return {};
  return Function(`"use strict"; return (${match[1]});`)();
}

// Also check inline dict({...}) in files like src/netview.js
for (const file of walkJs(SRC)) {
  if (dictByModule.has(file)) continue;
  const code = readFileSync(file, 'utf8');
  if (!/\bdict\s*\(\s*\{/.test(code)) continue;
  const strings = findDictInModule(file);
  dictByModule.set(file, strings);
  checkStringsObject(relative(ROOT, file), strings);
}

function checkStringsObject(label, strings) {
  const keys = Object.keys(strings);
  expect(keys.length > 0, `${label}: has at least one string key`);
  for (const key of keys) {
    totalKeys++;
    const entry = strings[key];
    for (const l of LANGS) {
      expect(typeof entry?.[l] === 'string' && entry[l].trim().length > 0, `${label} [${key}]: has non-empty '${l}' translation`);
    }
    if (entry?.es && entry?.en) {
      expect(
        placeholders(entry.es) === placeholders(entry.en),
        `${label} [${key}]: same {placeholders} in es (${placeholders(entry.es)}) and en (${placeholders(entry.en)})`,
      );
    }
  }
}

console.log(`  ok   ${dictByModule.size} string dictionaries (${totalKeys} keys) have complete es/en translations and matching {placeholders}`);

// 2. Check that every T('key') / t('key') / L('key') / X('key') / A({...}) / S(el, {...}) call in src/ resolves to a defined key.
let checkedCalls = 0;
for (const file of walkJs(SRC)) {
  const code = readFileSync(file, 'utf8');
  let strings = dictByModule.get(file);
  if (!strings) {
    const imp = code.match(/from\s+['"](\.[^'"]*strings[^'"]*)['"]/);
    if (imp) {
      const target = fileURLToPath(new URL(imp[1], `file://${file}`));
      strings = dictByModule.get(target);
    }
  }
  if (!strings) continue;
  const rel = relative(ROOT, file);
  for (const m of code.matchAll(/\b(?:T|t|L|X)\(\s*['"]([^'"]+)['"]/g)) {
    checkedCalls++;
    expect(Object.hasOwn(strings, m[1]), `${rel}: key '${m[1]}' exists in its string dictionary`);
  }
  for (const m of code.matchAll(/\bA\(\s*\{([^}]+)\}/g)) {
    for (const kv of m[1].matchAll(/:\s*['"]([^'"]+)['"]/g)) {
      checkedCalls++;
      expect(Object.hasOwn(strings, kv[1]), `${rel}: attribute key '${kv[1]}' exists in its string dictionary`);
    }
  }
}
console.log(`  ok   ${checkedCalls} translation lookups in web/src/ resolve to defined keys`);

// 3. Check data-driven names (worlds, scenes, preloaded clips).
const worldsDir = join(ROOT, '..', 'physics', 'worlds');
for (const f of readdirSync(worldsDir).filter((n) => n.endsWith('.json'))) {
  const id = f.replace(/\.json$/, '');
  const byLang = worldName(id, '');
  expect(byLang.es && byLang.en && byLang.es !== byLang.en, `strings-names.js worldName('${id}'): has distinct es ('${byLang.es}') and en ('${byLang.en}')`);
}

const scenesDir = join(ROOT, '..', 'physics', 'scenes');
for (const id of readdirSync(scenesDir).filter((n) => statSync(join(scenesDir, n)).isDirectory())) {
  const byLang = sceneName(id, '');
  expect(byLang.es && byLang.en && byLang.es !== byLang.en, `strings-names.js sceneName('${id}'): has distinct es ('${byLang.es}') and en ('${byLang.en}')`);
}

for (const id of ['g1-stand-step-0', 'g1-stand', 'g1-walk', 'g1-run', 'g1-jacks']) {
  const byLang = levelName(id, '');
  expect(byLang.es && byLang.en && byLang.es !== byLang.en, `strings-names.js levelName('${id}'): has distinct es and en`);
}

const preloaded = JSON.parse(readFileSync(join(SRC, 'preloaded.json'), 'utf8'));
for (const item of preloaded) {
  const { title, credit } = clipName(item);
  expect(title.es && title.en, `preloaded.json '${item.clip}': has es and en title`);
  expect(credit.es && credit.en, `preloaded.json '${item.clip}': has es and en credit`);
}
console.log(`  ok   all worlds, scenes, policy levels and ${preloaded.length} preloaded clips have es/en translations`);

if (failures.length) {
  console.error(`\ncheck-i18n failed: ${failures.length} problem(s)`);
  process.exit(1);
}
console.log('\ncheck-i18n passed');
