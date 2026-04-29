#!/usr/bin/env python3
"""
Helvarix Advanced Fabricator — topology.py

Path:
  services/solver-fenics/topology.py

Action:
  REPLACE the existing file.

Phase 2 objective:
  Strong + manufacturable bracket topology, tuned for Render response time.

This solver intentionally prioritizes:
  - thicker members
  - multiple load paths
  - bolt-boss/load-pad preservation
  - less fragile one-line topology
  - smoother density suitable for surface extraction

It does NOT fake geometry.
It returns only a solver-derived density field.
If the numerical solve fails, it returns ok:false.
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
        "topology.py requires scipy. Add scipy to services/solver-fenics/requirements.txt "
        "and redeploy the Render worker."
    ) from exc


ENGINE = "haf-simp-manufacturable-bracket-v4-fast"


@dataclass
class TopologyInput:
    nx: int = 56
    ny: int = 36
    nz: int = 14
    load_direction: str = "vertical"
    bolt_count: int = 2
    target_open_area_percent: float = 48.0
    safety_factor: float = 1.5
    force_n: float = 2500.0
    max_iterations: int = 62
    min_iterations: int = 24
    change_tolerance: float = 0.014
    penalization: float = 3.15
    filter_radius: float = 2.8
    poisson_ratio: float = 0.33
    manufacturing_bias: float = 0.50
    minimum_member_radius: float = 2.3


@dataclass
class ModelDefinition:
    forced_solid: np.ndarray
    forced_void: np.ndarray
    preferred_structure: np.ndarray
    fixed_dofs: np.ndarray
    force: np.ndarray
    bolt_centers: List[Tuple[float, float]]
    load_center: Tuple[float, float]
    load_nodes: List[Tuple[int, int]]


def clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def parse_input(raw: Dict[str, Any]) -> TopologyInput:
    target_open = float(raw.get("targetOpenAreaPercent", 48.0))
    target_open = clamp(target_open, 38.0, 62.0)

    return TopologyInput(
        nx=int(clamp(int(raw.get("nx", 56)), 32, 72)),
        ny=int(clamp(int(raw.get("ny", 36)), 24, 56)),
        nz=int(clamp(int(raw.get("nz", 14)), 8, 24)),
        load_direction=str(raw.get("loadDirection", "vertical")).lower().strip(),
        bolt_count=int(clamp(int(raw.get("boltCount", 2)), 1, 8)),
        target_open_area_percent=target_open,
        safety_factor=float(clamp(float(raw.get("safetyFactor", 1.5)), 1.0, 4.0)),
        force_n=float(clamp(float(raw.get("forceN", 2500.0)), 10.0, 1.0e7)),
        max_iterations=int(clamp(int(raw.get("maxIterations", 62)), 35, 85)),
        min_iterations=int(clamp(int(raw.get("minIterations", 24)), 12, 40)),
        change_tolerance=float(clamp(float(raw.get("changeTolerance", 0.014)), 0.006, 0.05)),
        penalization=float(clamp(float(raw.get("penalization", 3.15)), 2.4, 4.2)),
        filter_radius=float(clamp(float(raw.get("filterRadius", 2.8)), 1.8, 4.2)),
        poisson_ratio=float(clamp(float(raw.get("poissonRatio", 0.33)), 0.05, 0.49)),
        manufacturing_bias=float(clamp(float(raw.get("manufacturingBias", 0.50)), 0.30, 0.70)),
        minimum_member_radius=float(clamp(float(raw.get("minimumMemberRadius", 2.3)), 1.6, 4.2)),
    )


def node_id(ix: int, iy: int, ny: int) -> int:
    return ix * (ny + 1) + iy


def element_id(ix: int, iy: int, ny: int) -> int:
    return ix * ny + iy


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

    for ix in range(nx):
        for iy in range(ny):
            e = element_id(ix, iy, ny)
            n1 = node_id(ix, iy, ny)
            n2 = node_id(ix + 1, iy, ny)
            n3 = node_id(ix + 1, iy + 1, ny)
            n4 = node_id(ix, iy + 1, ny)
            edof[e] = [2 * n1, 2 * n1 + 1, 2 * n2, 2 * n2 + 1, 2 * n3, 2 * n3 + 1, 2 * n4, 2 * n4 + 1]

    return edof


def mark_disk(mask: np.ndarray, cx: float, cy: float, radius: float, value: bool = True) -> None:
    nx, ny = mask.shape
    x = np.arange(nx) + 0.5
    y = np.arange(ny) + 0.5
    xx, yy = np.meshgrid(x, y, indexing="ij")
    mask[np.hypot(xx - cx, yy - cy) <= radius] = value


def add_disk_value(field: np.ndarray, cx: float, cy: float, radius: float, value: float) -> None:
    nx, ny = field.shape
    x = np.arange(nx) + 0.5
    y = np.arange(ny) + 0.5
    xx, yy = np.meshgrid(x, y, indexing="ij")
    dist = np.hypot(xx - cx, yy - cy)
    inside = dist <= radius
    if radius <= 0:
        return
    falloff = np.clip(1.0 - dist / radius, 0.0, 1.0)
    field[inside] = np.maximum(field[inside], value * (0.35 + 0.65 * falloff[inside]))


def mark_path(mask: np.ndarray, ax: float, ay: float, bx: float, by: float, radius: float) -> None:
    nx, ny = mask.shape
    x = np.arange(nx) + 0.5
    y = np.arange(ny) + 0.5
    xx, yy = np.meshgrid(x, y, indexing="ij")
    vx = bx - ax
    vy = by - ay
    denom = max(vx * vx + vy * vy, 1.0e-9)
    t = np.clip(((xx - ax) * vx + (yy - ay) * vy) / denom, 0.0, 1.0)
    px = ax + t * vx
    py = ay + t * vy
    mask[np.hypot(xx - px, yy - py) <= radius] = True


def add_path_value(field: np.ndarray, ax: float, ay: float, bx: float, by: float, radius: float, value: float) -> None:
    nx, ny = field.shape
    x = np.arange(nx) + 0.5
    y = np.arange(ny) + 0.5
    xx, yy = np.meshgrid(x, y, indexing="ij")
    vx = bx - ax
    vy = by - ay
    denom = max(vx * vx + vy * vy, 1.0e-9)
    t = np.clip(((xx - ax) * vx + (yy - ay) * vy) / denom, 0.0, 1.0)
    px = ax + t * vx
    py = ay + t * vy
    dist = np.hypot(xx - px, yy - py)
    inside = dist <= radius
    falloff = np.clip(1.0 - dist / max(radius, 1.0e-9), 0.0, 1.0)
    field[inside] = np.maximum(field[inside], value * (0.30 + 0.70 * falloff[inside]))


def compute_bolt_centers(nx: int, ny: int, bolt_count: int) -> List[Tuple[float, float]]:
    bottom_y = ny * 0.20
    top_y = ny * 0.75
    if bolt_count == 1:
        return [(nx * 0.50, bottom_y)]
    if bolt_count == 2:
        return [(nx * 0.25, bottom_y), (nx * 0.75, bottom_y)]
    if bolt_count == 3:
        return [(nx * 0.22, bottom_y), (nx * 0.78, bottom_y), (nx * 0.50, top_y)]
    if bolt_count == 4:
        return [(nx * 0.22, bottom_y), (nx * 0.78, bottom_y), (nx * 0.22, top_y), (nx * 0.78, top_y)]
    centers: List[Tuple[float, float]] = []
    for i in range(bolt_count):
        angle = -math.pi / 2.0 + 2.0 * math.pi * i / bolt_count
        centers.append((nx * 0.50 + math.cos(angle) * nx * 0.34, ny * 0.48 + math.sin(angle) * ny * 0.31))
    return centers


def compute_load_nodes(nx: int, ny: int, direction: str) -> Tuple[List[Tuple[int, int]], Tuple[float, float]]:
    if direction == "lateral":
        y_center = int(round(ny * 0.56))
        patch = max(2, int(round(ny * 0.075)))
        return [(nx, y) for y in range(max(0, y_center - patch), min(ny, y_center + patch) + 1)], (nx * 0.93, float(y_center))
    if direction == "multi-axis":
        patch = max(2, int(round(nx * 0.08)))
        x_center = int(round(nx * 0.50))
        top_nodes = [(x, ny) for x in range(max(0, x_center - patch), min(nx, x_center + patch) + 1)]
        side_nodes = [(nx, y) for y in range(int(ny * 0.48), int(ny * 0.64) + 1)]
        return top_nodes + side_nodes, (nx * 0.60, ny * 0.90)
    patch = max(3, int(round(nx * 0.085)))
    x_center = int(round(nx * 0.50))
    return [(x, ny) for x in range(max(0, x_center - patch), min(nx, x_center + patch) + 1)], (float(x_center), ny * 0.88)


def build_model(s: TopologyInput) -> ModelDefinition:
    nx, ny = s.nx, s.ny
    ndof = 2 * (nx + 1) * (ny + 1)
    forced_solid = np.zeros((nx, ny), dtype=bool)
    forced_void = np.zeros((nx, ny), dtype=bool)
    preferred = np.zeros((nx, ny), dtype=float)
    ref = max(nx, ny)
    bolt_hole_radius = ref * 0.038
    bolt_boss_radius = ref * 0.105
    load_pad_radius = ref * 0.095
    main_member_radius = max(s.minimum_member_radius, ref * 0.034)
    secondary_member_radius = max(s.minimum_member_radius * 0.72, ref * 0.022)
    ring_radius = ref * 0.110
    centers = compute_bolt_centers(nx, ny, s.bolt_count)
    loads, load_center = compute_load_nodes(nx, ny, s.load_direction)

    for bx, by in centers:
        mark_disk(forced_void, bx, by, bolt_hole_radius, True)
        mark_disk(forced_solid, bx, by, bolt_boss_radius, True)
        add_disk_value(preferred, bx, by, ring_radius, 1.0)
    mark_disk(forced_solid, load_center[0], load_center[1], load_pad_radius, True)
    add_disk_value(preferred, load_center[0], load_center[1], load_pad_radius * 1.25, 1.0)

    for bx, by in centers:
        mark_path(forced_solid, bx, by, load_center[0], load_center[1], secondary_member_radius * 0.55)
        add_path_value(preferred, bx, by, load_center[0], load_center[1], main_member_radius, 0.95)

    if len(centers) >= 2:
        lower = sorted(centers, key=lambda p: p[1])[: min(2, len(centers))]
        if len(lower) == 2:
            add_path_value(preferred, lower[0][0], lower[0][1], lower[1][0], lower[1][1], main_member_radius * 0.95, 0.82)
            mark_path(forced_solid, lower[0][0], lower[0][1], lower[1][0], lower[1][1], secondary_member_radius * 0.45)

    for bx, by in centers:
        offset = (-1 if bx > nx * 0.5 else 1) * nx * 0.08
        add_path_value(preferred, bx, by, load_center[0] + offset, load_center[1] - ny * 0.08, secondary_member_radius, 0.58)

    border = max(1, int(round(ref * 0.018)))
    forced_void[:border, :] = True
    forced_void[-border:, :] = True
    forced_void[:, :border] = True
    forced_void[:, -border:] = True
    for bx, by in centers:
        mark_disk(forced_void, bx, by, bolt_hole_radius, True)
        mark_disk(forced_solid, bx, by, bolt_boss_radius, True)
    mark_disk(forced_solid, load_center[0], load_center[1], load_pad_radius, True)
    forced_solid[forced_void] = False

    fixed = set()
    fixed_radius_inner = bolt_hole_radius * 0.90
    fixed_radius_outer = bolt_boss_radius * 0.82
    for ix in range(nx + 1):
        for iy in range(ny + 1):
            for bx, by in centers:
                d = math.hypot(ix - bx, iy - by)
                if fixed_radius_inner <= d <= fixed_radius_outer:
                    n = node_id(ix, iy, ny)
                    fixed.add(2 * n)
                    fixed.add(2 * n + 1)
    if not fixed:
        for bx, by in centers:
            ix = int(round(clamp(bx, 0, nx)))
            iy = int(round(clamp(by, 0, ny)))
            n = node_id(ix, iy, ny)
            fixed.add(2 * n)
            fixed.add(2 * n + 1)

    force = np.zeros(ndof, dtype=float)
    per_node_force = s.force_n * s.safety_factor / max(1, len(loads))
    for ix, iy in loads:
        ix = int(clamp(ix, 0, nx))
        iy = int(clamp(iy, 0, ny))
        n = node_id(ix, iy, ny)
        if s.load_direction == "lateral":
            force[2 * n] += per_node_force
        elif s.load_direction == "multi-axis":
            force[2 * n] += per_node_force * 0.35
            force[2 * n + 1] -= per_node_force * 0.90
        else:
            force[2 * n + 1] -= per_node_force

    preferred[forced_solid] = 1.0
    preferred[forced_void] = 0.0
    return ModelDefinition(forced_solid, forced_void, np.clip(preferred, 0.0, 1.0), np.array(sorted(fixed), dtype=np.int64), force, centers, load_center, loads)


def build_filter(nx: int, ny: int, radius: float) -> Tuple[Any, np.ndarray]:
    rows: List[int] = []
    cols: List[int] = []
    data: List[float] = []
    r = int(math.ceil(radius))
    for ix in range(nx):
        for iy in range(ny):
            row = element_id(ix, iy, ny)
            for kx in range(max(0, ix - r), min(nx, ix + r + 1)):
                for ky in range(max(0, iy - r), min(ny, iy + r + 1)):
                    col = element_id(kx, ky, ny)
                    distance = math.sqrt((ix - kx) ** 2 + (iy - ky) ** 2)
                    weight = max(0.0, radius - distance)
                    if weight > 0:
                        rows.append(row)
                        cols.append(col)
                        data.append(weight)
    h = coo_matrix((data, (rows, cols)), shape=(nx * ny, nx * ny)).tocsr()
    hs = np.asarray(h.sum(axis=1)).ravel()
    hs[hs == 0] = 1.0
    return h, hs


def assemble_and_solve(density: np.ndarray, edof: np.ndarray, ke: np.ndarray, free_dofs: np.ndarray, force: np.ndarray, penalization: float) -> Tuple[np.ndarray, np.ndarray, np.ndarray, float]:
    ndof = force.size
    i_k = np.kron(edof, np.ones((8, 1), dtype=np.int64)).ravel()
    j_k = np.kron(edof, np.ones((1, 8), dtype=np.int64)).ravel()
    e_min = 1.0e-5
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
    return u, dc.reshape(density.shape), ce.reshape(density.shape), compliance


def local_average(x: np.ndarray, radius: int) -> np.ndarray:
    nx, ny = x.shape
    out = np.zeros_like(x)
    for ix in range(nx):
        for iy in range(ny):
            total = 0.0
            weight = 0.0
            for dx in range(-radius, radius + 1):
                for dy in range(-radius, radius + 1):
                    dist = math.sqrt(dx * dx + dy * dy)
                    if dist > radius + 0.001:
                        continue
                    sx = ix + dx
                    sy = iy + dy
                    if sx < 0 or sy < 0 or sx >= nx or sy >= ny:
                        continue
                    w = 1.0 / (1.0 + dist)
                    total += x[sx, sy] * w
                    weight += w
            out[ix, iy] = total / max(weight, 1.0e-9)
    return out


def filter_sensitivity(x: np.ndarray, dc: np.ndarray, h: Any, hs: np.ndarray) -> np.ndarray:
    x_flat = x.ravel()
    dc_flat = dc.ravel()
    filtered = np.asarray((h @ (x_flat * dc_flat)) / np.maximum(1.0e-9, hs * np.maximum(0.001, x_flat))).ravel()
    return np.minimum(filtered.reshape(x.shape), -1.0e-12)


def optimality_update(x: np.ndarray, dc: np.ndarray, target_volume_fraction: float, forced_solid: np.ndarray, forced_void: np.ndarray) -> np.ndarray:
    x_flat = x.ravel()
    dc_flat = np.minimum(dc.ravel(), -1.0e-12)
    solid_flat = forced_solid.ravel()
    void_flat = forced_void.ravel()
    designable = ~(solid_flat | void_flat)
    total = float(x_flat.size)
    passive_solid = float(np.count_nonzero(solid_flat))
    passive_void = float(np.count_nonzero(void_flat))
    designable_target = clamp((target_volume_fraction * total - passive_solid) / max(1.0, total - passive_solid - passive_void), 0.16, 0.94)
    move = 0.115
    low = 0.0
    high = 1.0e9
    candidate = x_flat.copy()
    while high - low > 1.0e-4:
        mid = 0.5 * (low + high)
        update = x_flat * np.sqrt(-dc_flat / max(mid, 1.0e-12))
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


def dilate_2d(x: np.ndarray, radius: int) -> np.ndarray:
    nx, ny = x.shape
    out = np.copy(x)
    for ix in range(nx):
        for iy in range(ny):
            best = x[ix, iy]
            for dx in range(-radius, radius + 1):
                for dy in range(-radius, radius + 1):
                    dist = math.sqrt(dx * dx + dy * dy)
                    if dist > radius + 0.001:
                        continue
                    sx = ix + dx
                    sy = iy + dy
                    if sx < 0 or sy < 0 or sx >= nx or sy >= ny:
                        continue
                    falloff = 1.0 - dist / (radius + 1.0)
                    best = max(best, x[sx, sy] * (0.70 + 0.30 * falloff))
            out[ix, iy] = best
    return out


def erode_2d(x: np.ndarray, radius: int) -> np.ndarray:
    nx, ny = x.shape
    out = np.copy(x)
    for ix in range(nx):
        for iy in range(ny):
            worst = x[ix, iy]
            for dx in range(-radius, radius + 1):
                for dy in range(-radius, radius + 1):
                    dist = math.sqrt(dx * dx + dy * dy)
                    if dist > radius + 0.001:
                        continue
                    sx = ix + dx
                    sy = iy + dy
                    if sx < 0 or sy < 0 or sx >= nx or sy >= ny:
                        worst = 0.0
                        continue
                    worst = min(worst, x[sx, sy])
            out[ix, iy] = worst
    return out


def morphological_close_open(x: np.ndarray, radius: int, forced_solid: np.ndarray, forced_void: np.ndarray) -> np.ndarray:
    y = dilate_2d(x, radius)
    y = erode_2d(y, radius)
    y = erode_2d(y, max(1, radius - 1))
    y = dilate_2d(y, max(1, radius - 1))
    y = 0.62 * y + 0.38 * x
    y[forced_solid] = 1.0
    y[forced_void] = 0.0
    return np.clip(y, 0.0, 1.0)


def projection(x: np.ndarray, beta: float, eta: float) -> np.ndarray:
    numerator = np.tanh(beta * eta) + np.tanh(beta * (x - eta))
    denominator = np.tanh(beta * eta) + np.tanh(beta * (1.0 - eta))
    return np.clip(numerator / denominator, 0.0, 1.0)


def connected_component_cleanup(x: np.ndarray, forced_solid: np.ndarray, threshold: float = 0.30) -> np.ndarray:
    nx, ny = x.shape
    solid = x >= threshold
    seeds = list(zip(*np.where(forced_solid)))
    if not seeds:
        return x
    visited = np.zeros_like(solid, dtype=bool)
    queue: List[Tuple[int, int]] = []
    for sx, sy in seeds:
        if solid[sx, sy]:
            visited[sx, sy] = True
            queue.append((int(sx), int(sy)))
    head = 0
    while head < len(queue):
        ix, iy = queue[head]
        head += 1
        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            nx_i = ix + dx
            ny_i = iy + dy
            if nx_i < 0 or ny_i < 0 or nx_i >= nx or ny_i >= ny:
                continue
            if visited[nx_i, ny_i] or not solid[nx_i, ny_i]:
                continue
            visited[nx_i, ny_i] = True
            queue.append((nx_i, ny_i))
    cleaned = np.copy(x)
    cleaned[np.logical_and(solid, ~visited)] = 0.0
    return cleaned


def run_simp(s: TopologyInput) -> Tuple[np.ndarray, Dict[str, Any]]:
    nx, ny = s.nx, s.ny
    target_volume_fraction = clamp(1.0 - s.target_open_area_percent / 100.0, 0.38, 0.68)
    model = build_model(s)
    edof = build_edof(nx, ny)
    ke = quad4_plane_stress_ke(s.poisson_ratio)
    all_dofs = np.arange(model.force.size)
    free_dofs = np.setdiff1d(all_dofs, model.fixed_dofs)
    h, hs = build_filter(nx, ny, s.filter_radius)
    x = np.full((nx, ny), target_volume_fraction, dtype=float)
    x = np.maximum(x, model.preferred_structure * s.manufacturing_bias)
    x[model.forced_solid] = 1.0
    x[model.forced_void] = 0.001
    history: List[Dict[str, float]] = []
    compliance = 0.0
    change = 1.0

    for iteration in range(1, s.max_iterations + 1):
        _u, dc, ce, compliance = assemble_and_solve(x, edof, ke, free_dofs, model.force, s.penalization)
        dc = filter_sensitivity(x, dc, h, hs)
        reward = -s.manufacturing_bias * model.preferred_structure * (1.20 - np.clip(x, 0.0, 1.0))
        thickness_reward = -0.20 * np.clip(local_average(x, 2) - x, 0.0, 1.0)
        dc = dc + reward + thickness_reward
        updated = optimality_update(x, dc, target_volume_fraction, model.forced_solid, model.forced_void)
        if iteration % 4 == 0 or iteration < 18:
            updated = morphological_close_open(updated, max(1, int(round(s.minimum_member_radius * 0.55))), model.forced_solid, model.forced_void)
        if iteration <= max(25, s.min_iterations):
            taper = 1.0 - (iteration / max(1.0, float(max(25, s.min_iterations))))
            blend = s.manufacturing_bias * 0.26 * taper
            updated = np.maximum(updated, model.preferred_structure * blend)
        updated[model.forced_solid] = 1.0
        updated[model.forced_void] = 0.001
        change = float(np.max(np.abs(updated - x)))
        x = updated
        if iteration == 1 or iteration % 5 == 0:
            history.append({"iteration": float(iteration), "compliance": float(compliance), "change": float(change), "meanDensity": float(np.mean(x)), "maxElementEnergy": float(np.max(ce))})
        if iteration >= s.min_iterations and change <= s.change_tolerance:
            break

    x = morphological_close_open(x, max(1, int(round(s.minimum_member_radius * 0.75))), model.forced_solid, model.forced_void)
    x = 0.82 * x + 0.18 * model.preferred_structure
    x[model.forced_solid] = 1.0
    x[model.forced_void] = 0.0
    projected = projection(x, beta=7.5, eta=0.42)
    projected = connected_component_cleanup(projected, model.forced_solid, threshold=0.22)
    projected[model.forced_solid] = 1.0
    projected[model.forced_void] = 0.0
    projected = np.where(projected >= 0.10, projected, 0.0)

    metadata = {
        "engine": ENGINE,
        "priority": "strong-manufacturable",
        "iterations": int(history[-1]["iteration"]) if history else s.max_iterations,
        "converged": bool(change <= s.change_tolerance),
        "compliance": round(float(compliance), 6),
        "change": round(float(change), 6),
        "volumeFraction": round(float(np.mean(projected)), 4),
        "targetVolumeFraction": round(float(target_volume_fraction), 4),
        "targetOpenAreaPercent": round(float(s.target_open_area_percent), 2),
        "manufacturingBias": round(float(s.manufacturing_bias), 3),
        "minimumMemberRadius": round(float(s.minimum_member_radius), 3),
        "penalization": round(float(s.penalization), 3),
        "filterRadius": round(float(s.filter_radius), 3),
        "fixedDofCount": int(len(model.fixed_dofs)),
        "forceNorm": round(float(np.linalg.norm(model.force)), 4),
        "boltCenters": [{"x": round(float(x0), 3), "y": round(float(y0), 3)} for x0, y0 in model.bolt_centers],
        "loadCenter": {"x": round(float(model.load_center[0]), 3), "y": round(float(model.load_center[1]), 3)},
        "loadNodeCount": int(len(model.load_nodes)),
        "forcedSolidCells": int(np.count_nonzero(model.forced_solid)),
        "forcedVoidCells": int(np.count_nonzero(model.forced_void)),
        "preferredStructureCells": int(np.count_nonzero(model.preferred_structure > 0.25)),
        "history": history[-16:],
    }
    return projected, metadata


def extrude_to_3d(density_2d: np.ndarray, nz: int) -> List[List[List[float]]]:
    nx, ny = density_2d.shape
    out = np.zeros((nx, ny, nz), dtype=float)
    mid = (nz - 1) * 0.5
    for iz in range(nz):
        d = abs(iz - mid) / max(mid, 1.0e-9)
        profile = 1.0 - 0.18 * (d ** 2)
        if d < 0.62:
            profile = max(profile, 0.94)
        out[:, :, iz] = np.clip(density_2d * profile, 0.0, 1.0)
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
    print(json.dumps({"ok": True, "engine": ENGINE, "density": density_3d, "nx": s.nx, "ny": s.ny, "nz": s.nz, "metadata": metadata}, separators=(",", ":")))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(json.dumps({"ok": False, "engine": ENGINE, "error": str(exc), "traceback": traceback.format_exc()}, separators=(",", ":")))
        sys.exit(1)
