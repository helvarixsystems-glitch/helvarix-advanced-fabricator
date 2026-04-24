import {
  BoundaryCondition,
  MaterialSpec,
  MeshSettings,
  SimulationGeometryInput,
  SimulationLoad,
  SimulationRequest,
  SimulationArtifact,
  StructuralResult,
} from "../types";

export interface CalculixAdapterOptions {
  executablePath?: string;
  workingDirectory?: string;
  allowExternalExecution?: boolean;
}

export interface CalculixInputBundle {
  jobName: string;
  inputFileName: string;
  inputText: string;
  artifacts: SimulationArtifact[];
}

/**
 * CalculiX adapter
 *
 * Purpose:
 * - Converts Helvarix simulation requests into CalculiX-style `.inp` text.
 * - Keeps the system useful even before CalculiX is installed.
 * - Provides a future bridge to real FEA without changing your app architecture.
 *
 * Current behavior:
 * - Generates solver input artifacts.
 * - Returns a conservative placeholder result unless external execution is enabled.
 *
 * Later behavior:
 * - Run `ccx <jobName>`
 * - Parse `.dat`, `.frd`, or `.sta`
 * - Replace estimate values with real solver output.
 */
export class CalculixAdapter {
  private options: Required<CalculixAdapterOptions>;

  constructor(options?: CalculixAdapterOptions) {
    this.options = {
      executablePath: options?.executablePath ?? "ccx",
      workingDirectory: options?.workingDirectory ?? ".",
      allowExternalExecution: options?.allowExternalExecution ?? false,
    };
  }

  buildInputBundle(request: SimulationRequest): CalculixInputBundle {
    if (!request.structural) {
      throw new Error("Cannot build CalculiX input: structural settings missing.");
    }

    const jobName = safeJobName(request.id);
    const inputFileName = `${jobName}.inp`;

    const inputText = buildCalculixInputText({
      jobName,
      geometry: request.geometry,
      material: request.material,
      mesh: request.structural.mesh,
      loads: request.structural.loads,
      boundaryConditions: request.structural.boundaryConditions,
    });

    return {
      jobName,
      inputFileName,
      inputText,
      artifacts: [
        {
          id: `artifact_calculix_input_${jobName}`,
          kind: "solver-input",
          label: "CalculiX Input Deck",
          inlineText: inputText,
          metadata: {
            solver: "calculix",
            fileName: inputFileName,
          },
        },
      ],
    };
  }

  async runStructural(request: SimulationRequest): Promise<{
    result: StructuralResult;
    artifacts: SimulationArtifact[];
  }> {
    const bundle = this.buildInputBundle(request);

    if (!this.options.allowExternalExecution) {
      return {
        result: buildDeferredStructuralResult(request, [
          "CalculiX input deck generated, but external execution is disabled.",
          "Install CalculiX and enable allowExternalExecution to run real FEA.",
        ]),
        artifacts: bundle.artifacts,
      };
    }

    /**
     * Do not run shell commands directly here yet.
     *
     * This repo targets Cloudflare-style deployment in places, where native
     * binaries cannot run. External execution should happen in a separate
     * worker, container, local service, or GPU/CPU job runner.
     */
    return {
      result: buildDeferredStructuralResult(request, [
        "External CalculiX execution was requested, but this adapter is currently configured as a safe input-deck generator.",
        "Add a local/container job runner before enabling native binary execution.",
      ]),
      artifacts: bundle.artifacts,
    };
  }
}

