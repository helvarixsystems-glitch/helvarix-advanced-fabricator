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
  const density = coerceDensity(args.density);
  if (!density) return undefined;

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

  // Surface nets: one relaxed vertex per threshold-crossing grid cell.
  // This avoids the blocky "one cube per solid voxel" look while still using
  // the solver density field as the only geometry source.
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

  // Connect the surface-net vertices around every crossing grid edge.
  // Each crossing edge produces one quad from its four neighboring cells.
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

  return {
    version: "haf-render-mesh-v1",
    units: "mm",
    family: args.family,
    vertices,
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
      extractionMethod: "surface-nets",
      solverMetadata: args.rawMetadata ?? {},
    },
  };
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
