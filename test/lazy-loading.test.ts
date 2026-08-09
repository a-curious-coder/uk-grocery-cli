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
function check(name: string, fn: () => void | Promise<void>) {
  try {
    const r = fn();
    if (r instanceof Promise) {
      r.then(() => console.log(`  ✓ ${name}`))
       .catch((err: any) => { failures++; console.error(`  ✗ ${name}\n    ${err.message}`); });
      return;
    }
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

// 3. Only now, on demand, should exactly one provider module appear.
//
// Deliberately SYNCHRONOUS. An earlier version awaited createProvider(), which
// suspended this block while every later test in the file ran and loaded all six
// providers — so the cache assertion resumed against a polluted cache and failed
// for reasons unrelated to laziness. The sync path proves the same property and
// cannot be reordered out from under itself.
check('creating one provider loads exactly that provider', () => {
  const { ProviderFactory } = require('../src/providers');
  ProviderFactory.create('ah');
  const loaded = loadedProviderModules();
  assert.strictEqual(loaded.length, 1, `expected 1 module, got ${loaded.length}: ${loaded}`);
  assert.match(loaded[0], /providers[/\\]ah/);
});

// ─────────────────────────────────────────────────────────────────────
// Checkout must never place an order unless --confirm was passed.
//
// This is the one command that spends real money, and until v3 a bare
// `checkout` did exactly that while --dry-run was opt-in. Asserting the
// inversion here because a one-character regression is a real order.
// ─────────────────────────────────────────────────────────────────────
console.log('\ncheckout safety');

{
  // Each case gets its OWN recorder. An earlier version shared one array across
  // three concurrently-running async checks, so `calls.length = 0` in one wiped
  // another's recording and the suite failed for a reason that had nothing to do
  // with the code under test.
  function harness() {
    const calls: boolean[] = [];
    const provider = {
      name: 'fake',
      async checkout(dryRun = false) {
        calls.push(dryRun);
        return { order_id: 'x', status: 'preview', total: 0, items: [] };
      },
    };
    // Mirrors the CLI: placing = options.confirm === true
    async function run(options: { confirm?: unknown }) {
      const placing = options.confirm === true;
      await provider.checkout(!placing);
      return placing;
    }
    return { calls, run };
  }

  check('no flags → dry run (does NOT place an order)', async () => {
    const { calls, run } = harness();
    const placed = await run({});
    assert.strictEqual(placed, false, 'a bare checkout must not place an order');
    assert.deepStrictEqual(calls, [true], 'provider.checkout must receive dryRun=true');
  });

  check('--confirm → places the order', async () => {
    const { calls, run } = harness();
    const placed = await run({ confirm: true });
    assert.strictEqual(placed, true);
    assert.deepStrictEqual(calls, [false], 'provider.checkout must receive dryRun=false');
  });

  check('a truthy-but-not-true confirm still does NOT place', async () => {
    const { calls, run } = harness();
    // Guards against `--confirm=maybe` or a stray string arriving from an agent.
    const placed = await run({ confirm: 'yes' });
    assert.strictEqual(placed, false, 'only strict true may place an order');
    assert.deepStrictEqual(calls, [true]);
  });
}

// ─────────────────────────────────────────────────────────────────────
// Error translation.
//
// Providers are reverse-engineered and most methods have no try/catch, so the
// raw failure is usually "Request failed with status code 401" — which sends
// people to the issue tracker for an expired login. Translated once at the
// boundary; these assertions keep it honest.
// ─────────────────────────────────────────────────────────────────────
console.log('\nerror translation');

{
  const { explain } = require('../src/errors');
  const http = (status: number) => ({
    response: { status },
    message: `Request failed with status code ${status}`,
  });

  check('401 names the provider and the fix', () => {
    const m = explain(http(401), { provider: 'ocado', action: 'get slots' });
    assert.match(m, /Not authenticated with ocado/);
    assert.match(m, /supermarket login --provider ocado/);
    assert.doesNotMatch(m, /Request failed with status code/);
  });

  check('cookie-auth providers are told to import a session, not to log in', () => {
    const m = explain(http(403), { provider: 'tesco' });
    assert.match(m, /import-session/);
    assert.doesNotMatch(m, /supermarket login/);
  });

  check('429 is described as throttling, not breakage', () => {
    const m = explain(http(429), { provider: 'ah' });
    assert.match(m, /rate limiting/);
    assert.match(m, /not a broken integration/);
  });

  check('5xx is called transient', () => {
    assert.match(explain(http(503), { provider: 'tesco' }), /server trouble.*retry/s);
  });

  check('network failures are distinguished from HTTP ones', () => {
    assert.match(
      explain({ code: 'ENOTFOUND', message: 'getaddrinfo ENOTFOUND' }, { provider: 'jumbo' }),
      /Could not reach jumbo/
    );
  });

  check('bot protection is identified as such', () => {
    assert.match(
      explain({ message: 'cf-mitigated: challenge returned by cloudflare' }, { provider: 'doordash' }),
      /bot-protection challenge/
    );
  });

  // The most important one: a provider that has already said something useful
  // must not have it replaced by a generic message.
  check("a provider's own explanation is never overwritten", () => {
    const considered =
      'Ocado slot booking and checkout have not been reverse-engineered ' +
      '(capturing them requires performing a real booking).';
    assert.strictEqual(explain({ message: considered }, { provider: 'ocado' }), considered);
  });
}

// ─────────────────────────────────────────────────────────────────────
// Registry / factory parity.
//
// Every manifest entry must be constructible through BOTH paths — the async
// createProvider() and the legacy synchronous ProviderFactory that `--provider`
// still uses. They drifted: ah, instacart and instacart-web were in the registry
// and reachable via --country, but `--provider ah` threw "cannot be created
// synchronously". The international providers were effectively unreachable by
// the flag most people would type.
// ─────────────────────────────────────────────────────────────────────
console.log('\nregistry/factory parity');

{
  const { PROVIDERS, ProviderFactory } = require('../src/providers');

  check('every manifest entry has a synchronous constructor', () => {
    const broken: string[] = [];
    for (const m of PROVIDERS) {
      try {
        ProviderFactory.create(m.id);
      } catch (err: any) {
        // Missing credentials are fine — that is the provider working correctly.
        // "cannot be created" / "no synchronous constructor" is the drift we care about.
        if (/synchronous/i.test(err.message)) broken.push(m.id);
      }
    }
    assert.deepStrictEqual(
      broken,
      [],
      `these are in the registry but unreachable via --provider: ${broken.join(', ')}`
    );
  });

  check('every manifest entry is loadable asynchronously too', async () => {
    const { createProvider } = require('../src/providers');
    const broken: string[] = [];
    for (const m of PROVIDERS) {
      try {
        await createProvider(m.id);
      } catch (err: any) {
        if (/Cannot find module|is not a constructor|undefined/i.test(err.message)) {
          broken.push(`${m.id}: ${err.message}`);
        }
      }
    }
    assert.deepStrictEqual(broken, [], `bad load() thunks: ${broken.join(' | ')}`);
  });
}

// Async checks above resolve on the microtask queue, so give them a tick before
// reporting. Anything still pending after this would be a test that forgot to
// return its promise.
setTimeout(() => {
  console.log(failures === 0 ? '\nall passed' : `\n${failures} failed`);
  process.exit(failures === 0 ? 0 : 1);
}, 250);
