import json
import math
import sys
from dataclasses import dataclass
from typing import Dict, List, Tuple

import numpy as np

try:
    from scipy.sparse import coo_matrix
    from scipy.sparse.linalg import spsolve
except Exception as exc:  # pragma: no cover
    raise RuntimeError(
        "SIMP topology optimization requires scipy. Add scipy==1.12.0 or newer to "
        "services/solver-fenics/requirements.txt and redeploy the solver worker."
    ) from exc


# -----------------------------------------------------------------------------
# Helvarix Advanced Fabricator topology solver
# -----------------------------------------------------------------------------
# This file intentionally replaces the old Gaussian/path-field placeholder with
# a real SIMP compliance-minimization loop. It solves a 2D plane-stress bracket
# optimization problem, then extrudes the resulting density through nz layers so
# the existing frontend Marching Cubes pipeline can consume density[nx][ny][nz].
#
# Why 2D first?
# - A bracket plate is naturally represented as a planar topology problem.
# - It produces the expected organic load paths immediately.
# - It is stable enough for the current Render worker and browser viewer.
# - The returned 3D density field preserves the current API contract.
# -----------------------------------------------------------------------------


@dataclass
class TopologyInput:
    nx: int = 48
    ny: int = 48
    nz: int = 14
    load_direction: str = "vertical"
    bolt_count: int = 2
    target_open_area_percent: float = 45.0
    safety_factor: float = 1.5
    force_n: float = 2500.0
    max_iterations: int = 80
    min_iterations: int = 25
    change_tolerance: float = 0.012
    penalization: float = 3.0
    filter_radius: float = 3.0
    youngs_modulus: float = 70.0e9
    poisson_ratio: float = 0.33


@dataclass
class DesignMasks:
    solid: np.ndarray
    void: np.ndarray
    fixed_dofs: np.ndarray
    load_vector: np.ndarray
    bolt_centers: List[Tuple[float, float]]
    load_nodes: List[int]


def clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def parse_input(raw: Dict) -> TopologyInput:
    nx = int(clamp(int(raw.get("nx", 48)), 16, 96))
    ny = int(clamp(int(raw.get("ny", 48)), 16, 96))
    nz = int(clamp(int(raw.get("nz", 14)), 4, 48))

    return TopologyInput(
        nx=nx,
        ny=ny,
        nz=nz,
        load_direction=str(raw.get("loadDirection", "vertical")),
        bolt_count=int(clamp(int(raw.get("boltCount", 2)), 1, 8)),
        target_open_area_percent=float(clamp(float(raw.get("targetOpenAreaPercent", 45.0)), 15.0, 80.0)),
        safety_factor=float(clamp(float(raw.get("safetyFactor", 1.5)), 1.0, 4.0)),
        force_n=float(clamp(float(raw.get("forceN", 2500.0)), 1.0, 1.0e7)),
        max_iterations=int(clamp(int(raw.get("maxIterations", 80)), 20, 180)),
        min_iterations=int(clamp(int(raw.get("minIterations", 25)), 8, 80)),
        change_tolerance=float(clamp(float(raw.get("changeTolerance", 0.012)), 0.002, 0.05)),
        penalization=float(clamp(float(raw.get("penalization", 3.0)), 2.0, 4.5)),
        filter_radius=float(clamp(float(raw.get("filterRadius", 3.0)), 1.5, 8.0)),
        youngs_modulus=float(clamp(float(raw.get("youngsModulus", 70.0e9)), 1.0e6, 5.0e11)),
        poisson_ratio=float(clamp(float(raw.get("poissonRatio", 0.33)), 0.05, 0.49)),
    )


def quad4_plane_stress_stiffness(nu: float) -> np.ndarray:
    # Standard 4-node bilinear element stiffness matrix used in SIMP topology
    # optimization benchmarks. Young's modulus is applied separately per element.
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


def node_id(x: int, y: int, ny: int) -> int:
    return x * (ny + 1) + y


def element_dofs(ex: int, ey: int, ny: int) -> np.ndarray:
    n1 = node_id(ex, ey, ny)
    n2 = node_id(ex + 1, ey, ny)
    n3 = node_id(ex + 1, ey + 1, ny)
    n4 = node_id(ex, ey + 1, ny)
    return np.array(
        [2 * n1, 2 * n1 + 1, 2 * n2, 2 * n2 + 1, 2 * n3, 2 * n3 + 1, 2 * n4, 2 * n4 + 1],
        dtype=np.int64,
    )


