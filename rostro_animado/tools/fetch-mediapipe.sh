#!/usr/bin/env bash
# tools/fetch-mediapipe.sh — Materializa los binarios MediaPipe en
# assets/vendor/mediapipe/ (F2: sin ellos, MpLoader/track.worker devuelven 404).
#
# Uso:  bash tools/fetch-mediapipe.sh [version]     (default: 0.10.14)
# Idempotente: no re-descarga archivos ya presentes.
set -euo pipefail

MPV="${1:-0.10.14}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$ROOT/assets/vendor/mediapipe"
PKG="https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@$MPV"
MODEL="https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task"

mkdir -p "$DEST/wasm"

fetch() { # fetch <url> <dest>
  if [ -s "$2" ]; then echo "ok(existente) $2"; return 0; fi
  echo "descargando  $1"
  curl -fsSL --retry 3 --connect-timeout 15 -o "$2" "$1"
}

# Lista canónica de @mediapipe/tasks-vision (verificada contra data.jsdelivr.com):
# el paquete NO incluye vision_wasm_module.* — solo internal y nosimd_internal.
fetch "$PKG/vision_bundle.mjs"        "$DEST/vision_bundle.mjs"
fetch "$PKG/wasm/vision_wasm_internal.js"   "$DEST/wasm/vision_wasm_internal.js"
fetch "$PKG/wasm/vision_wasm_internal.wasm" "$DEST/wasm/vision_wasm_internal.wasm"
fetch "$PKG/wasm/vision_wasm_nosimd_internal.js"   "$DEST/wasm/vision_wasm_nosimd_internal.js"
fetch "$PKG/wasm/vision_wasm_nosimd_internal.wasm" "$DEST/wasm/vision_wasm_nosimd_internal.wasm"
fetch "$MODEL" "$DEST/face_landmarker.task"

echo "--- verificación ---"
for f in "$DEST/vision_bundle.mjs" "$DEST/face_landmarker.task" \
         "$DEST/wasm/vision_wasm_internal.wasm" "$DEST/wasm/vision_wasm_internal.js"; do
  [ -s "$f" ] || { echo "FALTA: $f"; exit 1; }
done
grep -q "FilesetResolver" "$DEST/vision_bundle.mjs" || { echo "bundle inválido"; exit 1; }
echo "Listo: MediaPipe $MPV en assets/vendor/mediapipe/"
