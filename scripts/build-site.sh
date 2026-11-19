#!/bin/sh
# Build sic-app.com as one website: the landing and privacy pages from site/ at the top, and the
# web version of the app under /app (sign in at /app/sign-in). Output: .site-build/
#   sh scripts/build-site.sh            build only
#   sh scripts/build-site.sh --deploy   build, then put it live on Vercel (project sic-site)
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/.site-build"
[ -d /opt/homebrew/opt/node@22/bin ] && export PATH="/opt/homebrew/opt/node@22/bin:$PATH"

rm -rf "$OUT"
mkdir -p "$OUT"

# 1. The landing page, privacy page, images and font.
(cd "$ROOT/site" && tar --exclude .vercel --exclude .gitignore --exclude vercel.json -cf - .) | (cd "$OUT" && tar -xf -)

# 2. The app, built for the web. app.json's experiments.baseUrl ("/app") makes it expect to live here.
(cd "$ROOT/apps/mobile" && npx expo export -p web --output-dir "$OUT/app")

# 3. Vercel: files first; any other /app address is a page of the app, so it gets the app's index.html.
cat > "$OUT/vercel.json" <<'EOF'
{
  "cleanUrls": true,
  "trailingSlash": false,
  "rewrites": [
    { "source": "/g/:token", "destination": "/guest" },
    { "source": "/app", "destination": "/app/index.html" },
    { "source": "/app/:path*", "destination": "/app/index.html" }
  ],
  "headers": [{ "source": "/g/:token", "headers": [{ "key": "X-Robots-Tag", "value": "noindex" }, { "key": "Referrer-Policy", "value": "no-referrer" }] }]
}
EOF

# The same rules for trying it locally with `npx serve .site-build`.
cat > "$OUT/serve.json" <<'EOF'
{
  "cleanUrls": true,
  "rewrites": [
    { "source": "/g/*", "destination": "/guest.html" },
    { "source": "/app", "destination": "/app/index.html" },
    { "source": "/app/**", "destination": "/app/index.html" }
  ]
}
EOF

echo "Built $OUT"

if [ "$1" = "--deploy" ]; then
  cp -R "$ROOT/site/.vercel" "$OUT/.vercel"
  (cd "$OUT" && npx vercel deploy --prod --yes)
fi