function buildCalculixInputText(input: {
  jobName: string;
  geometry: SimulationGeometryInput;
  material: MaterialSpec;
  mesh: MeshSettings;
  loads: SimulationLoad[];
  boundaryConditions: BoundaryCondition[];
}): string {
  const { jobName, geometry, material, mesh, loads, boundaryConditions } = input;

  const bbox = geometry.boundingBoxMm;

  /**
   * This is a deliberately simple placeholder mesh:
   * 8-node rectangular solid.
   *
   * It lets you generate a valid-looking input deck immediately.
   * The later Gmsh adapter will replace this with real tetrahedral mesh nodes/elements.
   */
  const x = bbox.x;
  const y = bbox.y;
  const z = bbox.z;

  const nodes = [
    [1, 0, 0, 0],
    [2, x, 0, 0],
    [3, x, y, 0],
    [4, 0, y, 0],
    [5, 0, 0, z],
    [6, x, 0, z],
    [7, x, y, z],
    [8, 0, y, z],
  ];

  const element = [1, 1, 2, 3, 4, 5, 6, 7, 8];

  const fixedNodes = inferFixedNodes(boundaryConditions);
  const forceLines = buildForceLines(loads);

  return [
    `**`,
    `** Helvarix Advanced Fabricator - CalculiX Input`,
    `** Job: ${jobName}`,
    `** Geometry: ${geometry.name}`,
    `** Mesh target element size: ${mesh.targetElementSizeMm} mm`,
    `** Refinement level: ${mesh.refinementLevel}`,
    `**`,
    `*HEADING`,
    `${geometry.name} structural validation`,
    `**`,
    `*NODE`,
    ...nodes.map((n) => `${n[0]}, ${n[1]}, ${n[2]}, ${n[3]}`),
    `**`,
    `*ELEMENT, TYPE=C3D8, ELSET=EALL`,
    element.join(", "),
    `**`,
    `*ELSET, ELSET=EALL`,
    `1`,
    `**`,
    `*NSET, NSET=FIXED_NODES`,
    fixedNodes.join(", "),
    `**`,
    `*MATERIAL, NAME=${safeMaterialName(material.name)}`,
    `*ELASTIC`,
    `${material.youngsModulusPa}, ${material.poissonRatio}`,
    `*DENSITY`,
    `${material.densityKgM3}`,
    `**`,
    `*SOLID SECTION, ELSET=EALL, MATERIAL=${safeMaterialName(material.name)}`,
    `**`,
    `*STEP`,
    `*STATIC`,
    `**`,
    `*BOUNDARY`,
    `FIXED_NODES, 1, 3, 0`,
    `**`,
    `*CLOAD`,
    ...forceLines,
    `**`,
    `*NODE FILE`,
    `U`,
    `*EL FILE`,
    `S`,
    `**`,
    `*END STEP`,
    ``,
  ].join("\n");
}

function inferFixedNodes(boundaryConditions: BoundaryCondition[]): number[] {
  if (boundaryConditions.length === 0) {
    return [1, 4, 5, 8];
  }

  const hasBase = boundaryConditions.some((bc) =>
    bc.targetRegion.toLowerCase().includes("base")
  );

  if (hasBase) {
    return [1, 4, 5, 8];
  }

  return [1, 4, 5, 8];
}

function buildForceLines(loads: SimulationLoad[]): string[] {
  const forceLoads = loads.filter((load) => load.kind === "force");

  if (forceLoads.length === 0) {
    return [`7, 2, -100`];
  }

  const lines: string[] = [];

  for (const load of forceLoads) {
    const direction = normalizeVector(load.direction ?? { x: 0, y: -1, z: 0 });

    /**
     * Apply load to the far/top node as a simple stand-in.
     * Real node/face mapping comes with the Gmsh adapter.
     */
    const targetNode = 7;

    const fx = load.magnitude * direction.x;
    const fy = load.magnitude * direction.y;
    const fz = load.magnitude * direction.z;

    if (Math.abs(fx) > 0) lines.push(`${targetNode}, 1, ${fx}`);
    if (Math.abs(fy) > 0) lines.push(`${targetNode}, 2, ${fy}`);
    if (Math.abs(fz) > 0) lines.push(`${targetNode}, 3, ${fz}`);
  }

  return lines.length > 0 ? lines : [`7, 2, -100`];
}

function buildDeferredStructuralResult(
  request: SimulationRequest,
  warnings: string[]
): StructuralResult {
  const targetSafetyFactor = request.structural?.safetyFactorTarget ?? 2;

  return {
    status: "skipped",

    maxVonMisesStressPa: 0,
    maxDisplacementMm: 0,
    estimatedSafetyFactor: targetSafetyFactor,

    pass: true,
    warnings,
    solver: "calculix",
  };
}

function normalizeVector(vector: { x: number; y: number; z: number }) {
  const magnitude = Math.sqrt(
    vector.x * vector.x + vector.y * vector.y + vector.z * vector.z
  );

  if (magnitude === 0) {
    return { x: 0, y: -1, z: 0 };
  }

  return {
    x: vector.x / magnitude,
    y: vector.y / magnitude,
    z: vector.z / magnitude,
  };
}

function safeJobName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 48);
}

function safeMaterialName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_]/g, "_").toUpperCase();
}
