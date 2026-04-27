#!/usr/bin/env python3
"""
Helvarix Advanced Fabricator - Fast Load-Path Density Solver

Drop-in replacement for services/solver-fenics/topology.py.
Reads JSON from stdin and returns density[nx][ny][nz].
This is intentionally fast enough for Render free tier and produces a topology-like
branching density field that the generation engine can turn into an organic bracket.
"""
from __future__ import annotations

import json, math, sys, traceback
from typing import Any, Dict, List, Tuple

ENGINE_NAME = "fast-loadpath-density-topology-v4"


def clamp(v: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, v))


def read_input() -> Dict[str, Any]:
    raw = sys.stdin.read()
    if len(sys.argv) > 1 and sys.argv[1].strip():
        raw = sys.argv[1]
    return json.loads(raw) if raw.strip() else {}


def gaussian(px: float, py: float, cx: float, cy: float, sigma: float) -> float:
    d2 = (px - cx) ** 2 + (py - cy) ** 2
    return math.exp(-d2 / max(2 * sigma * sigma, 1e-9))


def dist_to_segment(px: float, py: float, ax: float, ay: float, bx: float, by: float) -> float:
    abx, aby = bx - ax, by - ay
    apx, apy = px - ax, py - ay
    denom = abx * abx + aby * aby
    if denom <= 1e-12:
        return math.hypot(px - ax, py - ay)
    t = clamp((apx * abx + apy * aby) / denom, 0.0, 1.0)
    qx, qy = ax + abx * t, ay + aby * t
    return math.hypot(px - qx, py - qy)


def bolt_centers(count: int) -> List[Tuple[float, float]]:
    count = int(clamp(round(count), 1, 8))
    y = 0.15
    if count == 1:
        xs = [0.5]
    else:
        span = clamp(0.46 + 0.045 * (count - 2), 0.46, 0.76)
        xs = [0.5 - span / 2 + span * i / (count - 1) for i in range(count)]
    return [(x, y) for x in xs]


def smooth_2d(a: List[List[float]], passes: int) -> List[List[float]]:
    nx, ny = len(a), len(a[0]) if a else 0
    cur = [row[:] for row in a]
    for _ in range(passes):
        nxt = [[0.0 for _ in range(ny)] for _ in range(nx)]
        for x in range(nx):
            for y in range(ny):
                s = 0.0; w = 0.0
                for dx in (-1,0,1):
                    for dy in (-1,0,1):
                        xx, yy = x+dx, y+dy
                        if 0 <= xx < nx and 0 <= yy < ny:
                            ww = 4.0 if dx == 0 and dy == 0 else 2.0 if dx == 0 or dy == 0 else 1.0
                            s += cur[xx][yy] * ww
                            w += ww
                nxt[x][y] = s / max(w, 1.0)
        cur = nxt
    return cur


def quantile_threshold(values: List[float], target_solid_fraction: float) -> float:
    vals = sorted(values)
    if not vals:
        return 0.5
    idx = int(clamp(math.floor((1.0 - target_solid_fraction) * (len(vals) - 1)), 0, len(vals) - 1))
    return vals[idx]


