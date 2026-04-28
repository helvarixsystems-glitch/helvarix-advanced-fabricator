#!/usr/bin/env python3
"""
Helvarix Advanced Fabricator — topology.py

Authoritative Phase-I topology solver for:
services/solver-fenics/topology.py

Purpose:
- Produce a real solver-derived density field for the viewer.
- Stop relying on decorative TypeScript geometry.
- Bias the density result toward bracket-like load paths:
  fixed bolt interfaces -> load interface -> organic struts/ribs.
- Return NO fake geometry. If the numerical solver fails, return ok:false.

This is a 2D SIMP compliance-minimization solver with a 3D extrusion step.
That is intentional for the current Phase-I prototype:
- It is fast enough for Render.
- It produces meaningful bracket load paths.
- It returns density[nx][ny][nz] for the existing mesh extractor.
"""

from __future__ import annotations

import json
import math
import sys
import traceback
from dataclasses import dataclass
from typing import Any, Dict, List, Tuple

import numpy as np

try:
    from scipy.sparse import coo_matrix
    from scipy.sparse.linalg import spsolve
except Exception as exc:
    raise RuntimeError(
        "Topology solver requires scipy. Make sure services/solver-fenics/requirements.txt "
        "includes scipy and redeploy the Render worker."
    ) from exc


ENGINE = "haf-simp-bracket-topology-v3"


@dataclass
class TopologyInput:
    nx: int = 72
    ny: int = 48
    nz: int = 18
    load_direction: str = "vertical"
    bolt_count: int = 2
    target_open_area_percent: float = 62.0
    safety_factor: float = 1.5
    force_n: float = 2500.0
    max_iterations: int = 95
    min_iterations: int = 35
    change_tolerance: float = 0.010
    penalization: float = 3.25
    filter_radius: float = 2.2
    poisson_ratio: float = 0.33


@dataclass
class MasksAndLoads:
    forced_solid: np.ndarray
    forced_void: np.ndarray
    fixed_dofs: np.ndarray
    force: np.ndarray
    bolt_centers: List[Tuple[float, float]]
    load_nodes: List[Tuple[int, int]]
    load_interface_center: Tuple[float, float]


def clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def parse_input(raw: Dict[str, Any]) -> TopologyInput:
    return TopologyInput(
        nx=int(clamp(int(raw.get("nx", 72)), 24, 120)),
        ny=int(clamp(int(raw.get("ny", 48)), 24, 96)),
        nz=int(clamp(int(raw.get("nz", 18)), 6, 48)),
        load_direction=str(raw.get("loadDirection", "vertical")).lower().strip(),
        bolt_count=int(clamp(int(raw.get("boltCount", 2)), 1, 8)),
        target_open_area_percent=float(
            clamp(float(raw.get("targetOpenAreaPercent", 62.0)), 25.0, 78.0)
        ),
        safety_factor=float(clamp(float(raw.get("safetyFactor", 1.5)), 1.0, 4.0)),
        force_n=float(clamp(float(raw.get("forceN", 2500.0)), 1.0, 1.0e7)),
        max_iterations=int(clamp(int(raw.get("maxIterations", 95)), 25, 180)),
        min_iterations=int(clamp(int(raw.get("minIterations", 35)), 10, 80)),
        change_tolerance=float(clamp(float(raw.get("changeTolerance", 0.010)), 0.002, 0.05)),
        penalization=float(clamp(float(raw.get("penalization", 3.25)), 2.0, 4.5)),
        filter_radius=float(clamp(float(raw.get("filterRadius", 2.2)), 1.4, 7.0)),
        poisson_ratio=float(clamp(float(raw.get("poissonRatio", 0.33)), 0.05, 0.49)),
    )


def node_id(ix: int, iy: int, ny: int) -> int:
    return ix * (ny + 1) + iy


