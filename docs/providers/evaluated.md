# Providers evaluated and not built

Before spending a weekend on a supermarket, check here. Each entry says what was
probed, what came back, and what would have to change for it to become viable.

Rejections are dated, because bot defences and APIs both move. A "no" from a year ago
is a reason to re-probe, not a reason to stop.

| Provider | Country | Verdict | Blocker |
|---|---|---|---|
| REWE | DE | blocked | mTLS client certificates extracted from the APK |
| Jumbo | NL | blocked | Akamai; connection refused outright |
| Picnic | NL | unknown | endpoint not found; needs real discovery |
| DoorDash | US | not worth it | active Cloudflare challenge; official API is merchant-side |

---

## REWE (Germany) — blocked, 2026-08-03

Looked like the best target on paper: [ByteSizedMarius/rewerse-engineering](https://github.com/ByteSizedMarius/rewerse-engineering)
is 78★ and actively maintained. Star count and commit recency measure *effort*, not
*accessibility*. From its own README:

> The certificates required for talking to the rewe api are not included in this
> repository. You need to extract them from the APK.

The API is `mobile-api.rewe.de` behind **mutual TLS**. The other headers are easy —
`rdfa` is a generated UUID, plus `correlation-id`, `rd-postcode`, `ruleversion` and a
REWE-Mobile-Client UA. The client certificate is the wall, and it is neither
redistributable nor stable across app releases.

**What would change this:** a contributor willing to extract certs themselves and
keep them current, with a documented, legally clean extraction path. Not something
this repo can ship.

## Jumbo (Netherlands) — blocked, 2026-08-03

`mobileapi.jumbo.com` resolves (Akamai, `95.101.253.189`) but the connection is
refused before HTTP — `curl` returns 000, so it is a TLS-layer rejection rather than
a status code. Likely certificate pinning or TLS fingerprinting.

**What would change this:** evidence of a client that connects successfully, to
compare handshakes against.

## Picnic (Netherlands) — unknown, 2026-08-03

Guessed `storefront-prod.nl.picnicinternational.com/api/15/search`, got a clean
`NOT_FOUND` JSON body — the host is right and answering, the path or API version is
wrong. Only prior art found was a 1★ Perl library, too thin to mine.

**What would change this:** proper endpoint discovery from a current app build. This
is the most likely of the three to turn out viable; it was deprioritised, not ruled
out.

## DoorDash (US) — not worth it, 2026-08-03

Three problems at once, any one of which would be enough:

**Active bot challenge.** `www.doordash.com` returns `cf-mitigated: challenge` with
`server: cloudflare`. Both `www.doordash.com/graphql` and
`consumer-mobile-bff.doordash.com/graphql` return 403. That is an interactive
challenge, not a passive rule — harder than the AWS WAF that already defeats Ocado's
checkout.

**The official API points the wrong way.** The [Marketplace and Item Management
APIs](https://developer.doordash.com/en-US/api/marketplace_v2/) exist so *merchants
can publish their catalogue into DoorDash* — add items, manage inventory and pricing.
There is no sanctioned consumer-side product search or cart. Drive is for requesting
deliveries, not for shopping.

**No community protocol knowledge.** Every `doordash api` repo is DoorDash's own
merchant sample code (3-6★, 2-3 years stale). The scrapers are abandoned 0-2★
projects. Nothing like the Instacart or Albert Heijn work exists to build on.

**What would change this:** DoorDash shipping a consumer-facing API. Until then,
Instacart covers the US with both a sanctioned path and a documented unofficial one.

---

## The pattern worth internalising

Albert Heijn is the exception, not the template. It hands an anonymous bearer token to
anyone who asks, which is why that provider is ~150 lines and needs no account.

Most chains defend the catalogue about as hard as the checkout. So when picking a
target, the useful signals are, in order:

1. **Does an anonymous or open catalogue endpoint exist?** This decides everything.
2. **Is there an official API pointing at shoppers** rather than at merchants?
3. **Is there recent reverse-engineering work** — and does it require anything
   non-redistributable, like certificates?
4. Star counts on a reverse-engineering repo measure how hard the problem was, not
   how easy it will be for you.
