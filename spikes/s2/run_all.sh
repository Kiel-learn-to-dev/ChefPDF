#!/usr/bin/env bash
# Spike S2 (T1.09): content editing with the permissive stack (pypdfium2 + pikepdf),
# compared with PyMuPDF (AGPL, installed only into this spike venv via the "agpl" group).
# Usage: cd spikes && uv sync && bash s2/run_all.sh      (SKIP_AGPL=1 to skip PyMuPDF)
# Optional: poppler-utils (pdftotext) is used as an independent text extractor.
set -euo pipefail
cd "$(dirname "$0")/.."

run() { echo; echo "### $*"; uv run python -m "$@"; }

run s2.make_corpus     # 3-page Vietnamese corpus + ground truth
run s2.e1_objects      # enumerate / hit-test / move / scale / delete / GenerateContent
run s2.e2_watermark    # repeated watermark + logo detection and removal
run s2.e3_redact       # true redaction: naive PDFium vs recommended PDFium+pikepdf
run s2.e4_text_edit    # edit Vietnamese text with a subset font missing glyphs
run s2.e5_layout       # chars -> lines -> columns -> paragraphs

if [ "${SKIP_AGPL:-0}" != "1" ]; then
  echo; echo "### s2.pymupdf_compare (AGPL comparison)"
  uv run --group agpl python -m s2.pymupdf_compare
fi
echo; echo "Results: s2/out/*.json, renders: s2/out/*.png"
