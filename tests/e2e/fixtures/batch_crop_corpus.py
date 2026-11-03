"""Create one detectable photographed page and one blank scan for batch crop e2e."""
from __future__ import annotations

import io
import sys
from pathlib import Path

import numpy as np
import pikepdf

sys.path.insert(0, sys.argv[1])
sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "core" / "tests"))
from pageimg_support import page_image_pdf_bytes, photo_scene

scene = photo_scene(size=(1200, 900), noise=20, skin_blob=True)
good = pikepdf.open(io.BytesIO(page_image_pdf_bytes(scene.rgb)[0]))
blank = pikepdf.open(io.BytesIO(page_image_pdf_bytes(np.full((900, 700, 3), 250, np.uint8))[0]))
good.pages.append(blank.pages[0])
good.save(Path(sys.argv[2]))
