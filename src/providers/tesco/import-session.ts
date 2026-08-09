/**
 * Tesco Session Import
 *
 * Fallback for when Playwright login is blocked by Akamai.
 * User exports cookies from Chrome DevTools (Application > Cookies > Export)
 * and passes the JSON file here — we write it to ~/.tesco/session.json.
 *
 * Usage:
 *   npm run groc -- --provider tesco import-session --file ~/Downloads/tesco-cookies.json
 *
 * How to export cookies from Chrome:
 *   1. Log in to tesco.com manually in Chrome
 *   2. Open DevTools (F12)
 *   3. Application tab > Storage > Cookies > https://www.tesco.com
 *   4. Right-click > Export (or use "Cookie Editor" extension)
 *   5. Save as JSON file and pass to --file flag
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { inferSessionExpiry, saveSession, TescoSession } from './auth';

export function importSession(filePath: string): void {
  const resolved = filePath.startsWith('~')
    ? path.join(os.homedir(), filePath.slice(1))
    : path.resolve(filePath);

  if (!fs.existsSync(resolved)) {
    throw new Error(`Cookie file not found: ${resolved}`);
  }

  const raw = JSON.parse(fs.readFileSync(resolved, 'utf-8'));

  // Normalise — Chrome DevTools exports an array; "Cookie Editor" exports
  // { [domain]: cookie[] } or an array with slightly different shape.
  let cookies: any[];

  if (Array.isArray(raw)) {
    cookies = raw;
  } else if (raw.cookies && Array.isArray(raw.cookies)) {
    cookies = raw.cookies;
  } else {
    // Try to flatten object-of-arrays format
    cookies = Object.values(raw).flat() as any[];
  }

  if (cookies.length === 0) {
    throw new Error('No cookies found in the file. Check the export format.');
  }

  // Normalise cookie shape to match Playwright format
  const normalised = cookies.map((c: any) => ({
    name: c.name || c.Name,
    value: c.value || c.Value,
    domain: c.domain || c.Domain || '.tesco.com',
    path: c.path || c.Path || '/',
    expires: c.expirationDate || c.expires || -1,
    httpOnly: c.httpOnly || c.HttpOnly || false,
    secure: c.secure || c.Secure || false,
    sameSite: c.sameSite || c.SameSite || 'Lax',
  }));

  const validCookies = normalised.filter((c: any) => c.name && c.value);

  if (validCookies.length === 0) {
    throw new Error('No usable cookies found in the file. Check the export includes name/value fields.');
  }

  const session: TescoSession = {
    cookies: validCookies,
    expiresAt: inferSessionExpiry(validCookies),
    lastLogin: new Date().toISOString(),
  };

  saveSession(session);
  console.log(`✅ Imported ${validCookies.length} cookies — Tesco session ready until ${session.expiresAt}`);
}

/**
 * Import from a raw `Cookie:` request header.
 *
 * Added because exporting cookies via a browser extension turned out to be the
 * single worst step in onboarding — extension UIs differ, some have no export at
 * all, and the one thing everyone can reliably do is copy a request header out
 * of DevTools.
 *
 * It is also strictly more complete than `document.cookie`, which omits HttpOnly
 * cookies — and Tesco's session cookies are HttpOnly, so the console trick that
 * looks like it should work silently produces a useless session.
 *
 *   DevTools → Network → any tesco.com request → Headers → Request Headers
 *   → right-click the `Cookie` value → Copy value
 */
export function importSessionFromHeader(header: string): void {
  const cleaned = header
    .trim()
    .replace(/^Cookie:\s*/i, '')   // tolerate the header name being copied too
    .replace(/^["']|["']$/g, '');   // and surrounding quotes

  const cookies = cleaned
    .split(';')
    .map(pair => pair.trim())
    .filter(Boolean)
    .map(pair => {
      const eq = pair.indexOf('=');
      if (eq === -1) return null;
      return {
        name: pair.slice(0, eq).trim(),
        // Values legitimately contain '=', so only split on the first one.
        value: pair.slice(eq + 1).trim(),
        domain: '.tesco.com',
        path: '/',
        // A request header carries no expiry, so fall back to the default TTL.
        expires: -1,
        httpOnly: false,
        secure: true,
        sameSite: 'Lax' as const,
      };
    })
    .filter((c): c is NonNullable<typeof c> => c !== null && !!c.name && !!c.value);

  if (cookies.length === 0) {
    throw new Error(
      'No cookies parsed from that header.\n' +
      'Expected something like: name=value; name2=value2; ...\n' +
      'In DevTools → Network, pick a tesco.com request, then Request Headers → Cookie.'
    );
  }

  const session: TescoSession = {
    cookies,
    expiresAt: inferSessionExpiry(cookies),
    lastLogin: new Date().toISOString(),
  };

  saveSession(session);
  console.log(`✅ Imported ${cookies.length} cookies from header — Tesco session ready until ${session.expiresAt}`);
}
