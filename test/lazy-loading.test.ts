/**
 * The registry must stay lazy.
 *
 * Importing `./providers` for a type or a registry helper must NOT drag in
 * provider implementations. Tesco alone pulls in Playwright, so a static
 * re-export in the barrel turns a `groc providers` listing into a multi-second
 * startup and makes a UK user pay for every other country's code.
 *
 * This is easy to regress with one innocent-looking `export { X } from './x'`,
 * so it is asserted rather than trusted.
 *
 * Run: npx tsx test/lazy-loading.test.ts
 */

import assert from 'node:assert';

const PROVIDER_MODULE = /providers[/\\](sainsburys|ocado|tesco|ah|instacart)/;

function loadedProviderModules(): string[] {
  return Object.keys(require.cache).filter((p) => PROVIDER_MODULE.test(p));
}

let failures = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (err: any) {
    failures++;
    console.error(`  ✗ ${name}\n    ${err.message}`);
  }
}

console.log('lazy-loading');

// 1. The barrel must not load any provider implementation.
const registry = require('../src/providers');
check('importing ./providers loads no provider module', () => {
  const loaded = loadedProviderModules();
  assert.deepStrictEqual(
    loaded,
    [],
    `these were eagerly loaded:\n      ${loaded.join('\n      ')}\n` +
      `    A static re-export in src/providers/index.ts is the usual cause.`
  );
});

// 2. Listing and filtering must work without loading anything.
check('list() works with no provider loaded', () => {
  const all = registry.list();
  assert.ok(all.length >= 5, `expected >= 5 providers, got ${all.length}`);
  assert.deepStrictEqual(loadedProviderModules(), []);
});

check('country filter excludes other countries', () => {
  const gb = registry.list({ country: 'GB' }).map((p: any) => p.id).sort();
  assert.deepStrictEqual(gb, ['ocado', 'sainsburys', 'tesco']);
  const nl = registry.list({ country: 'NL' }).map((p: any) => p.id);
  assert.deepStrictEqual(nl, ['ah']);
  assert.deepStrictEqual(loadedProviderModules(), []);
});

check('multi-country providers match every country they serve', () => {
  const ca = registry.list({ country: 'CA' }).map((p: any) => p.id).sort();
  assert.deepStrictEqual(ca, ['instacart', 'instacart-web']);
});

check('capability filter is honoured', () => {
  const checkoutCapable = registry
    .list({ capability: 'checkout' })
    .map((p: any) => p.id)
    .sort();
  // Ocado is deliberately absent: its checkout is WAF-blocked, so the manifest
  // does not claim the capability. This assertion is the guard on that honesty.
  assert.deepStrictEqual(checkoutCapable, ['sainsburys', 'tesco']);
  assert.ok(!registry.supports('ah', 'checkout'));
  assert.ok(registry.supports('ah', 'search'));
});

check('unknown provider names the alternatives', () => {
  assert.throws(() => registry.getManifest('nope'), /Available:/);
});

check('missing capability fails loudly', () => {
  assert.throws(() => registry.assertCapability('ah', 'checkout'), /does not support/);
});

check('providersFor explains an empty country rather than returning []', () => {
  assert.throws(() => registry.providersFor('ZZ'), /Countries covered/);
});

check('providersFor explains a missing capability in a real country', () => {
  assert.throws(() => registry.providersFor('NL', 'checkout'), /Available there/);
});

check('resolveCountry prefers the explicit argument', () => {
  assert.strictEqual(registry.resolveCountry('nl'), 'NL');
  process.env.GROC_COUNTRY = 'de';
  assert.strictEqual(registry.resolveCountry(), 'DE');
  delete process.env.GROC_COUNTRY;
});

// 3. Only now, on demand, should a provider module appear.
(async () => {
  await registry.createProvider('ah');
  check('createProvider loads exactly the one provider asked for', () => {
    const loaded = loadedProviderModules();
    assert.strictEqual(loaded.length, 1, `expected 1 module, got ${loaded.length}`);
    assert.match(loaded[0], /providers[/\\]ah/);
  });

  console.log(failures === 0 ? '\nall passed' : `\n${failures} failed`);
  process.exit(failures === 0 ? 0 : 1);
})();
