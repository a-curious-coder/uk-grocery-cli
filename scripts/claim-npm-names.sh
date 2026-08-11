#!/usr/bin/env bash
#
# Claim the npm names for open-supermarkets.
#
# Run AFTER `npm login`. Verifies auth first, re-checks each name is still free,
# and skips anything already taken rather than failing the whole run.
#
#   ./scripts/claim-npm-names.sh          # dry run, shows what it would do
#   ./scripts/claim-npm-names.sh --publish
#
# `open-supermarkets` gets a PRERELEASE (3.0.0-rc.0). Prereleases do not become
# the `latest` dist-tag, so `npm install -g open-supermarkets` still fails until
# a real release — the name is reserved without shipping a half-finished tool
# from an unmerged branch.
#
# The other three are placeholders whose only job is to stop someone else taking
# a name that now appears in our README.

set -euo pipefail

PUBLISH=false
OTP=""
for arg in "$@"; do
  case "$arg" in
    --publish) PUBLISH=true ;;
    --otp=*)   OTP="${arg#--otp=}" ;;
  esac
done

# npm requires 2FA to publish. Passing --otp through means one authenticator code
# covers the whole run instead of npm prompting per package.
npm_publish() {
  if [[ -n "$OTP" ]]; then npm publish --access public --otp="$OTP" "$@"
  else npm publish --access public "$@"; fi
}

PRIMARY="open-supermarkets"
PRIMARY_VERSION="3.0.0"
DEFENSIVE=(open-supermarket supermarkets uk-grocery-cli)

REPO="https://github.com/abracadabra50/open-supermarkets"

who=$(npm whoami 2>/dev/null || true)
if [[ -z "$who" ]]; then
  echo "Not logged in to npm. Run:  npm login" >&2
  exit 1
fi
echo "npm user: $who"
$PUBLISH || echo "(dry run — pass --publish to actually publish; add --otp=123456 for 2FA)"
echo

is_free() {
  [[ "$(curl -s -o /dev/null -w '%{http_code}' "https://registry.npmjs.org/$1")" == "404" ]]
}

# ── primary ──────────────────────────────────────────────────────────────
if is_free "$PRIMARY"; then
  echo "→ $PRIMARY@$PRIMARY_VERSION"
  if $PUBLISH; then
    npm_publish
    echo "  published"
  fi
else
  echo "· $PRIMARY already exists — skipping"
fi

# ── defensive placeholders ───────────────────────────────────────────────
for name in "${DEFENSIVE[@]}"; do
  if ! is_free "$name"; then
    echo "· $name already exists — skipping"
    continue
  fi
  echo "→ $name@0.0.1  (placeholder pointing at $PRIMARY)"
  $PUBLISH || continue

  tmp=$(mktemp -d)
  cat > "$tmp/package.json" <<JSON
{
  "name": "$name",
  "version": "0.0.1",
  "description": "Name reserved for open-supermarkets. Install '$PRIMARY' instead.",
  "keywords": ["supermarket", "groceries", "placeholder"],
  "repository": { "type": "git", "url": "$REPO" },
  "license": "MIT",
  "author": "Zishan Ashraf"
}
JSON
  cat > "$tmp/README.md" <<MD
# $name

Placeholder. This name is reserved for [\`$PRIMARY\`]($REPO).

\`\`\`bash
npm install -g $PRIMARY
\`\`\`
MD
  (cd "$tmp" && npm_publish)
  rm -rf "$tmp"
  echo "  published"
done

echo
echo "Done."
