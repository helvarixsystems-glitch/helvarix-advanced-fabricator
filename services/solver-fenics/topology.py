#!/usr/bin/env python3
"""
Helvarix Advanced Fabricator — SIMP Topology Optimization Solver
services/solver-fenics/topology.py

Compliance-minimization topology optimization:
  - SIMP penalization (p = 3)
  - Sensitivity filter via sparse matrix (no checkerboarding)
  - Optimality Criteria (OC) density update with bisection
  - Heaviside projection for sharp Marching-Cubes iso-surfaces
  - Bolt-hole Dirichlet BCs + distributed Neumann load patch

Input  (stdin or argv[1]): JSON matching the /fenics-test API contract.
Output (stdout): JSON { ok, engine, density[nx][ny][nz], nx, ny, nz, metadata }
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
    from scipy.sparse import coo_matrix, csr_matrix
    from scipy.sparse.linalg import spsolve
except ImportError as exc:
    raise RuntimeError(
        "SIMP solver requires scipy. Add scipy to "
        "services/solver-fenics/requirements.txt and redeploy."
    ) from exc


ENGINE = "simp-compliance-topology-v2"


# ---------------------------------------------------------------------------
# Input
# ---------------------------------------------------------------------------

@dataclass
class SolverInput:
    nx: int = 48
    ny: int = 48
    nz: int = 14
    load_direction: str = "vertical"
    bolt_count: int = 2
    target_open_area_percent: float = 45.0
    safety_factor: float = 1.5
    force_n: float = 2500.0
    max_iterations: int = 60
    min_iterations: int = 20
    change_tolerance: float = 0.010
    penalization: float = 3.0
    filter_radius: float = 2.5
    e0: float = 1.0   # normalized — SIMP compliance is scale-invariant
    nu: float = 0.300


def _clamp(v: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, v))


def parse_input(raw: Dict[str, Any]) -> SolverInput:
    return SolverInput(
        nx=int(_clamp(int(raw.get("nx", 48)), 16, 96)),
        ny=int(_clamp(int(raw.get("ny", 48)), 16, 96)),
        nz=int(_clamp(int(raw.get("nz", 14)), 4, 48)),
        load_direction=str(raw.get("loadDirection", "vertical")).lower().strip(),
        bolt_count=int(_clamp(int(raw.get("boltCount", 2)), 1, 8)),
        target_open_area_percent=float(_clamp(float(raw.get("targetOpenAreaPercent", 45.0)), 15.0, 80.0)),
        safety_factor=float(_clamp(float(raw.get("safetyFactor", 1.5)), 1.0, 4.0)),
        force_n=float(_clamp(float(raw.get("forceN", 2500.0)), 1.0, 1.0e7)),
        max_iterations=int(_clamp(int(raw.get("maxIterations", 60)), 10, 150)),
        min_iterations=int(_clamp(int(raw.get("minIterations", 20)), 5, 60)),
        change_tolerance=float(_clamp(float(raw.get("changeTolerance", 0.010)), 0.001, 0.05)),
        penalization=float(_clamp(float(raw.get("penalization", 3.0)), 2.0, 4.5)),
        filter_radius=float(_clamp(float(raw.get("filterRadius", 2.5)), 1.0, 8.0)),
        nu=float(_clamp(float(raw.get("poissonRatio", 0.30)), 0.05, 0.49)),
    )


# ---------------------------------------------------------------------------
# FEM: 4-node bilinear Q4 plane-stress element
# ---------------------------------------------------------------------------

def ke_quad4(nu: float) -> np.ndarray:
    """
    8×8 unit-stiffness matrix for a Q4 plane-stress element on a unit square,
    derived analytically from 2×2 Gauss integration of B^T D B.
    Young's modulus E is applied per-element during assembly.
    """
    k = np.array([
        0.5 - nu / 6.0,
        0.125 + nu / 8.0,
        -0.25 - nu / 12.0,
        -0.125 + 3.0 * nu / 8.0,
        -0.25 + nu / 12.0,
        -0.125 - nu / 8.0,
        nu / 6.0,
        0.125 - 3.0 * nu / 8.0,
    ])
    return np.array([
        [k[0], k[1], k[2], k[3], k[4], k[5], k[6], k[7]],
        [k[1], k[0], k[7], k[6], k[5], k[4], k[3], k[2]],
        [k[2], k[7], k[0], k[5], k[6], k[3], k[4], k[1]],
        [k[3], k[6], k[5], k[0], k[7], k[2], k[1], k[4]],
        [k[4], k[5], k[6], k[7], k[0], k[1], k[2], k[3]],
        [k[5], k[4], k[3], k[2], k[1], k[0], k[7], k[6]],
        [k[6], k[3], k[4], k[1], k[2], k[7], k[0], k[5]],
        [k[7], k[2], k[1], k[4], k[3], k[6], k[5], k[0]],
    ]) / (1.0 - nu * nu)


def _node_id(ix: int, iy: int, ny: int) -> int:
    return ix * (ny + 1) + iy


def build_edof(nx: int, ny: int) -> np.ndarray:
    """Element DOF table: (nele, 8) — element e → 8 global DOF indices."""
    nele = nx * ny
    edof = np.zeros((nele, 8), dtype=np.int64)
    for ex in range(nx):
        for ey in range(ny):
            e  = ex * ny + ey
            n1 = _node_id(ex,     ey,     ny)
            n2 = _node_id(ex + 1, ey,     ny)
            n3 = _node_id(ex + 1, ey + 1, ny)
            n4 = _node_id(ex,     ey + 1, ny)
            edof[e] = [
                2 * n1,     2 * n1 + 1,
                2 * n2,     2 * n2 + 1,
                2 * n3,     2 * n3 + 1,
                2 * n4,     2 * n4 + 1,
            ]
    return edof


# ---------------------------------------------------------------------------
# Boundary conditions
# ---------------------------------------------------------------------------

def _bolt_centers(nx: int, ny: int, bolt_count: int) -> List[Tuple[float, float]]:
    bottom_y = ny * 0.18
    top_y    = ny * 0.82
    if bolt_count == 1:
        return [(nx * 0.50, bottom_y)]
    if bolt_count == 2:
        return [(nx * 0.28, bottom_y), (nx * 0.72, bottom_y)]
    if bolt_count == 3:
        return [(nx * 0.25, bottom_y), (nx * 0.75, bottom_y), (nx * 0.50, top_y)]
    if bolt_count == 4:
        return [
            (nx * 0.25, bottom_y), (nx * 0.75, bottom_y),
            (nx * 0.25, top_y),    (nx * 0.75, top_y),
        ]
    # 5+ bolts: evenly spaced on an ellipse
    return [
        (
            nx * 0.5 + math.cos(-math.pi / 2.0 + 2 * math.pi * i / bolt_count) * nx * 0.32,
            ny * 0.5 + math.sin(-math.pi / 2.0 + 2 * math.pi * i / bolt_count) * ny * 0.34,
        )
        for i in range(bolt_count)
    ]


def _load_nodes(nx: int, ny: int, direction: str) -> List[Tuple[int, int]]:
    patch = max(2, int(round(nx * 0.09)))
    if direction == "lateral":
        x     = nx
        y_mid = int(round(ny * 0.55))
        return [(x, y) for y in range(max(0, y_mid - patch), min(ny, y_mid + patch) + 1)]
    if direction == "multi-axis":
        nodes = [(x, ny) for x in range(int(nx * 0.38), int(nx * 0.62) + 1)]
        nodes += [(nx, y) for y in range(int(ny * 0.46), int(ny * 0.62) + 1)]
        return nodes
    # vertical (default)
    x_mid = int(round(nx * 0.5))
    return [(x, ny) for x in range(max(0, x_mid - patch), min(nx, x_mid + patch) + 1)]


def build_bcs(
    s: SolverInput,
) -> Tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray, List[Tuple[float, float]]]:
    """Return (solid_mask, void_mask, fixed_dofs, force_vector, bolt_centers)."""
    nx, ny = s.nx, s.ny
    ndof   = 2 * (nx + 1) * (ny + 1)

    solid = np.zeros((nx, ny), dtype=bool)
    void  = np.zeros((nx, ny), dtype=bool)

    bolt_centers = _bolt_centers(nx, ny, s.bolt_count)
    ref          = max(nx, ny)
    hole_r       = ref * 0.040
    pad_r        = ref * 0.100
    supp_r       = ref * 0.074

    # Vectorized hole / pad masking
    EX, EY = np.meshgrid(np.arange(nx) + 0.5, np.arange(ny) + 0.5, indexing="ij")
    for bx, by in bolt_centers:
        dist = np.hypot(EX - bx, EY - by)
        void[dist <= hole_r] = True
        solid[(dist > hole_r) & (dist <= pad_r)] = True

    # Load-interface patch — keep solid so the optimizer has a real attachment
    for lx, ly in _load_nodes(nx, ny, s.load_direction):
        for ex in range(max(0, lx - 2), min(nx - 1, lx + 1) + 1):
            for ey in range(max(0, ly - 2), min(ny - 1, ly + 1) + 1):
                solid[ex, ey] = True

    # Fix nodes on the bolt-hole perimeter ring (Dirichlet BC)
    fixed_set: set = set()
    for nx_n in range(nx + 1):
        for ny_n in range(ny + 1):
            for bx, by in bolt_centers:
                d = math.hypot(nx_n - bx, ny_n - by)
                if hole_r * 0.85 <= d <= supp_r:
                    nid = _node_id(nx_n, ny_n, ny)
                    fixed_set.add(2 * nid)
                    fixed_set.add(2 * nid + 1)

    if not fixed_set:
        for bx, by in bolt_centers:
            x = int(round(_clamp(bx, 0, nx)))
            y = int(round(_clamp(by, 0, ny)))
            nid = _node_id(x, y, ny)
            fixed_set.add(2 * nid)
            fixed_set.add(2 * nid + 1)

    fixed_dofs = np.array(sorted(fixed_set), dtype=np.int64)

    # Load vector (Neumann BC)
    force    = np.zeros(ndof, dtype=float)
    l_nodes  = _load_nodes(nx, ny, s.load_direction) or [(int(round(nx * 0.5)), ny)]
    per_node = s.force_n * s.safety_factor / max(1, len(l_nodes))

    for lx, ly in l_nodes:
        nid = _node_id(int(_clamp(lx, 0, nx)), int(_clamp(ly, 0, ny)), ny)
        if s.load_direction == "lateral":
            force[2 * nid] += per_node
        elif s.load_direction == "multi-axis":
            force[2 * nid]     +=  0.35 * per_node
            force[2 * nid + 1] += -0.94 * per_node
        else:
            force[2 * nid + 1] += -per_node

    return solid, void, fixed_dofs, force, bolt_centers


# ---------------------------------------------------------------------------
# Sensitivity filter (sparse hat filter — prevents checkerboarding)
# ---------------------------------------------------------------------------

def build_filter_matrix(nx: int, ny: int, radius: float) -> Tuple[Any, np.ndarray]:
    """
    Build sparse (nele × nele) hat filter H and row-sum vector Hs.
    Called once before the iteration loop; O(nele * r^2) setup cost.
    """
    nele = nx * ny
    r    = int(math.ceil(radius))
    rows: List[int]   = []
    cols: List[int]   = []
    vals: List[float] = []

    for ex in range(nx):
        for ey in range(ny):
            i = ex * ny + ey
            for ix in range(max(0, ex - r), min(nx - 1, ex + r) + 1):
                for iy in range(max(0, ey - r), min(ny - 1, ey + r) + 1):
                    w = max(0.0, radius - math.hypot(ex - ix, ey - iy))
                    if w > 0.0:
                        rows.append(i)
                        cols.append(ix * ny + iy)
                        vals.append(w)

    H  = csr_matrix((vals, (rows, cols)), shape=(nele, nele))
    Hs = np.asarray(H.sum(axis=1)).ravel()
    return H, Hs


def filter_sensitivities(
    H: Any,
    Hs: np.ndarray,
    x: np.ndarray,
    dc: np.ndarray,
) -> np.ndarray:
    xf  = x.ravel()
    dcf = dc.ravel()
    out = H.dot(xf * dcf) / (Hs * np.maximum(xf, 1e-4))
    return out.reshape(x.shape)


# ---------------------------------------------------------------------------
# FEM solve
# ---------------------------------------------------------------------------

def assemble_and_solve(
    s: SolverInput,
    x_phys: np.ndarray,
    edof: np.ndarray,
    ke: np.ndarray,
    fixed_dofs: np.ndarray,
    force: np.ndarray,
) -> np.ndarray:
    nele = s.nx * s.ny
    ndof = 2 * (s.nx + 1) * (s.ny + 1)
    e_min = s.e0 * 1e-6

    # SIMP stiffness interpolation: E(rho) = E_min + rho^p * (E0 - E_min)
    scale = e_min + np.power(x_phys.ravel(), s.penalization) * (s.e0 - e_min)

    # Vectorized COO assembly (leverages ke symmetry)
    i_k = np.kron(edof, np.ones((8, 1), dtype=np.int64)).reshape(-1)
    j_k = np.kron(edof, np.ones((1, 8), dtype=np.int64)).reshape(-1)
    s_k = (ke.reshape(64, 1) * scale.reshape(1, nele)).T.reshape(-1)

    K    = coo_matrix((s_k, (i_k, j_k)), shape=(ndof, ndof)).tocsc()
    free = np.setdiff1d(np.arange(ndof, dtype=np.int64), fixed_dofs, assume_unique=False)

    u = np.zeros(ndof, dtype=float)
    if len(free):
        u[free] = spsolve(K[free, :][:, free], force[free])
        u[~np.isfinite(u)] = 0.0
    return u


# ---------------------------------------------------------------------------
# Optimality Criteria update
# ---------------------------------------------------------------------------

def oc_update(
    x: np.ndarray,
    dc: np.ndarray,
    vf: float,
    solid: np.ndarray,
    void: np.ndarray,
) -> np.ndarray:
    xmin      = 1e-3
    move      = 0.20
    designable = ~(solid | void)
    target    = _clamp(
        vf * x.size - float(np.count_nonzero(solid)),
        float(np.count_nonzero(designable)) * xmin,
        float(np.count_nonzero(designable)),
    )

    l1, l2 = 0.0, 1e9
    x_new  = x.copy()

    for _ in range(80):
        lmid  = 0.5 * (l1 + l2)
        be    = np.sqrt(np.maximum(0.0, -dc / max(lmid, 1e-30)))
        cand  = np.clip(
            np.maximum(xmin, np.maximum(x - move, np.minimum(1.0, np.minimum(x + move, x * be)))),
            xmin, 1.0,
        )
        cand[solid] = 1.0
        cand[void]  = xmin
        if cand[designable].sum() > target:
            l1 = lmid
        else:
            l2 = lmid
        x_new = cand
        if (l2 - l1) / max(l1 + l2, 1e-9) < 1e-4:
            break

    x_new[solid] = 1.0
    x_new[void]  = xmin
    return x_new


# ---------------------------------------------------------------------------
# Main SIMP loop
# ---------------------------------------------------------------------------

def run_simp(s: SolverInput) -> Tuple[np.ndarray, Dict[str, Any]]:
    nx, ny = s.nx, s.ny
    vf     = _clamp(1.0 - s.target_open_area_percent / 100.0, 0.20, 0.85)

    solid, void, fixed_dofs, force, bolt_centers = build_bcs(s)

    ke   = ke_quad4(s.nu)
    edof = build_edof(nx, ny)
    H, Hs = build_filter_matrix(nx, ny, s.filter_radius)

    x = np.full((nx, ny), vf, dtype=float)
    x[solid] = 1.0
    x[void]  = 1e-3

    history:    List[Dict] = []
    compliance: float      = 0.0
    last_change: float     = 1.0
    e_min = s.e0 * 1e-6

    for iteration in range(1, s.max_iterations + 1):
        u  = assemble_and_solve(s, x, edof, ke, fixed_dofs, force)
        ue = u[edof]   # (nele, 8)

        elem_energy = np.einsum("ij,jk,ik->i", ue, ke, ue).reshape((nx, ny))

        compliance = float(
            np.sum((e_min + np.power(x, s.penalization) * (s.e0 - e_min)) * elem_energy)
        )

        # Sensitivity of compliance w.r.t. density
        dc = -s.penalization * (s.e0 - e_min) * np.power(x, s.penalization - 1.0) * elem_energy
        dc[solid | void] = 0.0
        dc = filter_sensitivities(H, Hs, x, dc)

        x_new       = oc_update(x, dc, vf, solid, void)
        last_change = float(np.max(np.abs(x_new - x)))
        x           = x_new

        history.append({
            "iteration":    iteration,
            "compliance":   round(compliance, 4),
            "change":       round(last_change, 6),
            "volumeFraction": round(float(np.mean(x)), 4),
        })

        if iteration >= s.min_iterations and last_change <= s.change_tolerance:
            break

    # Heaviside projection → sharper iso-surface for Marching Cubes
    beta, eta = 6.0, 0.48
    denom     = math.tanh(beta * eta) + math.tanh(beta * (1.0 - eta))
    projected = (np.tanh(beta * eta) + np.tanh(beta * (x - eta))) / denom
    projected = np.clip(projected, 0.0, 1.0)
    projected[solid] = 1.0
    projected[void]  = 0.0

    metadata: Dict[str, Any] = {
        "engine":              ENGINE,
        "iterations":          len(history),
        "converged":           last_change <= s.change_tolerance,
        "compliance":          round(compliance, 4),
        "change":              round(last_change, 6),
        "volumeFraction":      round(float(np.mean(projected)), 4),
        "targetVolumeFraction": round(vf, 4),
        "penalization":        s.penalization,
        "filterRadius":        s.filter_radius,
        "fixedDofCount":       int(len(fixed_dofs)),
        "boltCenters":         [{"x": float(bx), "y": float(by)} for bx, by in bolt_centers],
        "history":             history[-10:],
    }
    return projected, metadata


# ---------------------------------------------------------------------------
# 2D → 3D extrusion
# ---------------------------------------------------------------------------

def extrude_to_3d(density_2d: np.ndarray, nz: int) -> List[List[List[float]]]:
    """
    Extrude the 2D optimized slice through nz layers with a mild lenticular
    taper (~12 % reduction at faces) so Marching Cubes produces rounded edges
    rather than a flat-sided slab.
    """
    nx, ny = density_2d.shape
    out    = np.zeros((nx, ny, nz), dtype=float)
    mid    = (nz - 1) * 0.5

    for z in range(nz):
        t = 1.0 - 0.12 * ((abs(z - mid) / max(mid, 1e-9)) ** 2)
        out[:, :, z] = np.clip(density_2d * t, 0.0, 1.0)

    return out.tolist()


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main() -> None:
    raw = sys.stdin.read().strip()
    if not raw and len(sys.argv) > 1:
        raw = sys.argv[1].strip()
    if not raw:
        raise ValueError("No input: provide JSON via stdin or as first argument.")

    data     = json.loads(raw)
    s        = parse_input(data)
    density_2d, metadata = run_simp(s)
    density_3d = extrude_to_3d(density_2d, s.nz)

    print(json.dumps(
        {
            "ok":       True,
            "engine":   ENGINE,
            "density":  density_3d,
            "nx":       s.nx,
            "ny":       s.ny,
            "nz":       s.nz,
            "metadata": metadata,
        },
        separators=(",", ":"),
    ))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(json.dumps({
            "ok":        False,
            "engine":    ENGINE,
            "error":     str(exc),
            "traceback": traceback.format_exc(),
        }))
        sys.exit(1)
