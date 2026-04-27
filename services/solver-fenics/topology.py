import json
import numpy as np


def generate_density(nx=40, ny=40, nz=12, load_direction="vertical"):
    density = np.ones((nx, ny, nz), dtype=float)

    for x in range(nx):
        for y in range(ny):
            for z in range(nz):
                if load_direction == "vertical":
                    normalized_height = y / max(ny - 1, 1)
                    density[x, y, z] *= 1.0 - normalized_height * 0.65
                elif load_direction == "lateral":
                    normalized_width = x / max(nx - 1, 1)
                    density[x, y, z] *= 1.0 - normalized_width * 0.65
                else:
                    normalized_height = y / max(ny - 1, 1)
                    normalized_width = x / max(nx - 1, 1)
                    density[x, y, z] *= 1.0 - (normalized_height + normalized_width) * 0.32

    threshold = 0.42
    density[density < threshold] = 0.0

    return density.tolist()


def main():
    raw_input = input()
    input_data = json.loads(raw_input)

    density = generate_density(
        nx=input_data.get("nx", 40),
        ny=input_data.get("ny", 40),
        nz=input_data.get("nz", 12),
        load_direction=input_data.get("loadDirection", "vertical")
    )

    print(json.dumps({
        "ok": True,
        "engine": "fenics-topology-placeholder",
        "density": density
    }))


if __name__ == "__main__":
    main()
