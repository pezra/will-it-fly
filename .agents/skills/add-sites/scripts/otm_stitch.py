"""Fetch OpenTopoMap tiles around a launch and stitch them, with the launch marked in red.

Usage: python3 -I otm_stitch.py <lat> <lon> <out_dir>

Writes <out_dir>/stitched16.png and stitched15.png (3x3 tiles each, upscaled 2x) and
prints the metres per stitched pixel. Needs Pillow and curl.
"""

from __future__ import annotations

import math
import os
import subprocess
import sys

from PIL import Image, ImageDraw

USER_AGENT = "will-it-fly site curation"
SCALE = 2


def tile(lat: float, lon: float, zoom: int) -> tuple[float, float]:
    n = 2**zoom
    x = (lon + 180) / 360 * n
    y = (1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * n
    return x, y


def fetch(path: str, zoom: int, x: int, y: int) -> None:
    if os.path.exists(path) and os.path.getsize(path) > 0:
        return
    for host in "abc":
        url = f"https://{host}.tile.opentopomap.org/{zoom}/{x}/{y}.png"
        result = subprocess.run(["curl", "-sf", "-m", "30", "-A", USER_AGENT, "-o", path, url])
        if result.returncode == 0:
            return
    raise SystemExit(f"could not fetch tile {zoom}/{x}/{y}")


def stitch(lat: float, lon: float, zoom: int, out_dir: str) -> None:
    fx, fy = tile(lat, lon, zoom)
    cx, cy = int(fx), int(fy)
    image = Image.new("RGB", (768, 768))
    for i, x in enumerate((cx - 1, cx, cx + 1)):
        for j, y in enumerate((cy - 1, cy, cy + 1)):
            path = os.path.join(out_dir, f"{zoom}_{x}_{y}.png")
            fetch(path, zoom, x, y)
            image.paste(Image.open(path).convert("RGB"), (i * 256, j * 256))
    px, py = (fx - cx + 1) * 256, (fy - cy + 1) * 256
    ImageDraw.Draw(image).ellipse((px - 5, py - 5, px + 5, py + 5), outline=(255, 0, 0), width=3)
    image = image.resize((768 * SCALE, 768 * SCALE))
    out = os.path.join(out_dir, f"stitched{zoom}.png")
    image.save(out)
    metres = 156543.03 * math.cos(math.radians(lat)) / 2**zoom / SCALE
    print(f"{out}: launch at ({px * SCALE:.0f}, {py * SCALE:.0f}), {metres:.2f} m per pixel")


def main() -> None:
    lat, lon, out_dir = float(sys.argv[1]), float(sys.argv[2]), sys.argv[3]
    os.makedirs(out_dir, exist_ok=True)
    for zoom in (16, 15):
        stitch(lat, lon, zoom, out_dir)


if __name__ == "__main__":
    main()
