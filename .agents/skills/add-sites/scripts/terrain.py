"""Terrain around launches, from AWS Terrain Tiles (terrarium PNGs, zoom 14, about 10 m USGS data in the US).

Usage:
  python3 -I terrain.py <cache_dir> launch <lat> <lon> [facing]
      One launch. Without a facing, it estimates one (the bearing with the biggest drop).
  python3 -I terrain.py <cache_dir> sites <sites.json> [id_prefix]
      Every launch with a direction, optionally only ids starting with id_prefix.

For each launch it prints the facing, the face's height (the biggest drop within 800 m downwind,
starting up to 400 m ahead of the pin), its steepest 100 m, its length across the wind (where the
face is at least half as high), the highest ground out to 5 km upwind relative to the top, and a
soaring suggestion. Needs Pillow.
"""

from __future__ import annotations

import json
import math
import os
import sys
import urllib.request

from PIL import Image

ZOOM = 14
USER_AGENT = "will-it-fly site curation"
TILE_URL = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"

# Calibrated on the Pawnee launches (all soarable, 55-90 m faces at 17-25 degrees) on 2026-11-09.
# Faces taller than MOUNTAIN_M are mountain sites, where soaring depends on local winds the
# terrain can't show: Golden and Boulder look like Douglas Pass and Peak 6 but don't soar.
SOAR_MIN_HEIGHT_M = 40
SOAR_MIN_STEEP_DEG = 15
SOAR_MIN_LENGTH_M = 400
MOUNTAIN_M = 150

_cache_dir = ""
_tiles: dict = {}