def build_density(data: Dict[str, Any]):
    nx = int(clamp(int(data.get("nx", 48)), 24, 96))
    ny = int(clamp(int(data.get("ny", 48)), 24, 96))
    nz = int(clamp(int(data.get("nz", 14)), 6, 32))
    bolt_count = int(clamp(int(data.get("boltCount", 2)), 1, 8))
    force_n = float(data.get("forceN", 2500))
    safety = float(data.get("safetyFactor", 1.5))
    load_direction = str(data.get("loadDirection", "vertical")).lower()
    target_open = clamp(float(data.get("targetOpenAreaPercent", 60)), 42.0, 76.0)
    target_solid = clamp(1.0 - target_open / 100.0, 0.24, 0.56)

    bolts = bolt_centers(bolt_count)
    load_y = 0.88
    load_points = [(0.38, load_y), (0.5, load_y), (0.62, load_y)]
    if load_direction == "lateral":
        load_points = [(0.86, 0.42), (0.86, 0.58), (0.86, 0.72)]

    bx = sum(p[0] for p in bolts) / len(bolts)
    by = sum(p[1] for p in bolts) / len(bolts)
    lx = sum(p[0] for p in load_points) / len(load_points)
    ly = sum(p[1] for p in load_points) / len(load_points)
    hub = (0.5 * lx + 0.5 * bx, by + (ly - by) * 0.55)
    lower_hub = (bx, by + 0.15)

    load_scale = clamp(force_n * safety / 3750.0, 0.8, 1.8)
    path_sigma = 0.045 * load_scale
    pad_sigma = 0.052
    raw = [[0.0 for _ in range(ny)] for _ in range(nx)]

    for ix in range(nx):
        x = (ix + 0.5) / nx
        for iy in range(ny):
            y = (iy + 0.5) / ny
            score = 0.0
            # Required support/load lands.
            score += max(gaussian(x, y, px, py, pad_sigma) for px, py in bolts) * 0.85
            score += max(gaussian(x, y, px, py, pad_sigma * 1.1) for px, py in load_points) * 0.82
            # Primary load paths: bolts -> hub -> load.
            for px, py in bolts:
                d1 = dist_to_segment(x, y, px, py, hub[0], hub[1])
                d2 = dist_to_segment(x, y, hub[0], hub[1], lx, ly)
                score += math.exp(-(d1 * d1) / (2 * path_sigma * path_sigma)) * 0.72
                score += math.exp(-(d2 * d2) / (2 * (path_sigma * 0.9) ** 2)) * 0.55
                d3 = dist_to_segment(x, y, px, py, lower_hub[0], lower_hub[1])
                score += math.exp(-(d3 * d3) / (2 * (path_sigma * 0.75) ** 2)) * 0.34
            # Bottom tension tie.
            if len(bolts) >= 2:
                left, right = bolts[0], bolts[-1]
                db = dist_to_segment(x, y, left[0], left[1], right[0], right[1])
                score += math.exp(-(db * db) / (2 * (path_sigma * 0.65) ** 2)) * 0.32
            # Remove big central blob and corners.
            center_void = gaussian(x, y, 0.5, by + (ly-by)*0.37, 0.13)
            score -= center_void * 0.28
            half_width = 0.47 - 0.16 * y
            if abs(x - 0.5) > half_width:
                score -= 0.8
            if y > 0.84 and abs(x - 0.5) > 0.25:
                score -= 0.7
            raw[ix][iy] = clamp(score, 0.0, 1.0)

    sm = smooth_2d(raw, 2)
    flat = [v for col in sm for v in col]
    th = quantile_threshold(flat, target_solid)
    density = []
    solid = 0; total = nx*ny*nz; avg = 0.0
    bolt_radius = 0.032
    for ix in range(nx):
        plane = []
        x = (ix + 0.5) / nx
        for iy in range(ny):
            row = []
            y = (iy + 0.5) / ny
            base = clamp((sm[ix][iy] - th) * 3.0 + 0.5, 0.0, 1.0)
            # Bolt holes must remain open.
            for bx0, by0 in bolts:
                if math.hypot(x - bx0, y - by0) < bolt_radius:
                    base = 0.0
            for iz in range(nz):
                z = abs((iz + 0.5) / nz - 0.5) * 2.0
                z_factor = clamp(1.0 - max(0.0, z - 0.76) * 1.7, 0.18, 1.0)
                v = clamp(base * z_factor, 0.0, 1.0)
                row.append(round(v, 4))
                avg += v
                if v > 0.5:
                    solid += 1
            plane.append(row)
        density.append(plane)

    meta = {
        "targetOpenAreaPercent": target_open,
        "solidFraction": solid / max(total, 1),
        "averageDensity": avg / max(total, 1),
        "boltCentersNormalized": bolts,
        "loadDirection": load_direction,
        "forceN": force_n,
        "safetyFactor": safety,
        "note": "Fast density field for production UI; replace with validated FEA/SIMP once solver runtime is acceptable."
    }
    return density, meta


def main():
    data = read_input()
    density, meta = build_density(data)
    print(json.dumps({
        "ok": True,
        "engine": ENGINE_NAME,
        "density": density,
        "nx": len(density),
        "ny": len(density[0]) if density else 0,
        "nz": len(density[0][0]) if density and density[0] else 0,
        "meta": meta,
    }, separators=(",", ":")))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(json.dumps({"ok": False, "engine": ENGINE_NAME, "error": str(exc), "traceback": traceback.format_exc()}))
        sys.exit(1)