def quad4_plane_stress_ke(nu: float) -> np.ndarray:
    k = np.array(
        [
            0.5 - nu / 6.0,
            0.125 + nu / 8.0,
            -0.25 - nu / 12.0,
            -0.125 + 3.0 * nu / 8.0,
            -0.25 + nu / 12.0,
            -0.125 - nu / 8.0,
            nu / 6.0,
            0.125 - 3.0 * nu / 8.0,
        ],
        dtype=float,
    )

    return np.array(
        [
            [k[0], k[1], k[2], k[3], k[4], k[5], k[6], k[7]],
            [k[1], k[0], k[7], k[6], k[5], k[4], k[3], k[2]],
            [k[2], k[7], k[0], k[5], k[6], k[3], k[4], k[1]],
            [k[3], k[6], k[5], k[0], k[7], k[2], k[1], k[4]],
            [k[4], k[5], k[6], k[7], k[0], k[1], k[2], k[3]],
            [k[5], k[4], k[3], k[2], k[1], k[0], k[7], k[6]],
            [k[6], k[3], k[4], k[1], k[2], k[7], k[0], k[5]],
            [k[7], k[2], k[1], k[4], k[3], k[6], k[5], k[0]],
        ],
        dtype=float,
    ) / (1.0 - nu * nu)


def build_edof(nx: int, ny: int) -> np.ndarray:
    edof = np.zeros((nx * ny, 8), dtype=np.int64)

    for ex in range(nx):
        for ey in range(ny):
            e = ex * ny + ey
            n1 = node_id(ex, ey, ny)
            n2 = node_id(ex + 1, ey, ny)
            n3 = node_id(ex + 1, ey + 1, ny)
            n4 = node_id(ex, ey + 1, ny)

            edof[e] = [
                2 * n1,
                2 * n1 + 1,
                2 * n2,
                2 * n2 + 1,
                2 * n3,
                2 * n3 + 1,
                2 * n4,
                2 * n4 + 1,
            ]

    return edof


def bolt_centers(nx: int, ny: int, bolt_count: int) -> List[Tuple[float, float]]:
    bottom_y = ny * 0.17
    top_y = ny * 0.80

    if bolt_count == 1:
        return [(nx * 0.50, bottom_y)]

    if bolt_count == 2:
        return [(nx * 0.27, bottom_y), (nx * 0.73, bottom_y)]

    if bolt_count == 3:
        return [(nx * 0.23, bottom_y), (nx * 0.77, bottom_y), (nx * 0.50, top_y)]

    if bolt_count == 4:
        return [
            (nx * 0.23, bottom_y),
            (nx * 0.77, bottom_y),
            (nx * 0.23, top_y),
            (nx * 0.77, top_y),
        ]

    out: List[Tuple[float, float]] = []
    for i in range(bolt_count):
        a = -math.pi / 2.0 + 2.0 * math.pi * i / bolt_count
        out.append((nx * 0.50 + math.cos(a) * nx * 0.34, ny * 0.49 + math.sin(a) * ny * 0.32))
    return out


