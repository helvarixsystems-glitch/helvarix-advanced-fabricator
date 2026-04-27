#!/usr/bin/env python3
"""
Helvarix Advanced Fabricator - SciPy SIMP Topology Solver

Drop-in replacement for:
  services/solver-fenics/topology.py

Contract:
  - Reads JSON from stdin or first CLI argument.
  - Returns JSON to stdout.
  - Main response shape:
      {
        "ok": true,
        "engine": "scipy-simp-compliance-topology-v2",
        "density": [[[...]]],
        "nx": 48,
        "ny": 48,
        "nz": 14,
        ...
      }

This is intentionally FEniCS-free for Render reliability. It performs a real
2D SIMP compliance-minimization solve, then extrudes the optimized density
through Z so the existing frontend density/marching-cubes path can render it.
"""

from __future__ import annotations

import json
import math
import sys
import traceback
from dataclasses import dataclass
from typing import Any, Dict, List, Sequence, Tuple

import numpy as np
from scipy.sparse import coo_matrix, csc_matrix
from scipy.sparse.linalg import spsolve


ENGINE_NAME = "scipy-simp-compliance-topology-v2"


@dataclass
class SolverInput:
    nx: int = 48
    ny: int = 48
    nz: int = 14
    loadDirection: str = "vertical"
    boltCount: int = 2
    targetOpenAreaPercent: float = 60.0
    safetyFactor: float = 1.5
    forceN: float = 2500.0
    maxIterations: int = 90
    penal: float = 3.0
    filterRadius: float = 2.4
    moveLimit: float = 0.16
    boltDiameterCells: float | None = None


def clamp(value: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, value))


def parse_input() -> SolverInput:
    raw = ""
    if len(sys.argv) > 1 and sys.argv[1].strip():
        raw = sys.argv[1]
    else:
        raw = sys.stdin.read()

    data: Dict[str, Any] = {}
    if raw.strip():
        data = json.loads(raw)

    return SolverInput(
        nx=int(data.get("nx", data.get("nelx", 48))),
        ny=int(data.get("ny", data.get("nely", 48))),
        nz=int(data.get("nz", 14)),
        loadDirection=str(data.get("loadDirection", "vertical")).lower(),
        boltCount=int(data.get("boltCount", 2)),
        targetOpenAreaPercent=float(data.get("targetOpenAreaPercent", 60.0)),
        safetyFactor=float(data.get("safetyFactor", 1.5)),
        forceN=float(data.get("forceN", 2500.0)),
        maxIterations=int(data.get("maxIterations", 90)),
        penal=float(data.get("penal", 3.0)),
        filterRadius=float(data.get("filterRadius", 2.4)),
        moveLimit=float(data.get("moveLimit", 0.16)),
        boltDiameterCells=(
            float(data["boltDiameterCells"])
            if "boltDiameterCells" in data and data["boltDiameterCells"] is not None
            else None
        ),
    )


def element_stiffness_matrix(nu: float = 0.30) -> np.ndarray:
    """
    Q4 plane-stress element stiffness from the classic 88-line topology optimizer.
    """
    k = np.array(
        [
            1 / 2 - nu / 6,
            1 / 8 + nu / 8,
            -1 / 4 - nu / 12,
            -1 / 8 + 3 * nu / 8,
            -1 / 4 + nu / 12,
            -1 / 8 - nu / 8,
            nu / 6,
            1 / 8 - 3 * nu / 8,
        ],
        dtype=float,
    )
    KE = 1 / (1 - nu**2) * np.array(
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
    )
    return KE


def build_edof(nelx: int, nely: int) -> np.ndarray:
    """
    Element DOF matrix for nelx*nely Q4 elements.
    Node numbering follows a regular (nelx+1) by (nely+1) grid.
    """
    edof = np.zeros((nelx * nely, 8), dtype=np.int64)
    e = 0
    for ix in range(nelx):
        for iy in range(nely):
            n1 = iy + ix * (nely + 1)
            n2 = iy + (ix + 1) * (nely + 1)
            edof[e, :] = np.array(
                [
                    2 * n1,
                    2 * n1 + 1,
                    2 * n2,
                    2 * n2 + 1,
                    2 * n2 + 2,
                    2 * n2 + 3,
                    2 * n1 + 2,
                    2 * n1 + 3,
                ],
                dtype=np.int64,
            )
            e += 1
    return edof


def node_id(ix: int, iy: int, nely: int) -> int:
    return iy + ix * (nely + 1)


