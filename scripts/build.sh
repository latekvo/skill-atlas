#!/bin/bash
# Build dist/index.html from src/atlas.html + data/*.json.
#
# src/atlas.html is authored in Claude-Artifact form: no <!doctype>/<html>/<head>,
# and with __SOURCE__ / __LINES__ placeholders where the data belongs. This script
# wraps it into a standalone document and injects data/source.json + data/lines.json,
# so the repo ref and the 216 line anchors live in exactly one place.
set -euo pipefail
cd "$(dirname "$0")/.."

SRC=src/atlas.html
OUT=dist/index.html
mkdir -p dist

for f in "$SRC" data/source.json data/lines.json; do
  [ -f "$f" ] || { echo "missing: $f" >&2; exit 1; }
done
python3 -c 'import json,sys;[json.load(open(f)) for f in sys.argv[1:]]' data/source.json data/lines.json \
  || { echo "data/*.json is not valid JSON" >&2; exit 1; }

TMP=$(mktemp)
trap 'rm -f "$TMP"' EXIT

{
  printf '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n'
  printf '<meta name="viewport" content="width=device-width,initial-scale=1">\n'
  printf '<style>:root{color-scheme:light}body{margin:0}img{max-width:100%%}[hidden]{display:none!important}</style>\n'
  grep -m1 '^<title>' "$SRC"
  grep -m1 '^<link rel="stylesheet" href="https://fonts.googleapis.com' "$SRC"
  printf '</head>\n<body>\n'
  grep -v -e '^<title>' -e '^<link rel="stylesheet" href="https://fonts.googleapis.com' "$SRC"
  printf '</body>\n</html>\n'
} > "$TMP"

python3 - "$TMP" <<'PY'
import json, sys, pathlib
p = pathlib.Path(sys.argv[1])
s = p.read_text()
for token, path in (("__SOURCE__", "data/source.json"), ("__LINES__", "data/lines.json")):
    if s.count(token) != 1:
        sys.exit("expected exactly one %s in the source, found %d" % (token, s.count(token)))
    s = s.replace(token, json.dumps(json.load(open(path)), separators=(",", ":")))
p.write_text(s)
PY

if grep -q '__SOURCE__\|__LINES__' "$TMP"; then
  echo "placeholder survived injection" >&2; exit 1
fi

mv "$TMP" "$OUT"
trap - EXIT
echo "built $OUT ($(wc -c < "$OUT" | tr -d ' ') bytes, $(grep -c 'class="src"' "$OUT") source-link template)"
