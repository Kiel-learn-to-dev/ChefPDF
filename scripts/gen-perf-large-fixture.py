# Generates a ~307 MB, 31-page JPEG image PDF (random noise, incompressible) for e2e-native-perf-large.ps1.
# Usage: uv run --no-project --with numpy --with pillow --with img2pdf python scripts/gen-perf-large-fixture.py <out.pdf>
import sys, os, io
import numpy as np
from PIL import Image
import img2pdf
rng=np.random.default_rng(1)
out=sys.argv[1]; pages=31
imgs=[]
for i in range(pages):
    a=rng.integers(0,256,(3300,2550,3),dtype=np.uint8)
    b=io.BytesIO(); Image.fromarray(a).save(b,'JPEG',quality=95); imgs.append(b.getvalue())
lay=img2pdf.get_layout_fun((img2pdf.in_to_pt(8.5),img2pdf.in_to_pt(11)))
open(out,'wb').write(img2pdf.convert(imgs,layout_fun=lay))
print(os.path.getsize(out)/1e6,'MB')


