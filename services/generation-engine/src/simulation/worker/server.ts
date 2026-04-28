import http from "node:http";

import { runFenicsTopology } from "../../../../solver-fenics/index";

import {
  submitRemoteSimulationMock,
  getRemoteSimulationStatusMock,
  getRemoteSimulationResultMock,
  persistHighFidelitySimulationResult,
  persistRemoteSimulationFailure,
} from "../execution/remoteWorkerMock";

import { runHighFidelityPipeline } from "../execution/highFidelityPipeline";

import { RemoteSimulationSubmitRequest } from "../execution/remoteJobTypes";

const PORT = Number(process.env.PORT ?? 8787);

const ENABLE_NATIVE_SOLVERS =
  process.env.HELVARIX_ENABLE_NATIVE_SOLVERS === "true";

const WORKSPACE_ROOT =
  process.env.HELVARIX_SOLVER_WORKSPACE_ROOT ?? "/tmp/helvarix-solver";

const GMSH_EXEC = process.env.HELVARIX_GMSH_EXECUTABLE ?? "gmsh";
const CCX_EXEC = process.env.HELVARIX_CALCULIX_EXECUTABLE ?? "ccx";

type Vec3 = [number, number, number];

type RenderFace = {
  indices: number[];
  group?: string;
  shade?: number;
};

type RenderMesh = {
  version: string;
  units: "mm";
  family: string;
  vertices: Vec3[];
  faces: RenderFace[];
  features: Array<Record<string, unknown>>;
  bounds: {
    widthMm: number;
    heightMm: number;
    depthMm: number;
  };
  metadata: Record<string, unknown>;
};

type TopologyRequest = {
  componentFamily?: string;
  componentName?: string;
  candidateId?: string;
  requireMesh?: boolean;
  loadCase?: {
    forceN?: number;
    direction?: string;
    safetyFactor?: number;
    vibrationHz?: number;
  };
  mounting?: {
    boltCount?: number;
    boltDiameterMm?: number;
    spacingMm?: number;
  };
  envelope?: {
    widthMm?: number;
    heightMm?: number;
    depthMm?: number;
    maxWidthMm?: number;
    maxHeightMm?: number;
    maxDepthMm?: number;
  };
  manufacturing?: {
    minWallThicknessMm?: number;
    maxOverhangDeg?: number;
    supportAllowed?: boolean;
  };
  objectives?: {
    targetOpenAreaPercent?: number;
    targetMassKg?: number;
    priority?: string;
  };
  material?: Record<string, unknown>;
  nx?: number;
  ny?: number;
  nz?: number;
  loadDirection?: string;
  boltCount?: number;
  targetOpenAreaPercent?: number;
  safetyFactor?: number;
  forceN?: number;
  maxIterations?: number;
  minIterations?: number;
  changeTolerance?: number;
  penalization?: number;
  filterRadius?: number;
  youngsModulus?: number;
  poissonRatio?: number;
};