def pixel(lat: float, lon: float) -> tuple[float, float]:
    n = 2**ZOOM * 256
    x = (lon + 180) / 360 * n
    y = (1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * n
    return x, y


def tile(tx: int, ty: int):
    if (tx, ty) not in _tiles:
        path = os.path.join(_cache_dir, f"{ZOOM}_{tx}_{ty}.png")
        if not os.path.exists(path):
            url = TILE_URL.format(z=ZOOM, x=tx, y=ty)
            request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(request, timeout=30) as response, open(path, "wb") as f:
                f.write(response.read())
        _tiles[(tx, ty)] = Image.open(path).convert("RGB").load()
    return _tiles[(tx, ty)]


def pixel_elevation(gx: int, gy: int) -> float:
    r, g, b = tile(gx // 256, gy // 256)[gx % 256, gy % 256]
    return r * 256 + g + b / 256 - 32768


def elevation(lat: float, lon: float) -> float:
    """Bilinear elevation in metres."""
    x, y = pixel(lat, lon)
    x0, y0 = math.floor(x - 0.5), math.floor(y - 0.5)
    fx, fy = x - 0.5 - x0, y - 0.5 - y0
    top = pixel_elevation(x0, y0) * (1 - fx) + pixel_elevation(x0 + 1, y0) * fx
    bottom = pixel_elevation(x0, y0 + 1) * (1 - fx) + pixel_elevation(x0 + 1, y0 + 1) * fx
    return top * (1 - fy) + bottom * fy


def offset(lat: float, lon: float, bearing: float, metres: float) -> tuple[float, float]:
    b = math.radians(bearing)
    return (
        lat + metres * math.cos(b) / 111_320,
        lon + metres * math.sin(b) / (111_320 * math.cos(math.radians(lat))),
    )


def face_metrics(lat: float, lon: float, facing: float) -> tuple[float, float, int, float]:
    """Height, steepest 100 m in degrees, distance to the foot, and elevation at the top."""
    profile = [(d, elevation(*offset(lat, lon, facing, d))) for d in range(-200, 1501, 10)]
    height, start, foot, top = 0.0, 0, 0, profile[0][1]
    for i, (ds, es) in enumerate(profile):
        if ds > 400:
            break
        low_e, low_d = min(((e, d) for d, e in profile[i + 1 :] if d - ds <= 800), default=(es, ds))
        if es - low_e > height:
            height, start, foot, top = es - low_e, ds, low_d, es
    steep = 0.0
    face = [(d, e) for d, e in profile if start <= d <= foot]
    for i, (d1, e1) in enumerate(face):
        for d2, e2 in face[i + 1 :]:
            if d2 - d1 >= 100:
                steep = max(steep, math.degrees(math.atan2(e1 - e2, d2 - d1)))
                break
    return height, steep, foot, top


def estimate_facing(lat: float, lon: float) -> float:
    """The bearing with the biggest drop, to the nearest degree."""
    def drop(bearing: float) -> float:
        return face_metrics(lat, lon, bearing)[0]

    coarse = max(range(0, 360, 10), key=drop)
    return max(((coarse + d) % 360 for d in range(-9, 10)), key=drop)


def length(lat: float, lon: float, facing: float, height: float) -> int:
    total = 0
    for side in (facing - 90, facing + 90):
        run = 0
        for s in range(100, 3001, 100):
            if face_metrics(*offset(lat, lon, side, s), facing)[0] < height / 2:
                break
            run = s
        total += run
    return total


def upwind(lat: float, lon: float, facing: float, top: float, foot: int) -> float:
    return max(elevation(*offset(lat, lon, facing, d)) - top for d in range(foot + 100, 5001, 100))


def suggestion(height: float, steep: float, span: int, rise: float) -> str:
    if height > MOUNTAIN_M:
        return "mountain face: terrain can't tell, ask"
    if height < SOAR_MIN_HEIGHT_M or steep < SOAR_MIN_STEEP_DEG:
        return "too low or gentle for ridge lift"
    if span < SOAR_MIN_LENGTH_M:
        return "short face: wind may go round it, ask"
    if rise > 0:
        return "higher ground upwind: ask"
    return "looks soarable, ask"


def measure(lat: float, lon: float, facing: float | None) -> dict:
    estimated = facing is None
    if facing is None:
        facing = estimate_facing(lat, lon)
    height, steep, foot, top = face_metrics(lat, lon, facing)
    span = length(lat, lon, facing, height)
    rise = upwind(lat, lon, facing, top, foot)
    return {
        "facing": round(facing),
        "facingEstimated": estimated,
        "heightM": round(height),
        "heightFt": round(height * 3.28084),
        "steepestDeg": round(steep),
        "lengthM": span,
        "upwindM": round(rise),
        "suggestion": suggestion(height, steep, span, rise),
    }


def arcs_facing(launch: dict) -> float | None:
    arcs = launch["directions"]["ideal"] or launch["directions"]["ok"]
    if not arcs:
        return None
    arc = max(arcs, key=lambda a: (a["to"] - a["from"]) % 360)
    return (arc["from"] + ((arc["to"] - arc["from"]) % 360) / 2) % 360


def print_row(name: str, m: dict, soaring: str = "") -> None:
    facing = f"{m['facing']}{'*' if m['facingEstimated'] else ''}"
    print(
        f"{name:44} {soaring:6} {facing:>5} {m['heightM']:4} m {m['steepestDeg']:3}° "
        f"{m['lengthM']:5} m {m['upwindM']:+5} m  {m['suggestion']}"
    )


def main() -> None:
    global _cache_dir
    _cache_dir, mode = sys.argv[1], sys.argv[2]
    os.makedirs(_cache_dir, exist_ok=True)
    print(f"{'launch':44} {'soar':6} {'faces':>5} {'height':>6} {'steep':>4} {'length':>7} {'upwind':>7}  suggestion")
    if mode == "launch":
        lat, lon = float(sys.argv[3]), float(sys.argv[4])
        facing = float(sys.argv[5]) if len(sys.argv) > 5 else None
        print_row(f"{lat},{lon}", measure(lat, lon, facing))
    else:
        prefix = sys.argv[4] if len(sys.argv) > 4 else ""
        for site in json.load(open(sys.argv[3]))["sites"]:
            if not site["id"].startswith(prefix):
                continue
            soar = site.get("soaring")
            for launch in site["launches"]:
                marked = soar is not None and launch["id"] in soar.get("launchIds", [launch["id"]])
                c = launch["coordinate"]
                m = measure(c["latitude"], c["longitude"], arcs_facing(launch))
                print_row(launch["id"], m, "yes" if marked else "-")
    print("* facing estimated from the terrain")


if __name__ == "__main__":
    main()