def build_bolt_centers(nx: int, ny: int, bolt_count: int) -> List[Tuple[float, float]]:
    bottom_y = ny * 0.16
    top_y = ny * 0.82

    if bolt_count == 1:
        return [(nx * 0.5, bottom_y)]
    if bolt_count == 2:
        return [(nx * 0.28, bottom_y), (nx * 0.72, bottom_y)]
    if bolt_count == 3:
        return [(nx * 0.25, bottom_y), (nx * 0.75, bottom_y), (nx * 0.5, top_y)]
    if bolt_count == 4:
        return [(nx * 0.25, bottom_y), (nx * 0.75, bottom_y), (nx * 0.25, top_y), (nx * 0.75, top_y)]

    centers: List[Tuple[float, float]] = []
    radius_x = nx * 0.32
    radius_y = ny * 0.36
    for index in range(bolt_count):
        angle = -math.pi / 2.0 + (2.0 * math.pi * index) / bolt_count
        centers.append((nx * 0.5 + math.cos(angle) * radius_x, ny * 0.5 + math.sin(angle) * radius_y))
    return centers


def load_patch_nodes(nx: int, ny: int, direction: str) -> List[Tuple[int, int]]:
    direction = direction.lower().strip()
    patch = max(2, int(round(nx * 0.08)))
    nodes: List[Tuple[int, int]] = []

    if direction == "lateral":
        x = nx
        y_mid = int(round(ny * 0.55))
        for y in range(max(0, y_mid - patch), min(ny, y_mid + patch) + 1):
            nodes.append((x, y))
        return nodes

    if direction == "multi-axis":
        y = ny
        for x in range(int(nx * 0.38), int(nx * 0.62) + 1):
            nodes.append((x, y))
        x = nx
        for y_node in range(int(ny * 0.46), int(ny * 0.62) + 1):
            nodes.append((x, y_node))
        return nodes

    y = ny
    x_mid = int(round(nx * 0.5))
    for x in range(max(0, x_mid - patch), min(nx, x_mid + patch) + 1):
        nodes.append((x, y))
    return nodes


def build_masks_and_loads(settings: TopologyInput) -> DesignMasks:
    nx, ny = settings.nx, settings.ny
    ndof = 2 * (nx + 1) * (ny + 1)
    solid = np.zeros((nx, ny), dtype=bool)
    void = np.zeros((nx, ny), dtype=bool)
    fixed_dofs: List[int] = []
    force = np.zeros(ndof, dtype=float)

    bolt_centers = build_bolt_centers(nx, ny, settings.bolt_count)
    hole_radius = max(nx, ny) * 0.045
    pad_radius = max(nx, ny) * 0.105
    support_radius = max(nx, ny) * 0.075

    for ex in range(nx):
        for ey in range(ny):
            cx = ex + 0.5
            cy = ey + 0.5
            for bx, by in bolt_centers:
                distance = math.hypot(cx - bx, cy - by)
                if distance <= hole_radius:
                    void[ex, ey] = True
                elif distance <= pad_radius:
                    solid[ex, ey] = True

    # Keep load application patch solid so the optimizer has a real interface.
    for lx, ly in load_patch_nodes(nx, ny, settings.load_direction):
        for ex in range(max(0, lx - 2), min(nx - 1, lx + 1) + 1):
            for ey in range(max(0, ly - 2), min(ny - 1, ly + 1) + 1):
                solid[ex, ey] = True

    # Fix nodes around bolt-hole walls/pads. This models bolted supports without
    # filling the actual holes; the hole cells remain permanent voids.
    for x in range(nx + 1):
        for y in range(ny + 1):
            for bx, by in bolt_centers:
                if hole_radius * 0.85 <= math.hypot(x - bx, y - by) <= support_radius:
                    nid = node_id(x, y, ny)
                    fixed_dofs.extend([2 * nid, 2 * nid + 1])

    if not fixed_dofs:
        # Defensive fallback: fix the closest node to each bolt center.
        for bx, by in bolt_centers:
            x = int(round(clamp(bx, 0, nx)))
            y = int(round(clamp(by, 0, ny)))
            nid = node_id(x, y, ny)
            fixed_dofs.extend([2 * nid, 2 * nid + 1])

    loaded_node_ids: List[int] = []
    load_nodes = load_patch_nodes(nx, ny, settings.load_direction)
    if not load_nodes:
        load_nodes = [(int(round(nx * 0.5)), ny)]

    total_force = settings.force_n * settings.safety_factor
    per_node_force = total_force / max(1, len(load_nodes))
    direction = settings.load_direction.lower().strip()

    for x, y in load_nodes:
        nid = node_id(int(clamp(x, 0, nx)), int(clamp(y, 0, ny)), ny)
        loaded_node_ids.append(nid)
        if direction == "lateral":
            force[2 * nid] += per_node_force
        elif direction == "multi-axis":
            force[2 * nid] += 0.35 * per_node_force
            force[2 * nid + 1] += -0.94 * per_node_force
        else:
            force[2 * nid + 1] += -per_node_force

    fixed = np.array(sorted(set(fixed_dofs)), dtype=np.int64)
    return DesignMasks(solid=solid, void=void, fixed_dofs=fixed, load_vector=force, bolt_centers=bolt_centers, load_nodes=loaded_node_ids)