const server = http.createServer(async (req, res) => {
  try {
    setCors(res);

    if (req.method === "OPTIONS") {
      return respond(res, 204, {});
    }

    if (!req.url) {
      return respond(res, 400, { error: "Missing URL" });
    }

    if (req.method === "GET" && req.url === "/health") {
      return respond(res, 200, {
        ok: true,
        service: "helvarix-solver-worker",
        nativeSolversEnabled: ENABLE_NATIVE_SOLVERS,
        routes: [
          "GET /health",
          "GET /fenics-test",
          "POST /fenics-test",
          "POST /topology/optimize",
          "POST /topology/mesh",
          "POST /simulation/submit",
          "GET /simulation/status/:id",
          "GET /simulation/result/:id",
        ],
        timestamp: new Date().toISOString(),
      });
    }

    if (req.method === "GET" && req.url === "/fenics-test") {
      return respond(res, 200, {
        ok: true,
        route: "/fenics-test",
        message: "Use POST with JSON body to run the SIMP topology optimizer.",
        exampleBody: {
          nx: 48,
          ny: 48,
          nz: 14,
          loadDirection: "vertical",
          boltCount: 2,
          targetOpenAreaPercent: 60,
          safetyFactor: 1.5,
          forceN: 2500,
          maxIterations: 80,
        },
      });
    }

    if (req.method === "POST" && req.url === "/fenics-test") {
      const body = await readJsonBody<TopologyRequest>(req);
      const solverInput = normalizeTopologyInput(body);
      const result = await runFenicsTopology(solverInput);
      return respond(res, 200, result);
    }

    if (
      req.method === "POST" &&
      (req.url === "/topology/optimize" || req.url === "/topology/mesh")
    ) {
      const body = await readJsonBody<TopologyRequest>(req);
      const solverInput = normalizeTopologyInput(body);

      const rawResult = (await runFenicsTopology(solverInput)) as Record<string, unknown>;

      if (!rawResult || rawResult.ok !== true) {
        return respond(res, 500, {
          ok: false,
          status: "FAILED",
          route: req.url,
          engine: typeof rawResult?.engine === "string" ? rawResult.engine : "unknown",
          error:
            typeof rawResult?.error === "string"
              ? rawResult.error
              : "Topology optimizer did not return ok=true.",
          rawResult,
        });
      }

      const mesh = buildMeshFromDensity({
        density: rawResult.density,
        family: body.componentFamily ?? "structural-bracket",
        candidateId: body.candidateId ?? "solver_structural_bracket_cand_001",
        boltCount: solverInput.boltCount,
        widthMm: readNumber(
          body.envelope?.widthMm,
          body.envelope?.maxWidthMm,
          86.4
        ),
        heightMm: readNumber(
          body.envelope?.heightMm,
          body.envelope?.maxHeightMm,
          50.4
        ),
        depthMm: readNumber(
          body.envelope?.depthMm,
          body.envelope?.maxDepthMm,
          39.6
        ),
        threshold: 0.48,
        rawMetadata: rawResult.metadata,
      });

      if (!mesh) {
        return respond(res, 422, {
          ok: false,
          status: "NO_GEOMETRY_PRODUCED",
          route: req.url,
          engine: rawResult.engine ?? "simp-compliance-topology-v2",
          error:
            "FEniCS/SIMP returned density data, but density-to-surface extraction produced no renderable mesh.",
          metrics: buildMetricsFromSolver(rawResult, undefined),
        });
      }

      return respond(res, 200, {
        ok: true,
        status: "SUCCESS",
        route: req.url,
        engine: rawResult.engine ?? "simp-compliance-topology-v2",
        candidateId: body.candidateId ?? "solver_structural_bracket_cand_001",
        renderMesh: mesh,
        mesh,
        density: rawResult.density,
        metrics: buildMetricsFromSolver(rawResult, mesh),
        metadata: {
          solverInput,
          solverMetadata: rawResult.metadata ?? {},
          geometrySource: "fenics-density-surface-extraction",
          fakeGeometryDisabled: true,
          note:
            "This mesh is extracted from the solver density field. It is not the old decorative TypeScript bracket fallback.",
        },
      });
    }

    if (req.method === "POST" && req.url === "/simulation/submit") {
      const body = await readJsonBody<RemoteSimulationSubmitRequest>(req);

      const submitResponse = await submitRemoteSimulationMock(body);

      void runWorkerPipeline(body, submitResponse.remoteJobId);

      return respond(res, 200, submitResponse);
    }

    if (req.method === "GET" && req.url.startsWith("/simulation/status/")) {
      const id = req.url.split("/").pop()!;
      const status = await getRemoteSimulationStatusMock(id);
      return respond(res, 200, status);
    }

    if (req.method === "GET" && req.url.startsWith("/simulation/result/")) {
      const id = req.url.split("/").pop()!;
      const result = await getRemoteSimulationResultMock(id);
      return respond(res, 200, result);
    }

    return respond(res, 404, { error: "Not found" });
  } catch (err) {
    return respond(res, 500, {
      ok: false,
      status: "FAILED",
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Helvarix Solver Worker running on port ${PORT}`);
  console.log(`Native solvers enabled: ${ENABLE_NATIVE_SOLVERS}`);
  console.log(`Workspace root: ${WORKSPACE_ROOT}`);
});

async function runWorkerPipeline(
  payload: RemoteSimulationSubmitRequest,
  jobId: string
) {
  try {
    console.log(`Running high-fidelity pipeline for job ${jobId}`);

    const pipeline = await runHighFidelityPipeline(payload.request, {
      enableDiskWrite: true,
      enableNativeExecution: ENABLE_NATIVE_SOLVERS,
      workspaceRootDirectory: `${WORKSPACE_ROOT}/${jobId}`,
      gmshExecutable: GMSH_EXEC,
      calculixExecutable: CCX_EXEC,
    });

    persistHighFidelitySimulationResult({
      remoteJobId: jobId,
      result: pipeline.result,
      artifacts: pipeline.artifacts,
      warnings: pipeline.warnings,
      errors: pipeline.errors,
    });

    console.log(`Job ${jobId} complete | score=${pipeline.result.score.total}`);
  } catch (err) {
    persistRemoteSimulationFailure({
      remoteJobId: jobId,
      error: err,
    });

    console.error(`Job ${jobId} failed`, err);
  }
}

function normalizeTopologyInput(body: TopologyRequest): Record<string, unknown> {
  return {
    nx: readNumber(body.nx, 48),
    ny: readNumber(body.ny, 48),
    nz: readNumber(body.nz, 14),
    loadDirection:
      body.loadDirection ??
      body.loadCase?.direction ??
      "vertical",
    boltCount: Math.trunc(
      readNumber(body.boltCount, body.mounting?.boltCount, 2)
    ),
    targetOpenAreaPercent: readNumber(
      body.targetOpenAreaPercent,
      body.objectives?.targetOpenAreaPercent,
      60
    ),
    safetyFactor: readNumber(
      body.safetyFactor,
      body.loadCase?.safetyFactor,
      1.5
    ),
    forceN: readNumber(
      body.forceN,
      body.loadCase?.forceN,
      2500
    ),
    maxIterations: Math.trunc(readNumber(body.maxIterations, 80)),
    minIterations: Math.trunc(readNumber(body.minIterations, 25)),
    changeTolerance: readNumber(body.changeTolerance, 0.012),
    penalization: readNumber(body.penalization, 3.0),
    filterRadius: readNumber(body.filterRadius, 3.0),
    youngsModulus: readNumber(body.youngsModulus, 70.0e9),
    poissonRatio: readNumber(body.poissonRatio, 0.33),
  };
}

function buildMeshFromDensity(args: {
  density: unknown;
  family: string;
  candidateId: string;
  boltCount: number;
  widthMm: number;
  heightMm: number;
  depthMm: number;
  threshold: number;
  rawMetadata: unknown;
}): RenderMesh | undefined {
  const rawDensity = coerceDensity(args.density);
  if (!rawDensity) return undefined;

  const preparedDensity = prepareManufacturableDensity(rawDensity, {
    threshold: 0.24,
    dilationPasses: 2,
    smoothingPasses: 3,
    closingPasses: 1,
  });

  const mesh = buildSurfaceNetMesh({
    density: preparedDensity,
    family: args.family,
    candidateId: args.candidateId,
    boltCount: args.boltCount,
    widthMm: args.widthMm,
    heightMm: args.heightMm,
    depthMm: args.depthMm,
    threshold: 0.46,
    rawMetadata: args.rawMetadata,
  });

  if (!mesh) return undefined;

  mesh.metadata = {
    ...mesh.metadata,
    source: "fenics-density-manufacturable-surface-nets",
    extractionMethod: "smoothed-surface-nets",
    postProcessing: {
      inputThreshold: 0.24,
      meshThreshold: 0.46,
      dilationPasses: 2,
      smoothingPasses: 3,
      closingPasses: 1,
      fakeGeometryDisabled: true,
    },
  };

  return mesh;
}

function prepareManufacturableDensity(
  density: number[][][],
  options: {
    threshold: number;
    dilationPasses: number;
    smoothingPasses: number;
    closingPasses: number;
  }
): number[][][] {
  let field = cloneDensity(density);

  field = normalizeDensity(field);
  field = thresholdSoft(field, options.threshold);

  for (let i = 0; i < options.closingPasses; i += 1) {
    field = dilateDensity(field, 1);
    field = erodeDensity(field, 1);
  }

  for (let i = 0; i < options.dilationPasses; i += 1) {
    field = dilateDensity(field, 1);
  }

  for (let i = 0; i < options.smoothingPasses; i += 1) {
    field = smoothDensity(field);
    field = preserveStrongInterfaces(field, density, options.threshold);
  }

  field = normalizeDensity(field);

  return field;
}

function buildSurfaceNetMesh(args: {
  density: number[][][];
  family: string;
  candidateId: string;
  boltCount: number;
  widthMm: number;
  heightMm: number;
  depthMm: number;
  threshold: number;
  rawMetadata: unknown;
}): RenderMesh | undefined {
  const density = args.density;

  const nx = density.length;
  const ny = density[0]?.length ?? 0;
  const nz = density[0]?.[0]?.length ?? 0;

  if (nx < 3 || ny < 3 || nz < 3) return undefined;

  const vertices: Vec3[] = [];
  const faces: RenderFace[] = [];
  const cellVertex = new Map<string, number>();

  const key = (ix: number, iy: number, iz: number) => `${ix},${iy},${iz}`;

  const sample = (ix: number, iy: number, iz: number): number => {
    if (ix < 0 || iy < 0 || iz < 0 || ix >= nx || iy >= ny || iz >= nz) {
      return 0;
    }

    return density[ix][iy][iz];
  };

  const toWorld = (gx: number, gy: number, gz: number): Vec3 => {
    return [
      roundTo((gx / Math.max(1, nx - 1) - 0.5) * args.widthMm, 0.0001),
      roundTo((gy / Math.max(1, ny - 1) - 0.5) * args.heightMm, 0.0001),
      roundTo((gz / Math.max(1, nz - 1) - 0.5) * args.depthMm, 0.0001),
    ];
  };

  const cornerOffsets: Vec3[] = [
    [0, 0, 0],
    [1, 0, 0],
    [1, 1, 0],
    [0, 1, 0],
    [0, 0, 1],
    [1, 0, 1],
    [1, 1, 1],
    [0, 1, 1],
  ];

  const edgePairs: Array<[number, number]> = [
    [0, 1],
    [1, 2],
    [2, 3],
    [3, 0],
    [4, 5],
    [5, 6],
    [6, 7],
    [7, 4],
    [0, 4],
    [1, 5],
    [2, 6],
    [3, 7],
  ];

  for (let ix = 0; ix < nx - 1; ix += 1) {
    for (let iy = 0; iy < ny - 1; iy += 1) {
      for (let iz = 0; iz < nz - 1; iz += 1) {
        const values = cornerOffsets.map(([ox, oy, oz]) =>
          sample(ix + ox, iy + oy, iz + oz)
        );

        const hasSolid = values.some((v) => v >= args.threshold);
        const hasVoid = values.some((v) => v < args.threshold);

        if (!hasSolid || !hasVoid) continue;

        const crossingPoints: Vec3[] = [];

        for (const [a, b] of edgePairs) {
          const va = values[a];
          const vb = values[b];

          if ((va >= args.threshold) === (vb >= args.threshold)) continue;

          const [ax, ay, az] = cornerOffsets[a];
          const [bx, by, bz] = cornerOffsets[b];
          const denom = vb - va;
          const t =
            Math.abs(denom) < 1e-9
              ? 0.5
              : Math.max(0, Math.min(1, (args.threshold - va) / denom));

          crossingPoints.push([
            ix + ax + (bx - ax) * t,
            iy + ay + (by - ay) * t,
            iz + az + (bz - az) * t,
          ]);
        }

        if (crossingPoints.length === 0) continue;

        const avg = crossingPoints.reduce<Vec3>(
          (acc, p) => [acc[0] + p[0], acc[1] + p[1], acc[2] + p[2]],
          [0, 0, 0]
        );

        const n = crossingPoints.length;
        const world = toWorld(avg[0] / n, avg[1] / n, avg[2] / n);

        vertices.push(world);
        cellVertex.set(key(ix, iy, iz), vertices.length - 1);
      }
    }
  }

  const getCellVertex = (
    ix: number,
    iy: number,
    iz: number
  ): number | undefined => {
    return cellVertex.get(key(ix, iy, iz));
  };

  const addFace = (
    indices: Array<number | undefined>,
    group: string,
    shade: number
  ) => {
    if (indices.some((idx) => idx === undefined)) return;

    const clean = indices as number[];
    if (new Set(clean).size < 3) return;

    faces.push({
      indices: clean,
      group,
      shade,
    });
  };

  for (let ix = 0; ix < nx - 1; ix += 1) {
    for (let iy = 1; iy < ny - 1; iy += 1) {
      for (let iz = 1; iz < nz - 1; iz += 1) {
        const a = sample(ix, iy, iz);
        const b = sample(ix + 1, iy, iz);

        if ((a >= args.threshold) === (b >= args.threshold)) continue;

        addFace(
          [
            getCellVertex(ix, iy - 1, iz - 1),
            getCellVertex(ix, iy, iz - 1),
            getCellVertex(ix, iy, iz),
            getCellVertex(ix, iy - 1, iz),
          ],
          "solver-surface-net-x",
          0.82
        );
      }
    }
  }

  for (let ix = 1; ix < nx - 1; ix += 1) {
    for (let iy = 0; iy < ny - 1; iy += 1) {
      for (let iz = 1; iz < nz - 1; iz += 1) {
        const a = sample(ix, iy, iz);
        const b = sample(ix, iy + 1, iz);

        if ((a >= args.threshold) === (b >= args.threshold)) continue;

        addFace(
          [
            getCellVertex(ix - 1, iy, iz - 1),
            getCellVertex(ix - 1, iy, iz),
            getCellVertex(ix, iy, iz),
            getCellVertex(ix, iy, iz - 1),
          ],
          "solver-surface-net-y",
          0.88
        );
      }
    }
  }

  for (let ix = 1; ix < nx - 1; ix += 1) {
    for (let iy = 1; iy < ny - 1; iy += 1) {
      for (let iz = 0; iz < nz - 1; iz += 1) {
        const a = sample(ix, iy, iz);
        const b = sample(ix, iy, iz + 1);

        if ((a >= args.threshold) === (b >= args.threshold)) continue;

        addFace(
          [
            getCellVertex(ix - 1, iy - 1, iz),
            getCellVertex(ix, iy - 1, iz),
            getCellVertex(ix, iy, iz),
            getCellVertex(ix - 1, iy, iz),
          ],
          "solver-surface-net-z",
          0.76
        );
      }
    }
  }

  if (vertices.length < 4 || faces.length < 1) return undefined;

  const relaxedVertices = laplacianRelaxVertices(vertices, faces, 4, 0.34);

  return {
    version: "haf-render-mesh-v1",
    units: "mm",
    family: args.family,
    vertices: relaxedVertices,
    faces,
    features: [],
    bounds: {
      widthMm: args.widthMm,
      heightMm: args.heightMm,
      depthMm: args.depthMm,
    },
    metadata: {
      candidateId: args.candidateId,
      source: "fenics-density-surface-nets",
      fakeGeometryDisabled: true,
      threshold: args.threshold,
      densityGrid: { nx, ny, nz },
      boltCount: args.boltCount,
      extractionMethod: "surface-nets-laplacian-relaxed",
      solverMetadata: args.rawMetadata ?? {},
    },
  };
}

function cloneDensity(density: number[][][]): number[][][] {
  return density.map((plane) => plane.map((row) => [...row]));
}

function normalizeDensity(density: number[][][]): number[][][] {
  let max = 0;

  forEachDensityCell(density, (_x, _y, _z, value) => {
    if (value > max) max = value;
  });

  if (max <= 1e-9) return cloneDensity(density);

  return density.map((plane) =>
    plane.map((row) => row.map((value) => Math.max(0, Math.min(1, value / max))))
  );
}

function thresholdSoft(density: number[][][], threshold: number): number[][][] {
  return density.map((plane) =>
    plane.map((row) =>
      row.map((value) => {
        if (value <= threshold * 0.45) return 0;
        if (value >= threshold) return 1;
        const t = (value - threshold * 0.45) / (threshold * 0.55);
        return smoothstep(t);
      })
    )
  );
}

function dilateDensity(density: number[][][], radius: number): number[][][] {
  const nx = density.length;
  const ny = density[0]?.length ?? 0;
  const nz = density[0]?.[0]?.length ?? 0;
  const out = cloneDensity(density);

  for (let ix = 0; ix < nx; ix += 1) {
    for (let iy = 0; iy < ny; iy += 1) {
      for (let iz = 0; iz < nz; iz += 1) {
        let best = density[ix][iy][iz];

        for (let dx = -radius; dx <= radius; dx += 1) {
          for (let dy = -radius; dy <= radius; dy += 1) {
            for (let dz = -radius; dz <= radius; dz += 1) {
              const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
              if (distance > radius + 0.001) continue;

              const sx = ix + dx;
              const sy = iy + dy;
              const sz = iz + dz;

              if (sx < 0 || sy < 0 || sz < 0 || sx >= nx || sy >= ny || sz >= nz) {
                continue;
              }

              const falloff = 1 - distance / (radius + 1);
              best = Math.max(best, density[sx][sy][sz] * (0.72 + falloff * 0.28));
            }
          }
        }

        out[ix][iy][iz] = best;
      }
    }
  }

  return out;
}

function erodeDensity(density: number[][][], radius: number): number[][][] {
  const nx = density.length;
  const ny = density[0]?.length ?? 0;
  const nz = density[0]?.[0]?.length ?? 0;
  const out = cloneDensity(density);

  for (let ix = 0; ix < nx; ix += 1) {
    for (let iy = 0; iy < ny; iy += 1) {
      for (let iz = 0; iz < nz; iz += 1) {
        let worst = density[ix][iy][iz];

        for (let dx = -radius; dx <= radius; dx += 1) {
          for (let dy = -radius; dy <= radius; dy += 1) {
            for (let dz = -radius; dz <= radius; dz += 1) {
              const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
              if (distance > radius + 0.001) continue;

              const sx = ix + dx;
              const sy = iy + dy;
              const sz = iz + dz;

              if (sx < 0 || sy < 0 || sz < 0 || sx >= nx || sy >= ny || sz >= nz) {
                worst = 0;
                continue;
              }

              worst = Math.min(worst, density[sx][sy][sz]);
            }
          }
        }

        out[ix][iy][iz] = worst;
      }
    }
  }

  return out;
}

function smoothDensity(density: number[][][]): number[][][] {
  const nx = density.length;
  const ny = density[0]?.length ?? 0;
  const nz = density[0]?.[0]?.length ?? 0;
  const out = cloneDensity(density);

  for (let ix = 0; ix < nx; ix += 1) {
    for (let iy = 0; iy < ny; iy += 1) {
      for (let iz = 0; iz < nz; iz += 1) {
        let total = 0;
        let weight = 0;

        for (let dx = -1; dx <= 1; dx += 1) {
          for (let dy = -1; dy <= 1; dy += 1) {
            for (let dz = -1; dz <= 1; dz += 1) {
              const sx = ix + dx;
              const sy = iy + dy;
              const sz = iz + dz;

              if (sx < 0 || sy < 0 || sz < 0 || sx >= nx || sy >= ny || sz >= nz) {
                continue;
              }

              const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
              const w = distance === 0 ? 3.2 : 1 / (1 + distance);

              total += density[sx][sy][sz] * w;
              weight += w;
            }
          }
        }

        out[ix][iy][iz] = weight > 0 ? total / weight : density[ix][iy][iz];
      }
    }
  }

  return out;
}

function preserveStrongInterfaces(
  field: number[][][],
  original: number[][][],
  threshold: number
): number[][][] {
  const out = cloneDensity(field);

  forEachDensityCell(original, (ix, iy, iz, value) => {
    if (value >= Math.max(0.72, threshold * 1.8)) {
      out[ix][iy][iz] = Math.max(out[ix][iy][iz], 0.96);
    }

    if (value <= threshold * 0.12) {
      out[ix][iy][iz] = Math.min(out[ix][iy][iz], 0.08);
    }
  });

  return out;
}

function laplacianRelaxVertices(
  vertices: Vec3[],
  faces: RenderFace[],
  iterations: number,
  lambda: number
): Vec3[] {
  const neighbors = new Map<number, Set<number>>();

  for (const face of faces) {
    for (let i = 0; i < face.indices.length; i += 1) {
      const a = face.indices[i];
      const b = face.indices[(i + 1) % face.indices.length];

      if (!neighbors.has(a)) neighbors.set(a, new Set());
      if (!neighbors.has(b)) neighbors.set(b, new Set());

      neighbors.get(a)!.add(b);
      neighbors.get(b)!.add(a);
    }
  }

  let current = vertices.map((v) => [...v] as Vec3);

  for (let iter = 0; iter < iterations; iter += 1) {
    const next = current.map((v) => [...v] as Vec3);

    for (let i = 0; i < current.length; i += 1) {
      const ns = neighbors.get(i);
      if (!ns || ns.size < 3) continue;

      let cx = 0;
      let cy = 0;
      let cz = 0;

      for (const n of ns) {
        cx += current[n][0];
        cy += current[n][1];
        cz += current[n][2];
      }

      cx /= ns.size;
      cy /= ns.size;
      cz /= ns.size;

      next[i] = [
        roundTo(current[i][0] * (1 - lambda) + cx * lambda, 0.0001),
        roundTo(current[i][1] * (1 - lambda) + cy * lambda, 0.0001),
        roundTo(current[i][2] * (1 - lambda) + cz * lambda, 0.0001),
      ];
    }

    current = next;
  }

  return current;
}

function forEachDensityCell(
  density: number[][][],
  fn: (ix: number, iy: number, iz: number, value: number) => void
) {
  for (let ix = 0; ix < density.length; ix += 1) {
    for (let iy = 0; iy < density[ix].length; iy += 1) {
      for (let iz = 0; iz < density[ix][iy].length; iz += 1) {
        fn(ix, iy, iz, density[ix][iy][iz]);
      }
    }
  }
}

function smoothstep(t: number): number {
  const x = Math.max(0, Math.min(1, t));
  return x * x * (3 - 2 * x);
}

function coerceDensity(value: unknown): number[][][] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;

  const density: number[][][] = [];

  for (const xSlice of value) {
    if (!Array.isArray(xSlice) || xSlice.length === 0) return undefined;

    const yRows: number[][] = [];

    for (const yRow of xSlice) {
      if (!Array.isArray(yRow) || yRow.length === 0) return undefined;

      const zValues = yRow.map((entry) => {
        const n = Number(entry);
        return Number.isFinite(n) ? n : 0;
      });

      yRows.push(zValues);
    }

    density.push(yRows);
  }

  return density;
}

function buildMetricsFromSolver(
  rawResult: Record<string, unknown>,
  mesh: RenderMesh | undefined
): Record<string, unknown> {
  const metadata = isRecord(rawResult.metadata) ? rawResult.metadata : {};
  const volumeFraction = readNumber(metadata.volumeFraction, 0);
  const openAreaPercent = roundTo((1 - volumeFraction) * 100, 0.1);

  return {
    openAreaPercent,
    volumeFraction,
    compliance: readNumber(metadata.compliance, 0),
    iterations: readNumber(metadata.iterations, 0),
    converged: metadata.converged === true,
    massKg: mesh ? estimateMassKg(mesh, volumeFraction) : 0,
    maxStressMpa: 0,
    maxDisplacementMm: 0,
    safetyFactor: 0,
    solverMeshVertices: mesh?.vertices.length ?? 0,
    solverMeshFaces: mesh?.faces.length ?? 0,
  };
}

function estimateMassKg(mesh: RenderMesh, volumeFraction: number): number {
  const densityAluminumKgM3 = 2700;
  const volumeMm3 =
    mesh.bounds.widthMm *
    mesh.bounds.heightMm *
    mesh.bounds.depthMm *
    Math.max(0, Math.min(1, volumeFraction));

  return roundTo((volumeMm3 / 1_000_000_000) * densityAluminumKgM3, 0.001);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readNumber(...values: unknown[]): number {
  for (const value of values) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }

  return 0;
}

function roundTo(value: number, step: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(step) || step <= 0) return value;
  return Math.round(value / step) * step;
}

function setCors(res: http.ServerResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

function respond(res: http.ServerResponse, status: number, data: unknown) {
  res.writeHead(status, {
    "Content-Type": "application/json",
  });

  if (status === 204) {
    res.end();
    return;
  }

  res.end(JSON.stringify(data));
}

async function readJsonBody<T>(req: http.IncomingMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    let data = "";

    req.on("data", (chunk) => {
      data += chunk;
    });

    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (err) {
        reject(err);
      }
    });

    req.on("error", reject);
  });
}
