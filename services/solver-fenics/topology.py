import json
import math
import numpy as np


def clamp(value, low, high):
    return max(low, min(high, value))


def gaussian(distance, sigma):
    sigma = max(float(sigma), 1e-6)
    return math.exp(-(distance * distance) / (2.0 * sigma * sigma))


def distance_point_to_segment(px, py, ax, ay, bx, by):
    abx = bx - ax
    aby = by - ay
    apx = px - ax
    apy = py - ay
    length_sq = abx * abx + aby * aby

    if length_sq <= 1e-9:
        return math.hypot(px - ax, py - ay)

    t = clamp((apx * abx + apy * aby) / length_sq, 0.0, 1.0)
    cx = ax + abx * t
    cy = ay + aby * t

    return math.hypot(px - cx, py - cy)


def build_anchor_points(nx, ny, bolt_count, load_direction):
    bolt_count = int(clamp(round(bolt_count), 1, 8))

    bottom_y = ny * 0.14
    top_y = ny * 0.84

    if bolt_count == 1:
        bolts = [(nx * 0.5, bottom_y)]
    elif bolt_count == 2:
        bolts = [(nx * 0.28, bottom_y), (nx * 0.72, bottom_y)]
    elif bolt_count == 3:
        bolts = [(nx * 0.25, bottom_y), (nx * 0.75, bottom_y), (nx * 0.5, top_y)]
    elif bolt_count == 4:
        bolts = [
            (nx * 0.25, bottom_y),
            (nx * 0.75, bottom_y),
            (nx * 0.25, top_y),
            (nx * 0.75, top_y),
        ]
    else:
        bolts = []
        radius_x = nx * 0.32
        radius_y = ny * 0.36
        for index in range(bolt_count):
            angle = -math.pi / 2.0 + (math.pi * 2.0 * index) / bolt_count
            bolts.append((nx * 0.5 + math.cos(angle) * radius_x, ny * 0.5 + math.sin(angle) * radius_y))

    if load_direction == "lateral":
        loads = [(nx * 0.86, ny * 0.36), (nx * 0.86, ny * 0.64)]
    elif load_direction == "multi-axis":
        loads = [(nx * 0.5, top_y), (nx * 0.35, ny * 0.72), (nx * 0.65, ny * 0.72)]
    else:
        loads = [(nx * 0.5, top_y), (nx * 0.38, top_y), (nx * 0.62, top_y)]

    return bolts, loads


