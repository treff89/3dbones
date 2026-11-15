"""Validate an exported STL: watertightness, volume, size, connected pieces.
   python3 test/e2e/check_stl.py model.stl [--phantom]   (--phantom: compare with the synthetic phantom ground truth; export with pegs OFF)"""
import sys, json
import numpy as np, trimesh

path = sys.argv[1]
m = trimesh.load(path, process=True)
out = {
    "triangles": int(len(m.faces)), "watertight": bool(m.is_watertight), "winding_consistent": bool(m.is_winding_consistent),
    "volume_mm3": float(m.volume), "bbox_mm": [float(x) for x in m.extents], "euler": int(m.euler_number),
}
parts = m.split(only_watertight=False)
out["pieces"] = len(parts)
out["piece_volumes_mm3"] = sorted([round(float(p.volume), 1) for p in parts], reverse=True)[:12]
if "--phantom" in sys.argv:
    # chiral bars: 20 (x) x 12 (y) x 6 (z) mm, common corner at the min corner, analytic volume 288 mm3
    bars = min(parts, key=lambda p: abs(p.volume - 288))
    ext = bars.extents
    off = (bars.center_mass - bars.bounds.mean(axis=0)) / ext
    out["bars"] = {"volume": float(bars.volume), "extents": [float(x) for x in ext], "centroid_offset": [float(x) for x in off]}
    out["bars_ok"] = bool(abs(ext[0] - 20) < 1.2 and abs(ext[1] - 12) < 1.2 and abs(ext[2] - 6) < 1.2 and (off < 0).all())
    sph = min(parts, key=lambda p: abs(p.volume - 2144.66))
    out["sphere"] = {"volume": float(sph.volume), "extents": [float(x) for x in sph.extents]}
    out["sphere_ok"] = bool(abs(sph.volume - 2144.66) / 2144.66 < 0.06)
print(json.dumps(out, indent=1))