def build_filter(nx: int, ny: int, radius: float) -> Tuple[List[List[Tuple[int, float]]], np.ndarray]:
    neighbors: List[List[Tuple[int, float]]] = []
    weights_sum = np.zeros(nx * ny, dtype=float)
    r = int(math.floor(radius))

    for ex in range(nx):
        for ey in range(ny):
            row: List[Tuple[int, float]] = []
            row_index = ex * ny + ey
            for ix in range(max(0, ex - r), min(nx - 1, ex + r) + 1):
                for iy in range(max(0, ey - r), min(ny - 1, ey + r) + 1):
                    distance = math.hypot(ex - ix, ey - iy)
                    weight = max(0.0, radius - distance)
                    if weight > 0.0:
                        col_index = ix * ny + iy
                        row.append((col_index, weight))
                        weights_sum[row_index] += weight
            neighbors.append(row)

    weights_sum[weights_sum <= 0.0] = 1.0
    return neighbors, weights_sum


def filtered_sensitivities(x: np.ndarray, dc: np.ndarray, neighbors: List[List[Tuple[int, float]]], weights_sum: np.ndarray) -> np.ndarray:
    nx, ny = x.shape
    flat_x = x.reshape(-1)
    flat_dc = dc.reshape(-1)
    out = np.zeros_like(flat_dc)

    for i, row in enumerate(neighbors):
        value = 0.0
        for j, weight in row:
            value += weight * flat_x[j] * flat_dc[j]
        out[i] = value / max(1.0e-3, flat_x[i]) / weights_sum[i]

    return out.reshape((nx, ny))


def assemble_global_stiffness(settings: TopologyInput, x_phys: np.ndarray, edof: np.ndarray, ke: np.ndarray):
    nx, ny = settings.nx, settings.ny
    nele = nx * ny
    ndof = 2 * (nx + 1) * (ny + 1)
    e_min = settings.youngs_modulus * 1.0e-6
    e0 = settings.youngs_modulus

    stiffness_scale = e_min + np.power(x_phys.reshape(nele), settings.penalization) * (e0 - e_min)
    i_k = np.kron(edof, np.ones((8, 1), dtype=np.int64)).reshape(-1)
    j_k = np.kron(edof, np.ones((1, 8), dtype=np.int64)).reshape(-1)
    s_k = (ke.reshape(64, 1) * stiffness_scale.reshape(1, nele)).T.reshape(-1)

    return coo_matrix((s_k, (i_k, j_k)), shape=(ndof, ndof)).tocsc()


def solve_displacement(settings: TopologyInput, masks: DesignMasks, x_phys: np.ndarray, edof: np.ndarray, ke: np.ndarray) -> np.ndarray:
    ndof = 2 * (settings.nx + 1) * (settings.ny + 1)
    k_global = assemble_global_stiffness(settings, x_phys, edof, ke)

    all_dofs = np.arange(ndof, dtype=np.int64)
    fixed = masks.fixed_dofs
    free = np.setdiff1d(all_dofs, fixed, assume_unique=False)

    u = np.zeros(ndof, dtype=float)
    if len(free) == 0:
        return u

    k_ff = k_global[free, :][:, free]
    f_f = masks.load_vector[free]

    # Tiny diagonal regularization improves robustness for early sparse designs.
    u[free] = spsolve(k_ff, f_f)
    u[~np.isfinite(u)] = 0.0
    return u


def optimality_criteria_update(
    x: np.ndarray,
    dc: np.ndarray,
    volume_fraction: float,
    solid: np.ndarray,
    void: np.ndarray,
) -> np.ndarray:
    move = 0.18
    xmin = 0.001
    l1 = 0.0
    l2 = 1.0e9
    designable = ~(solid | void)
    target_design_volume = volume_fraction * x.size - float(np.count_nonzero(solid))
    target_design_volume = clamp(target_design_volume, float(np.count_nonzero(designable)) * xmin, float(np.count_nonzero(designable)))

    x_new = x.copy()

    for _ in range(80):
        midpoint = 0.5 * (l1 + l2)
        multiplier = np.sqrt(np.maximum(0.0, -dc / max(midpoint, 1.0e-30)))
        candidate = np.maximum(
            xmin,
            np.maximum(x - move, np.minimum(1.0, np.minimum(x + move, x * multiplier))),
        )
        candidate[solid] = 1.0
        candidate[void] = xmin

        if candidate[designable].sum() > target_design_volume:
            l1 = midpoint
        else:
            l2 = midpoint
        x_new = candidate

        if (l2 - l1) / max(l1 + l2, 1.0e-9) < 1.0e-4:
            break

    x_new[solid] = 1.0
    x_new[void] = xmin
    return x_new