def bolt_centers(nelx: int, nely: int, bolt_count: int) -> List[Tuple[float, float]]:
    """
    Bolt supports along the lower mounting edge. Supports are represented as
    fixed node patches around bolt-hole centers.
    """
    count = int(clamp(round(bolt_count), 1, 8))
    y = nely * 0.14
    if count == 1:
        xs = [nelx * 0.50]
    else:
        span = nelx * clamp(0.44 + 0.04 * (count - 2), 0.44, 0.74)
        start = nelx * 0.50 - span / 2
        xs = [start + span * i / (count - 1) for i in range(count)]
    return [(float(x), float(y)) for x in xs]


def load_nodes(nelx: int, nely: int, load_direction: str) -> List[int]:
    """
    Apply load over a small patch so topology has a real load introduction
    surface rather than a numerical singular point.
    """
    nodes: List[int] = []
    if load_direction == "lateral":
        ix = nelx
        y0 = int(round(nely * 0.58))
        y1 = int(round(nely * 0.78))
        for iy in range(max(1, y0), min(nely, y1) + 1):
            nodes.append(node_id(ix, iy, nely))
    else:
        y = nely
        x0 = int(round(nelx * 0.38))
        x1 = int(round(nelx * 0.62))
        for ix in range(max(1, x0), min(nelx - 1, x1) + 1):
            nodes.append(node_id(ix, y, nely))
    return nodes


def fixed_support_dofs(nelx: int, nely: int, bolts: Sequence[Tuple[float, float]], bolt_radius: float) -> np.ndarray:
    fixed: List[int] = []
    support_radius = max(bolt_radius * 1.25, 3.0)

    for ix in range(nelx + 1):
        for iy in range(nely + 1):
            for bx, by in bolts:
                if math.hypot(ix - bx, iy - by) <= support_radius:
                    nid = node_id(ix, iy, nely)
                    fixed.extend([2 * nid, 2 * nid + 1])
                    break

    # Stabilize edge cases. Real bolt patches usually do this already.
    if not fixed:
        for ix, iy in [(0, 0), (nelx, 0)]:
            nid = node_id(ix, iy, nely)
            fixed.extend([2 * nid, 2 * nid + 1])

    return np.unique(np.asarray(fixed, dtype=np.int64))


def force_vector(nelx: int, nely: int, load_direction: str, force_n: float, safety_factor: float) -> np.ndarray:
    ndof = 2 * (nelx + 1) * (nely + 1)
    F = np.zeros(ndof, dtype=float)
    nodes = load_nodes(nelx, nely, load_direction)
    total_force = max(float(force_n), 1.0) * max(float(safety_factor), 0.1)

    if not nodes:
        return F

    per_node = total_force / len(nodes)

    if load_direction == "lateral":
        for nid in nodes:
            F[2 * nid] += per_node
    elif load_direction == "inverted":
        for nid in nodes:
            F[2 * nid + 1] += per_node
    else:
        for nid in nodes:
            F[2 * nid + 1] -= per_node

    return F


def passive_masks(
    nelx: int,
    nely: int,
    bolts: Sequence[Tuple[float, float]],
    load_direction: str,
    bolt_radius: float,
) -> Tuple[np.ndarray, np.ndarray]:
    """
    passive_solid: material forced to remain for usable interfaces.
    passive_void: material forced away for bolt holes and exterior shaping.
    """
    solid = np.zeros((nely, nelx), dtype=bool)
    void = np.zeros((nely, nelx), dtype=bool)

    # Bolt holes and reinforced annular pads.
    for ex in range(nelx):
        for ey in range(nely):
            cx = ex + 0.5
            cy = ey + 0.5
            for bx, by in bolts:
                d = math.hypot(cx - bx, cy - by)
                if d <= bolt_radius:
                    void[ey, ex] = True
                if bolt_radius * 1.15 <= d <= bolt_radius * 2.35:
                    solid[ey, ex] = True

    # Top load introduction land.
    if load_direction == "lateral":
        x_min = int(round(nelx * 0.86))
        y_min = int(round(nely * 0.56))
        y_max = int(round(nely * 0.80))
        solid[y_min:y_max + 1, x_min:nelx] = True
    else:
        x_min = int(round(nelx * 0.34))
        x_max = int(round(nelx * 0.66))
        y_min = int(round(nely * 0.86))
        solid[y_min:nely, x_min:x_max + 1] = True

    # Keep a lower mounting interface around bolts, but not a giant solid rail.
    y_min = max(0, int(round(nely * 0.07)))
    y_max = min(nely, int(round(nely * 0.22)))
    x_min = max(0, int(round(min(b[0] for b in bolts) - bolt_radius * 2.5)))
    x_max = min(nelx, int(round(max(b[0] for b in bolts) + bolt_radius * 2.5)))
    solid[y_min:y_max + 1, x_min:x_max + 1] |= False  # interface is handled by annular bolt pads, not a solid bar

    # Remove material outside a bracket-like design envelope so it does not become a full rectangle.
    for ex in range(nelx):
        for ey in range(nely):
            x = (ex + 0.5) / nelx
            y = (ey + 0.5) / nely

            # tapered side envelope; wide at bolts, narrower near top
            half_width = 0.46 - 0.17 * y
            if abs(x - 0.5) > half_width:
                void[ey, ex] = True

            # keep very top corners from becoming square blocks
            if y > 0.86 and abs(x - 0.5) > 0.24:
                void[ey, ex] = True

    # Void must win inside bolt holes.
    solid[void] = False
    return solid, void