def generate_density(
    nx=48,
    ny=48,
    nz=14,
    load_direction="vertical",
    bolt_count=2,
    target_open_area=45,
    safety_factor=1.5,
    force_n=2500,
):
    density = np.zeros((nx, ny, nz), dtype=float)

    bolts, loads = build_anchor_points(nx, ny, bolt_count, load_direction)

    load_scale = clamp(force_n / 2500.0, 0.75, 1.6)
    safety_scale = clamp(safety_factor / 1.5, 0.8, 1.45)

    primary_sigma = max(nx, ny) * 0.045 * load_scale * safety_scale
    secondary_sigma = max(nx, ny) * 0.032 * safety_scale
    node_sigma = max(nx, ny) * 0.052 * safety_scale
    bolt_sigma = max(nx, ny) * 0.06 * safety_scale

    material_budget = clamp(1.0 - target_open_area / 100.0, 0.22, 0.72)

    center_x = nx * 0.5
    center_y = ny * 0.48

    for x in range(nx):
        for y in range(ny):
            dx_edge = min(x, nx - 1 - x)
            dy_edge = min(y, ny - 1 - y)

            field = 0.0

            # Preserve minimal manufacturing frame.
            edge_strength = 0.0
            if dx_edge < nx * 0.035:
                edge_strength = max(edge_strength, 0.52)
            if dy_edge < ny * 0.035:
                edge_strength = max(edge_strength, 0.52)

            field = max(field, edge_strength)

            # Bolt pads.
            for bx, by in bolts:
                d = math.hypot(x - bx, y - by)
                field = max(field, gaussian(d, bolt_sigma) * 1.18)

            # Load interface pads.
            for lx, ly in loads:
                d = math.hypot(x - lx, y - ly)
                field = max(field, gaussian(d, node_sigma) * 1.05)

            # Primary physics-inspired load paths: bolt to load points.
            for bx, by in bolts:
                for lx, ly in loads:
                    d = distance_point_to_segment(x, y, bx, by, lx, ly)
                    path = gaussian(d, primary_sigma)
                    along_bias = 1.0

                    dist_bolt = math.hypot(x - bx, y - by)
                    dist_load = math.hypot(x - lx, y - ly)
                    total = max(dist_bolt + dist_load, 1.0)
                    balance = 1.0 - abs(dist_bolt - dist_load) / total
                    along_bias += balance * 0.18

                    field = max(field, path * along_bias)

            # Two-bolt stabilizing bridge and split load arch.
            if len(bolts) == 2:
                left_bolt, right_bolt = bolts

                bridge_y = (left_bolt[1] + right_bolt[1]) * 0.5
                bridge_d = distance_point_to_segment(
                    x,
                    y,
                    left_bolt[0],
                    bridge_y,
                    right_bolt[0],
                    bridge_y,
                )
                field = max(field, gaussian(bridge_d, secondary_sigma) * 0.75)

                top_load = loads[0]
                mid_node = (center_x, center_y)

                d_left = distance_point_to_segment(x, y, left_bolt[0], left_bolt[1], mid_node[0], mid_node[1])
                d_right = distance_point_to_segment(x, y, right_bolt[0], right_bolt[1], mid_node[0], mid_node[1])
                d_top = distance_point_to_segment(x, y, mid_node[0], mid_node[1], top_load[0], top_load[1])

                field = max(field, gaussian(d_left, primary_sigma * 0.9) * 1.05)
                field = max(field, gaussian(d_right, primary_sigma * 0.9) * 1.05)
                field = max(field, gaussian(d_top, primary_sigma * 0.82) * 1.0)

                # Curved organic arch approximation.
                arch_center_y = ny * 0.23
                arch_radius = nx * 0.34
                arch_value = abs(math.hypot(x - center_x, y - arch_center_y) - arch_radius)
                if y > bridge_y:
                    field = max(field, gaussian(arch_value, secondary_sigma * 0.95) * 0.68)

            # Mild core node.
            core_d = math.hypot(x - center_x, y - center_y)
            field = max(field, gaussian(core_d, node_sigma * 0.75) * 0.82)

            # Remove overly solid central block bias.
            void_bias = gaussian(abs(x - center_x), nx * 0.18) * gaussian(abs(y - ny * 0.5), ny * 0.22)
            field -= void_bias * 0.12

            field = clamp(field, 0.0, 1.4)

            for z in range(nz):
                z_center = (nz - 1) * 0.5
                z_dist = abs(z - z_center) / max(z_center, 1.0)

                shell_bias = 1.0 - z_dist * 0.12
                density[x, y, z] = field * shell_bias

    # Hard remove actual bolt holes.
    hole_radius = max(nx, ny) * 0.035
    for x in range(nx):
        for y in range(ny):
            for bx, by in bolts:
                if math.hypot(x - bx, y - by) < hole_radius:
                    density[x, y, :] = 0.0

    # Threshold based on target material budget.
    flat = density.flatten()
    nonzero = flat[flat > 0.001]

    if len(nonzero) > 0:
        keep_fraction = material_budget
        threshold_index = int(clamp((1.0 - keep_fraction) * len(nonzero), 0, len(nonzero) - 1))
        threshold = np.sort(nonzero)[threshold_index]
    else:
        threshold = 0.5

    density[density < threshold] = 0.0
    density[density >= threshold] = 1.0

    return density.tolist()


def main():
    raw_input = input()
    input_data = json.loads(raw_input)

    density = generate_density(
        nx=input_data.get("nx", 48),
        ny=input_data.get("ny", 48),
        nz=input_data.get("nz", 14),
        load_direction=input_data.get("loadDirection", "vertical"),
        bolt_count=input_data.get("boltCount", 2),
        target_open_area=input_data.get("targetOpenAreaPercent", 45),
        safety_factor=input_data.get("safetyFactor", 1.5),
        force_n=input_data.get("forceN", 2500),
    )

    print(json.dumps({
        "ok": True,
        "engine": "fenics-topology-placeholder-v2-loadpath-density",
        "density": density
    }))


if __name__ == "__main__":
    main()