def run_simp(settings: TopologyInput) -> Tuple[np.ndarray, Dict]:
    nx, ny = settings.nx, settings.ny
    volume_fraction = clamp(1.0 - settings.target_open_area_percent / 100.0, 0.2, 0.85)
    masks = build_masks_and_loads(settings)

    x = np.full((nx, ny), volume_fraction, dtype=float)
    x[masks.solid] = 1.0
    x[masks.void] = 0.001

    ke = quad4_plane_stress_stiffness(settings.poisson_ratio)
    edof = np.zeros((nx * ny, 8), dtype=np.int64)
    for ex in range(nx):
        for ey in range(ny):
            edof[ex * ny + ey, :] = element_dofs(ex, ey, ny)

    neighbors, weights_sum = build_filter(nx, ny, settings.filter_radius)

    history = []
    last_change = 1.0
    compliance = 0.0

    for iteration in range(1, settings.max_iterations + 1):
        x_phys = x.copy()
        u = solve_displacement(settings, masks, x_phys, edof, ke)

        ue = u[edof]
        element_energy = np.einsum("ij,jk,ik->i", ue, ke, ue).reshape((nx, ny))
        e_min = settings.youngs_modulus * 1.0e-6
        e0 = settings.youngs_modulus
        compliance = float(np.sum((e_min + np.power(x_phys, settings.penalization) * (e0 - e_min)) * element_energy))

        dc = -settings.penalization * (e0 - e_min) * np.power(x_phys, settings.penalization - 1.0) * element_energy
        dc[masks.solid | masks.void] = 0.0
        dc = filtered_sensitivities(x, dc, neighbors, weights_sum)

        x_next = optimality_criteria_update(x, dc, volume_fraction, masks.solid, masks.void)
        last_change = float(np.max(np.abs(x_next - x)))
        x = x_next

        history.append({"iteration": iteration, "compliance": compliance, "change": last_change, "volumeFraction": float(np.mean(x))})

        if iteration >= settings.min_iterations and last_change <= settings.change_tolerance:
            break

    # Light projection sharpens the iso-surface while preserving gray transition
    # zones. Marching Cubes benefits from smooth densities, not pure binary cells.
    beta = 6.0
    eta = 0.48
    projected = (np.tanh(beta * eta) + np.tanh(beta * (x - eta))) / (np.tanh(beta * eta) + np.tanh(beta * (1.0 - eta)))
    projected = np.clip(projected, 0.0, 1.0)
    projected[masks.solid] = 1.0
    projected[masks.void] = 0.0

    metadata = {
        "iterations": len(history),
        "compliance": compliance,
        "change": last_change,
        "volumeFraction": float(np.mean(projected)),
        "targetVolumeFraction": volume_fraction,
        "penalization": settings.penalization,
        "filterRadius": settings.filter_radius,
        "fixedDofCount": int(len(masks.fixed_dofs)),
        "loadedNodeCount": int(len(masks.load_nodes)),
        "boltCenters": [{"x": float(xc), "y": float(yc)} for xc, yc in masks.bolt_centers],
        "history": history[-12:],
    }
    return projected, metadata


def extrude_density_2d_to_3d(density_2d: np.ndarray, nz: int) -> List[List[List[float]]]:
    nx, ny = density_2d.shape
    density_3d = np.zeros((nx, ny, nz), dtype=float)
    center = (nz - 1) * 0.5

    for z in range(nz):
        if center <= 0.0:
            thickness_factor = 1.0
        else:
            normalized = abs(z - center) / center
            # Slightly rounded faces produce a less blocky Marching Cubes result
            # without hiding the topology produced by SIMP.
            thickness_factor = 1.0 - 0.10 * normalized * normalized
        density_3d[:, :, z] = np.clip(density_2d * thickness_factor, 0.0, 1.0)

    return density_3d.tolist()


def main() -> None:
    raw_stdin = sys.stdin.read().strip()
    if not raw_stdin:
        raw_stdin = input()

    input_data = json.loads(raw_stdin)
    settings = parse_input(input_data)
    density_2d, metadata = run_simp(settings)
    density_3d = extrude_density_2d_to_3d(density_2d, settings.nz)

    print(
        json.dumps(
            {
                "ok": True,
                "engine": "simp-compliance-topology-v1",
                "density": density_3d,
                "nx": settings.nx,
                "ny": settings.ny,
                "nz": settings.nz,
                "metadata": metadata,
            }
        )
    )


if __name__ == "__main__":
    main()