def build_filter(nelx: int, nely: int, rmin: float) -> Tuple[coo_matrix, np.ndarray]:
    rows: List[int] = []
    cols: List[int] = []
    vals: List[float] = []

    for i in range(nelx):
        for j in range(nely):
            row = i * nely + j
            imin = max(i - int(math.floor(rmin)), 0)
            imax = min(i + int(math.floor(rmin)), nelx - 1)
            jmin = max(j - int(math.floor(rmin)), 0)
            jmax = min(j + int(math.floor(rmin)), nely - 1)
            for k in range(imin, imax + 1):
                for l in range(jmin, jmax + 1):
                    fac = rmin - math.sqrt((i - k) ** 2 + (j - l) ** 2)
                    if fac > 0:
                        col = k * nely + l
                        rows.append(row)
                        cols.append(col)
                        vals.append(fac)

    H = coo_matrix((vals, (rows, cols)), shape=(nelx * nely, nelx * nely)).tocsc()
    Hs = np.asarray(H.sum(axis=1)).ravel()
    Hs[Hs == 0] = 1.0
    return H, Hs


def solve_simp(params: SolverInput) -> Tuple[np.ndarray, Dict[str, Any]]:
    nelx = int(clamp(params.nx, 20, 96))
    nely = int(clamp(params.ny, 20, 96))
    nz = int(clamp(params.nz, 6, 32))

    target_open = clamp(params.targetOpenAreaPercent, 35.0, 78.0)
    volfrac = clamp(1.0 - target_open / 100.0, 0.20, 0.58)

    penal = clamp(params.penal, 2.2, 4.0)
    rmin = clamp(params.filterRadius, 1.5, 5.5)
    move = clamp(params.moveLimit, 0.05, 0.28)

    bolt_radius = params.boltDiameterCells
    if bolt_radius is None:
        bolt_radius = clamp(min(nelx, nely) * 0.045, 2.2, 4.5)

    bolts = bolt_centers(nelx, nely, params.boltCount)
    passive_solid, passive_void = passive_masks(nelx, nely, bolts, params.loadDirection, bolt_radius)

    nele = nelx * nely
    ndof = 2 * (nelx + 1) * (nely + 1)

    KE = element_stiffness_matrix()
    edof = build_edof(nelx, nely)
    iK = np.kron(edof, np.ones((8, 1), dtype=np.int64)).ravel()
    jK = np.kron(edof, np.ones((1, 8), dtype=np.int64)).ravel()

    F = force_vector(nelx, nely, params.loadDirection, params.forceN, params.safetyFactor)
    fixed = fixed_support_dofs(nelx, nely, bolts, bolt_radius)
    all_dofs = np.arange(ndof, dtype=np.int64)
    free = np.setdiff1d(all_dofs, fixed)

    H, Hs = build_filter(nelx, nely, rmin)

    E0 = 1.0
    Emin = 1e-9

    x = np.full((nely, nelx), volfrac, dtype=float)
    x[passive_solid] = 1.0
    x[passive_void] = 0.001

    # Keep initial average close to requested volume on free cells.
    design_mask = ~(passive_solid | passive_void)
    if np.any(design_mask):
        remaining_volume = volfrac * nele - np.sum(x[passive_solid]) - np.sum(x[passive_void])
        x[design_mask] = clamp(remaining_volume / np.sum(design_mask), 0.05, 0.95)

    last_change = 1.0
    compliance = None
    iterations = int(clamp(params.maxIterations, 25, 160))

    for loop in range(1, iterations + 1):
        x_phys_vec = np.asarray((H @ x.T.ravel()) / Hs).ravel()
        x_phys = x_phys_vec.reshape((nelx, nely)).T
        x_phys[passive_solid] = 1.0
        x_phys[passive_void] = 0.001

        # Assemble and solve.
        stiffness_scale = Emin + (x_phys.T.ravel() ** penal) * (E0 - Emin)
        sK = (KE.ravel()[None, :] * stiffness_scale[:, None]).ravel()
        K = coo_matrix((sK, (iK, jK)), shape=(ndof, ndof)).tocsc()

        U = np.zeros(ndof, dtype=float)
        try:
            U[free] = spsolve(K[free, :][:, free], F[free])
        except Exception:
            # If the design becomes singular, reset slightly denser and continue.
            x[design_mask] = np.maximum(x[design_mask], volfrac * 0.7)
            U[free] = spsolve((K[free, :][:, free] + csc_matrix(np.eye(len(free)) * 1e-8)), F[free])

        Ue = U[edof]
        ce = np.einsum("ij,jk,ik->i", Ue, KE, Ue).reshape((nelx, nely)).T
        compliance = float(np.sum((Emin + x_phys**penal * (E0 - Emin)) * ce))

        dc = -penal * (E0 - Emin) * (x_phys ** (penal - 1)) * ce
        dv = np.ones_like(x)

        # Sensitivity filter. This is the common stable variant:
        # dc = H * (x * dc) / (Hs * max(x, eps))
        flat_x = x.T.ravel()
        flat_dc = dc.T.ravel()
        filtered_dc = np.asarray((H @ (flat_x * flat_dc)) / (Hs * np.maximum(1e-3, flat_x))).ravel()
        dc = filtered_dc.reshape((nelx, nely)).T

        dc[passive_solid] = -1e9
        dc[passive_void] = 0.0

        # Optimality Criteria update with correct global volume target.
        l1, l2 = 0.0, 1e9
        x_old = x.copy()

        for _ in range(70):
            lmid = 0.5 * (l1 + l2)
            update_factor = np.sqrt(np.maximum(0.0, -dc / np.maximum(lmid * dv, 1e-30)))
            x_candidate = np.maximum(
                0.001,
                np.maximum(
                    x - move,
                    np.minimum(1.0, np.minimum(x + move, x * update_factor)),
                ),
            )

            x_candidate[passive_solid] = 1.0
            x_candidate[passive_void] = 0.001

            if x_candidate.sum() > volfrac * nele:
                l1 = lmid
            else:
                l2 = lmid

        x = x_candidate
        last_change = float(np.max(np.abs(x - x_old)))

        if last_change < 0.012 and loop > 35:
            break

    # Final physically filtered density.
    density_2d = np.asarray((H @ x.T.ravel()) / Hs).reshape((nelx, nely)).T
    density_2d[passive_solid] = 1.0
    density_2d[passive_void] = 0.0

    # Apply a mild projection to make material/void separation visible to the renderer.
    beta = 3.5
    eta = clamp(volfrac * 0.92, 0.22, 0.48)
    density_2d = (np.tanh(beta * eta) + np.tanh(beta * (density_2d - eta))) / (
        np.tanh(beta * eta) + np.tanh(beta * (1 - eta))
    )
    density_2d = np.clip(density_2d, 0.0, 1.0)

    # Extrude through thickness with rounded side falloff, not a pure slab.
    density_3d = np.zeros((nelx, nely, nz), dtype=float)
    for iz in range(nz):
        t = abs((iz + 0.5) / nz - 0.5) * 2.0
        thickness_factor = clamp(1.0 - 0.28 * (t ** 2.2), 0.70, 1.0)
        density_3d[:, :, iz] = np.clip(density_2d.T * thickness_factor, 0.0, 1.0)

    meta = {
        "iterations": loop,
        "change": last_change,
        "compliance": compliance,
        "volfrac": volfrac,
        "targetOpenAreaPercent": target_open,
        "solidFraction": float(np.mean(density_3d > 0.5)),
        "averageDensity": float(np.mean(density_3d)),
        "boltCenters": bolts,
        "loadDirection": params.loadDirection,
        "forceN": params.forceN,
        "safetyFactor": params.safetyFactor,
    }

    return density_3d, meta


def to_nested_density(density: np.ndarray) -> List[List[List[float]]]:
    nelx, nely, nz = density.shape
    result: List[List[List[float]]] = []
    for ix in range(nelx):
        plane: List[List[float]] = []
        for iy in range(nely):
            row = [round(float(density[ix, iy, iz]), 4) for iz in range(nz)]
            plane.append(row)
        result.append(plane)
    return result


def main() -> None:
    params = parse_input()
    density, meta = solve_simp(params)

    response = {
        "ok": True,
        "engine": ENGINE_NAME,
        "density": to_nested_density(density),
        "nx": int(density.shape[0]),
        "ny": int(density.shape[1]),
        "nz": int(density.shape[2]),
        "meta": meta,
    }
    print(json.dumps(response, separators=(",", ":")))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(
            json.dumps(
                {
                    "ok": False,
                    "engine": ENGINE_NAME,
                    "error": str(exc),
                    "trace": traceback.format_exc(limit=8),
                }
            )
        )
        sys.exit(1)