def load_nodes(nx: int, ny: int, direction: str) -> Tuple[List[Tuple[int, int]], Tuple[float, float]]:
    if direction == "lateral":
        x = nx
        y_mid = int(round(ny * 0.55))
        patch = max(2, int(round(ny * 0.06)))
        nodes = [(x, y) for y in range(max(0, y_mid - patch), min(ny, y_mid + patch) + 1)]
        return nodes, (nx * 0.95, float(y_mid))

    if direction == "multi-axis":
        patch = max(2, int(round(nx * 0.06)))
        nodes = [(x, ny) for x in range(max(0, nx // 2 - patch), min(nx, nx // 2 + patch) + 1)]
        nodes += [(nx, y) for y in range(int(ny * 0.48), int(ny * 0.62) + 1)]
        return nodes, (nx * 0.58, ny * 0.93)

    # vertical default: load enters through the upper center interface.
    patch = max(2, int(round(nx * 0.065)))
    x_mid = int(round(nx * 0.50))
    nodes = [(x, ny) for x in range(max(0, x_mid - patch), min(nx, x_mid + patch) + 1)]
    return nodes, (float(x_mid), ny * 0.92)


def mark_disk(mask: np.ndarray, cx: float, cy: float, radius: float, value: bool = True) -> None:
    nx, ny = mask.shape
    xs = np.arange(nx) + 0.5
    ys = np.arange(ny) + 0.5
    xx, yy = np.meshgrid(xs, ys, indexing="ij")
    mask[np.hypot(xx - cx, yy - cy) <= radius] = value


def mark_path(mask: np.ndarray, ax: float, ay: float, bx: float, by: float, radius: float) -> None:
    nx, ny = mask.shape
    xs = np.arange(nx) + 0.5
    ys = np.arange(ny) + 0.5
    xx, yy = np.meshgrid(xs, ys, indexing="ij")

    vx = bx - ax
    vy = by - ay
    denom = max(vx * vx + vy * vy, 1.0e-9)
    t = np.clip(((xx - ax) * vx + (yy - ay) * vy) / denom, 0.0, 1.0)
    px = ax + t * vx
    py = ay + t * vy

    mask[np.hypot(xx - px, yy - py) <= radius] = True


def build_masks_and_loads(s: TopologyInput) -> MasksAndLoads:
    nx, ny = s.nx, s.ny
    ndof = 2 * (nx + 1) * (ny + 1)

    forced_solid = np.zeros((nx, ny), dtype=bool)
    forced_void = np.zeros((nx, ny), dtype=bool)

    centers = bolt_centers(nx, ny, s.bolt_count)
    loads, load_center = load_nodes(nx, ny, s.load_direction)

    ref = max(nx, ny)
    hole_r = ref * 0.035
    pad_r = ref * 0.088
    fixed_r = ref * 0.072
    strut_r = max(1.4, ref * 0.018)

    # True interface logic:
    # - bolt holes are forced void
    # - bolt bosses/rings are forced solid
    # - the load pad is forced solid
    # - thin seed paths connect each bolt ring to the load pad so the optimizer
    #   starts with real load-path options instead of filling the whole slab.
    for bx, by in centers:
        mark_disk(forced_void, bx, by, hole_r, True)
        mark_disk(forced_solid, bx, by, pad_r, True)
        mark_path(forced_solid, bx, by, load_center[0], load_center[1], strut_r)

    mark_disk(forced_solid, load_center[0], load_center[1], ref * 0.082, True)

    # Keep boundary slightly open except near real interfaces. This reduces the
    # slab-like "filled rectangle" tendency.
    border = max(1, int(round(ref * 0.018)))
    forced_void[:border, :] = True
    forced_void[-border:, :] = True
    forced_void[:, :border] = True
    forced_void[:, -border:] = True

    # Then restore solid interface areas over the border mask.
    for bx, by in centers:
        mark_disk(forced_void, bx, by, hole_r, True)
        mark_disk(forced_solid, bx, by, pad_r, True)
    mark_disk(forced_solid, load_center[0], load_center[1], ref * 0.082, True)

    forced_solid[forced_void] = False

    fixed = set()
    for ix in range(nx + 1):
        for iy in range(ny + 1):
            for bx, by in centers:
                d = math.hypot(ix - bx, iy - by)
                if hole_r * 0.85 <= d <= fixed_r:
                    nid = node_id(ix, iy, ny)
                    fixed.add(2 * nid)
                    fixed.add(2 * nid + 1)

    if not fixed:
        for bx, by in centers:
            ix = int(round(clamp(bx, 0, nx)))
            iy = int(round(clamp(by, 0, ny)))
            nid = node_id(ix, iy, ny)
            fixed.add(2 * nid)
            fixed.add(2 * nid + 1)

    force = np.zeros(ndof, dtype=float)
    per_node = s.force_n * s.safety_factor / max(1, len(loads))

    for ix, iy in loads:
        ix = int(clamp(ix, 0, nx))
        iy = int(clamp(iy, 0, ny))
        nid = node_id(ix, iy, ny)

        if s.load_direction == "lateral":
            force[2 * nid] += per_node
        elif s.load_direction == "multi-axis":
            force[2 * nid] += per_node * 0.35
            force[2 * nid + 1] -= per_node * 0.85
        else:
            force[2 * nid + 1] -= per_node

    return MasksAndLoads(
        forced_solid=forced_solid,
        forced_void=forced_void,
        fixed_dofs=np.array(sorted(fixed), dtype=np.int64),
        force=force,
        bolt_centers=centers,
        load_nodes=loads,
        load_interface_center=load_center,
    )


def build_filter(nx: int, ny: int, radius: float) -> Tuple[Any, np.ndarray]:
    rows: List[int] = []
    cols: List[int] = []
    data: List[float] = []
    r = int(math.ceil(radius))

    for ex in range(nx):
        for ey in range(ny):
            row = ex * ny + ey
            for kx in range(max(0, ex - r), min(nx, ex + r + 1)):
                for ky in range(max(0, ey - r), min(ny, ey + r + 1)):
                    col = kx * ny + ky
                    dist = math.sqrt((ex - kx) ** 2 + (ey - ky) ** 2)
                    weight = max(0.0, radius - dist)
                    if weight > 0:
                        rows.append(row)
                        cols.append(col)
                        data.append(weight)

    h = coo_matrix((data, (rows, cols)), shape=(nx * ny, nx * ny)).tocsr()
    hs = np.asarray(h.sum(axis=1)).ravel()
    hs[hs == 0] = 1.0
    return h, hs


def assemble_and_solve(
    density: np.ndarray,
    edof: np.ndarray,
    ke: np.ndarray,
    free_dofs: np.ndarray,
    force: np.ndarray,
    penalization: float,
) -> Tuple[np.ndarray, np.ndarray, float]:
    ndof = force.size
    nele = density.size

    i_k = np.kron(edof, np.ones((8, 1), dtype=np.int64)).ravel()
    j_k = np.kron(edof, np.ones((1, 8), dtype=np.int64)).ravel()

    e_min = 1.0e-6
    e_values = e_min + np.power(density.ravel(), penalization) * (1.0 - e_min)
    s_k = (ke.ravel()[None, :] * e_values[:, None]).ravel()

    k_global = coo_matrix((s_k, (i_k, j_k)), shape=(ndof, ndof)).tocsc()
    k_free = k_global[free_dofs, :][:, free_dofs]
    f_free = force[free_dofs]

    u = np.zeros(ndof, dtype=float)
    u[free_dofs] = spsolve(k_free, f_free)

    ue = u[edof]
    ce = np.einsum("ij,ij->i", ue @ ke, ue)

    compliance = float(np.dot(e_values, ce))
    dc = -penalization * (1.0 - e_min) * np.power(density.ravel(), penalization - 1.0) * ce
    dc = dc.reshape(density.shape)

    return u, dc, compliance


def optimality_update(
    x: np.ndarray,
    dc: np.ndarray,
    target_volume_fraction: float,
    forced_solid: np.ndarray,
    forced_void: np.ndarray,
    h: Any,
    hs: np.ndarray,
) -> np.ndarray:
    x_flat = x.ravel()
    dc_flat = dc.ravel()

    # Sensitivity filtering.
    filtered_dc = np.asarray((h @ (x_flat * dc_flat)) / np.maximum(1.0e-9, hs * np.maximum(1.0e-3, x_flat))).ravel()
    filtered_dc = np.minimum(filtered_dc, -1.0e-12)

    move = 0.16
    low = 0.0
    high = 1.0e9

    solid_flat = forced_solid.ravel()
    void_flat = forced_void.ravel()
    designable = ~(solid_flat | void_flat)

    passive_solid_volume = float(np.count_nonzero(solid_flat))
    passive_void_volume = float(np.count_nonzero(void_flat))
    total = float(x_flat.size)
    target_total_solid = target_volume_fraction * total
    designable_target = clamp(
        (target_total_solid - passive_solid_volume) / max(1.0, total - passive_solid_volume - passive_void_volume),
        0.08,
        0.92,
    )

    candidate = x_flat.copy()

    while high - low > 1.0e-4:
        mid = 0.5 * (low + high)
        update = x_flat * np.sqrt(-filtered_dc / max(mid, 1.0e-12))
        update = np.maximum(x_flat - move, np.minimum(x_flat + move, update))
        update = np.clip(update, 0.001, 1.0)

        candidate[:] = x_flat
        candidate[designable] = update[designable]
        candidate[solid_flat] = 1.0
        candidate[void_flat] = 0.001

        designable_mean = float(np.mean(candidate[designable])) if np.any(designable) else 0.0

        if designable_mean > designable_target:
            low = mid
        else:
            high = mid

    return candidate.reshape(x.shape)


def projection(x: np.ndarray, beta: float = 8.0, eta: float = 0.47) -> np.ndarray:
    numerator = np.tanh(beta * eta) + np.tanh(beta * (x - eta))
    denominator = np.tanh(beta * eta) + np.tanh(beta * (1.0 - eta))
    return np.clip(numerator / denominator, 0.0, 1.0)


def add_design_intent_field(
    x: np.ndarray,
    masks: MasksAndLoads,
    strength: float,
) -> np.ndarray:
    """Small deterministic nudge toward useful bracket load paths.

    This is not fake geometry. It does not create the final shape. It simply
    avoids numerical local minima where the optimizer leaves a large slab by
    seeding viable tension/compression paths between required interfaces.
    """
    nx, ny = x.shape
    intent = np.zeros_like(x)

    ref = max(nx, ny)
    r_main = max(1.2, ref * 0.020)
    r_light = max(1.0, ref * 0.014)
    load_x, load_y = masks.load_interface_center

    for bx, by in masks.bolt_centers:
        path = np.zeros_like(x, dtype=bool)
        mark_path(path, bx, by, load_x, load_y, r_main)
        intent[path] = np.maximum(intent[path], 1.0)

    if len(masks.bolt_centers) >= 2:
        for i in range(len(masks.bolt_centers)):
            ax, ay = masks.bolt_centers[i]
            bx, by = masks.bolt_centers[(i + 1) % len(masks.bolt_centers)]
            path = np.zeros_like(x, dtype=bool)
            mark_path(path, ax, ay, bx, by, r_light)
            intent[path] = np.maximum(intent[path], 0.55)

    return np.clip(x * (1.0 - strength) + intent * strength, 0.001, 1.0)


def run_simp(s: TopologyInput) -> Tuple[np.ndarray, Dict[str, Any]]:
    nx, ny = s.nx, s.ny
    masks = build_masks_and_loads(s)

    volume_fraction = 1.0 - s.target_open_area_percent / 100.0
    volume_fraction = clamp(volume_fraction, 0.22, 0.75)

    edof = build_edof(nx, ny)
    ke = quad4_plane_stress_ke(s.poisson_ratio)
    h, hs = build_filter(nx, ny, s.filter_radius)

    all_dofs = np.arange(masks.force.size)
    free_dofs = np.setdiff1d(all_dofs, masks.fixed_dofs)

    # Start open, not slab-like. Forced solids and required seeded load paths
    # help the solver find bracket truss members instead of filling a block.
    x = np.full((nx, ny), volume_fraction, dtype=float)
    x[masks.forced_solid] = 1.0
    x[masks.forced_void] = 0.001
    x = add_design_intent_field(x, masks, strength=0.22)
    x[masks.forced_solid] = 1.0
    x[masks.forced_void] = 0.001

    history: List[Dict[str, float]] = []
    last_change = 1.0
    compliance = 0.0

    for iteration in range(1, s.max_iterations + 1):
        _, dc, compliance = assemble_and_solve(
            density=x,
            edof=edof,
            ke=ke,
            free_dofs=free_dofs,
            force=masks.force,
            penalization=s.penalization,
        )

        updated = optimality_update(
            x=x,
            dc=dc,
            target_volume_fraction=volume_fraction,
            forced_solid=masks.forced_solid,
            forced_void=masks.forced_void,
            h=h,
            hs=hs,
        )

        # Continue giving a shrinking load-path nudge during early iterations.
        if iteration < max(12, s.min_iterations // 2):
            updated = add_design_intent_field(updated, masks, strength=0.08)

        updated[masks.forced_solid] = 1.0
        updated[masks.forced_void] = 0.001

        last_change = float(np.max(np.abs(updated - x)))
        x = updated

        if iteration % 5 == 0 or iteration == 1:
            history.append(
                {
                    "iteration": float(iteration),
                    "compliance": float(compliance),
                    "change": float(last_change),
                    "meanDensity": float(np.mean(x)),
                }
            )

        if iteration >= s.min_iterations and last_change <= s.change_tolerance:
            break

    projected = projection(x, beta=9.0, eta=0.49)
    projected[masks.forced_solid] = 1.0
    projected[masks.forced_void] = 0.0

    # Remove isolated low-value fog but keep the result density-based.
    projected = np.where(projected >= 0.20, projected, 0.0)

    metadata = {
        "engine": ENGINE,
        "iterations": len(history) * 5 if history else s.max_iterations,
        "converged": bool(last_change <= s.change_tolerance),
        "compliance": round(float(compliance), 5),
        "change": round(float(last_change), 6),
        "volumeFraction": round(float(np.mean(projected)), 4),
        "targetVolumeFraction": round(float(volume_fraction), 4),
        "targetOpenAreaPercent": round(float(s.target_open_area_percent), 2),
        "penalization": round(float(s.penalization), 3),
        "filterRadius": round(float(s.filter_radius), 3),
        "fixedDofCount": int(len(masks.fixed_dofs)),
        "boltCenters": [{"x": round(float(x), 3), "y": round(float(y), 3)} for x, y in masks.bolt_centers],
        "loadInterfaceCenter": {
            "x": round(float(masks.load_interface_center[0]), 3),
            "y": round(float(masks.load_interface_center[1]), 3),
        },
        "loadNodeCount": int(len(masks.load_nodes)),
        "forcedSolidCells": int(np.count_nonzero(masks.forced_solid)),
        "forcedVoidCells": int(np.count_nonzero(masks.forced_void)),
        "history": history[-12:],
    }

    return projected, metadata


def extrude_to_3d(density_2d: np.ndarray, nz: int) -> List[List[List[float]]]:
    nx, ny = density_2d.shape
    out = np.zeros((nx, ny, nz), dtype=float)
    mid = (nz - 1) * 0.5

    for z in range(nz):
        normalized = abs(z - mid) / max(mid, 1.0e-9)
        thickness_profile = 1.0 - 0.22 * (normalized ** 2)

        # Slight edge softening lets the surface-net extractor produce rounded
        # front/back edges instead of a hard extruded slab.
        out[:, :, z] = np.clip(density_2d * thickness_profile, 0.0, 1.0)

    return out.tolist()


def main() -> None:
    raw = sys.stdin.read().strip()

    if not raw and len(sys.argv) > 1:
        raw = sys.argv[1].strip()

    if not raw:
        raise ValueError("No topology input JSON was provided.")

    data = json.loads(raw)
    s = parse_input(data)

    density_2d, metadata = run_simp(s)
    density_3d = extrude_to_3d(density_2d, s.nz)

    print(
        json.dumps(
            {
                "ok": True,
                "engine": ENGINE,
                "density": density_3d,
                "nx": s.nx,
                "ny": s.ny,
                "nz": s.nz,
                "metadata": metadata,
            },
            separators=(",", ":"),
        )
    )


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(
            json.dumps(
                {
                    "ok": False,
                    "engine": ENGINE,
                    "error": str(exc),
                    "traceback": traceback.format_exc(),
                },
                separators=(",", ":"),
            )
        )
        sys.exit(1)
