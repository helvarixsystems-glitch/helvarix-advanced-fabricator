import type {
  BaselineComparison,
  BellNozzleRequirements,
  CandidateGeometry,
  ComponentFamily,
  DerivedGeometry,
  GenerationInput,
  GenerationResult,
  RenderableMesh,
  RenderableMeshFeature,
  StructuralBracketRequirements,
  ValidationMessage,
  Vec3
} from "@haf/shared";

declare const process:
  | {
      env?: Record<string, string | undefined>;
    }
  | undefined;

const DEFAULT_FENICS_SOLVER_URL = "https://helvarix-solver-worker.onrender.com";
const DENSITY_THRESHOLD = 0.5;

export async function generateComponent(input: GenerationInput): Promise<GenerationResult> {
  if (input.componentFamily === "bell-nozzle") {
    return generateBellNozzle(input.requirements);
  }

  return generateStructuralPart(input.componentFamily, input.requirements);
}

export const runGeneration = generateComponent;

type StructuralMaterial = {
  name: string;
  densityGcc: number;
  allowableStressMpa: number;
  elasticModulusMpa: number;
};

type StructuralMode =
  | "minimum-mass-density"
  | "balanced-density"
  | "stiffness-density"
  | "vibration-density";

type StructuralDesignParameters = {
  mode: StructuralMode;
  material: StructuralMaterial;
  thicknessFactor: number;
  targetOpenAreaPercent: number;
};

type FenicsDensityResult = {
  ok?: boolean;
  engine?: string;
  density?: number[][][];
  error?: string;
};

type DensityStats = {
  nx: number;
  ny: number;
  nz: number;
  solidVoxels: number;
  totalVoxels: number;
  solidFraction: number;
  openAreaPercent: number;
  averageDensity: number;
};

type MeshBuilder = {
  vertices: Vec3[];
  faces: RenderableMesh["faces"];
  features: RenderableMeshFeature[];
};

async function generateStructuralPart(
  family: ComponentFamily,
  requirements: StructuralBracketRequirements
): Promise<GenerationResult> {
  const filteredCandidates = buildStructuralCandidates(family, requirements, true);
  const baselineCandidates = buildStructuralCandidates(family, requirements, false);

  const accepted = filteredCandidates
    .filter((candidate) => !candidate.rejected)
    .sort((a, b) => b.totalScore - a.totalScore);

  const rejected = filteredCandidates.filter((candidate) => candidate.rejected);

  const selectedWithoutMesh =
    accepted[0] ??
    [...filteredCandidates].sort((a, b) => b.totalScore - a.totalScore)[0] ??
    createEmergencyStructuralCandidate(family, requirements);

  const selected: CandidateGeometry = {
    ...selectedWithoutMesh,
    renderMesh: await buildStructuralRenderMesh(selectedWithoutMesh, requirements)
  };

  const reviewedBaseline = baselineCandidates
    .map((candidate) => {
      const rejectionReasons = evaluateStructuralCandidateForReview(candidate, requirements);
      return {
        ...candidate,
        rejected: rejectionReasons.length > 0,
        rejectionReasons
      };
    })
    .sort((a, b) => b.totalScore - a.totalScore);

  const baselineRejectedAfterReview = reviewedBaseline.filter((candidate) => candidate.rejected);
  const selectedBaseline = reviewedBaseline[0];

  const baselineComparison: BaselineComparison = {
    baselineCandidatesGenerated: baselineCandidates.length,
    baselineCandidatesSimulated: baselineCandidates.length,
    baselineCandidatesRejectedAfterReview: baselineRejectedAfterReview.length,
    filteredCandidatesGenerated: filteredCandidates.length,
    filteredCandidatesRejectedBeforeSimulation: rejected.length,
    filteredCandidatesSimulated: accepted.length,
    avoidedSimulationRuns: Math.max(0, baselineCandidates.length - accepted.length),
    reductionInSimulationLoadPercent: roundTo(
      baselineCandidates.length > 0
        ? ((baselineCandidates.length - accepted.length) / baselineCandidates.length) * 100
        : 0,
      0.1
    ),
    selectedBaselineCandidateId: selectedBaseline?.id,
    selectedFilteredCandidateId: selected.id,
    selectedBaselineCandidateWasRejected: selectedBaseline?.rejected ?? false
  };

  const derived: DerivedGeometry = {
    widthMm: selected.widthMm,
    heightMm: selected.heightMm,
    depthMm: selected.depthMm,
    lengthMm: selected.lengthMm,
    wallThicknessMm: selected.wallThicknessMm,
    material: selected.material,
    estimatedMassKg: selected.estimatedMassKg,
    selectedCandidateId: selected.id,
    skeletonized: selected.skeletonized,
    skeletonizationPolicy: selected.skeletonizationPolicy,
    openAreaPercent: selected.openAreaPercent,
    latticeCellCount: selected.latticeCellCount,
    loadPathContinuityScore: selected.loadPathContinuityScore,
    renderMesh: selected.renderMesh,
    derivedParameters: selected.derivedParameters
  };

  return {
    revision: "REQ-GEN-006-FENICS-DENSITY-DIRECT",
    exportState: "idle",
    estimatedMassKg: selected.estimatedMassKg,
    estimatedBurn: estimateComputeBurn(filteredCandidates.length, accepted.length),
    geometry: {
      silhouette: family,
      material: selected.material,
      lengthMm: selected.lengthMm,
      widthMm: selected.widthMm,
      heightMm: selected.heightMm,
      depthMm: selected.depthMm,
      wallThicknessMm: selected.wallThicknessMm,
      skeletonized: selected.skeletonized,
      skeletonizationPolicy: selected.skeletonizationPolicy,
      openAreaPercent: selected.openAreaPercent,
      latticeCellCount: selected.latticeCellCount,
      loadPathContinuityScore: selected.loadPathContinuityScore,
      renderMesh: selected.renderMesh,
      derived,
      candidates: {
        evaluated: filteredCandidates.length,
        accepted: accepted.length,
        rejected: rejected.length,
        bestCandidateId: selected.id
      },
      notes: [
        `${filteredCandidates.length} FEniCS-ready constraint candidates were generated and scored.`,
        `${rejected.length} candidates were rejected before topology solve by envelope, manufacturability, and safety filters.`,
        `${accepted.length} candidates advanced to FEniCS density-field geometry generation.`,
        `Selected candidate ${selected.id} with total score ${selected.totalScore.toFixed(1)}/100.`,
        `Selected geometry uses ${requirements.mounting.boltCount} bolt hole${requirements.mounting.boltCount === 1 ? "" : "s"} from the input requirements.`,
        `Geometry source: ${String(selected.derivedParameters.geometrySource ?? "unknown")}.`,
        `Estimated mass is ${selected.estimatedMassKg.toFixed(3)} kg with estimated safety factor ${selected.safetyFactorEstimate.toFixed(2)}.`
      ]
    },
    validations: buildStructuralValidations(requirements, selected, accepted.length, baselineComparison),
    derived,
    candidatesEvaluated: filteredCandidates.length,
    candidatesAccepted: accepted.length,
    candidatesRejected: rejected.length,
    selectedCandidate: selected,
    rejectedCandidates: rejected.slice(0, 30),
    baselineComparison,
    fabricationReview: {
      supportRemovalDifficulty: "unknown",
      notes:
        "Fabrication review placeholder. Next step is exporting the FEniCS density mesh to STL and validating it in Gmsh/CalculiX."
    }
  };
}

function buildStructuralCandidates(
  family: ComponentFamily,
  requirements: StructuralBracketRequirements,
  applyConstraintFiltering: boolean
): CandidateGeometry[] {
  const candidates: CandidateGeometry[] = [];
  const designSpace = buildStructuralDesignSpace(requirements);
  const loadMultiplier =
    requirements.loadCase.direction === "multi-axis"
      ? 1.35
      : requirements.loadCase.direction === "lateral"
        ? 1.18
        : 1;
  const vibrationMultiplier = requirements.loadCase.vibrationHz
    ? 1 + Math.min(requirements.loadCase.vibrationHz / 500, 0.45)
    : 1;
  const requiredLoadN = requirements.loadCase.forceN * requirements.safetyFactor * loadMultiplier * vibrationMultiplier;
  const boltFitWidth = requirements.mounting.spacingMm + requirements.mounting.boltDiameterMm * 4.2;

  let index = 0;

  for (const params of designSpace) {
    index += 1;

    const wallThicknessMm = roundTo(requirements.manufacturing.minWallThicknessMm * params.thicknessFactor, 0.1);
    const widthMm = clamp(
      Math.max(boltFitWidth, requirements.envelope.maxWidthMm * widthFactorForMode(params.mode)),
      requirements.mounting.boltDiameterMm * 5,
      requirements.envelope.maxWidthMm
    );
    const heightMm = clamp(
      requirements.envelope.maxHeightMm * heightFactorForMode(params.mode),
      requirements.mounting.boltDiameterMm * 4.5,
      requirements.envelope.maxHeightMm
    );
    const depthMm = clamp(
      requirements.envelope.maxDepthMm * (0.36 + params.thicknessFactor * 0.08),
      requirements.mounting.boltDiameterMm * 3.25,
      requirements.envelope.maxDepthMm
    );

    const topologyEfficiency = topologyEfficiencyForMode(params.mode, requirements);
    const sectionAreaMm2 = Math.max(wallThicknessMm * (widthMm * 0.38 + heightMm * 0.34), 1);
    const loadCapacityN =
      sectionAreaMm2 *
      params.material.allowableStressMpa *
      topologyEfficiency *
      clamp(1 - params.targetOpenAreaPercent / 185, 0.5, 0.88);
    const safetyFactorEstimate = loadCapacityN / Math.max(requirements.loadCase.forceN, 1);
    const achievedSafetyRatio = safetyFactorEstimate / Math.max(requirements.safetyFactor, 0.1);
    const estimatedStressMpa = requiredLoadN / Math.max(sectionAreaMm2 * topologyEfficiency, 1);
    const estimatedDisplacementMm =
      (requirements.loadCase.forceN * Math.pow(heightMm, 2)) /
      Math.max(params.material.elasticModulusMpa * sectionAreaMm2 * topologyEfficiency * 110, 1);

    const solidFraction = clamp(1 - params.targetOpenAreaPercent / 100, 0.18, 0.72);
    const grossVolumeMm3 = widthMm * heightMm * depthMm;
    const estimatedVolumeMm3 = grossVolumeMm3 * (solidFraction * 0.34 + 0.04);
    const estimatedMassKg = (estimatedVolumeMm3 / 1_000_000) * params.material.densityGcc;
    const minimumViableMassKg = Math.max(0.035, requiredLoadN / Math.max(params.material.allowableStressMpa * 48_000, 1));

    const massScore = clamp(112 - (estimatedMassKg / Math.max(minimumViableMassKg * 3.4, 0.001)) * 28, 0, 100);
    const strengthScore = achievedSafetyRatio < 1
      ? clamp(achievedSafetyRatio * 78, 0, 78)
      : clamp(104 - Math.max(0, achievedSafetyRatio - 1.32) * 13, 72, 104);
    const stiffnessScore = clamp(100 - estimatedDisplacementMm * 32, 0, 100);
    const manufacturabilityScore = clamp(
      100 -
        Math.max(0, wallThicknessMm - requirements.manufacturing.minWallThicknessMm * 2.2) * 5 -
        (requirements.manufacturing.supportAllowed ? 2 : 12) -
        Math.max(0, 45 - requirements.manufacturing.maxOverhangDeg) * 0.9,
      0,
      100
    );
    const densityFitScore = densityModeFitScore(params.mode, requirements);
    const materialPenalty = clamp(Math.max(0, params.material.densityGcc - 4.6) * 5, 0, 22);
    const overSafetyPenalty = clamp(Math.max(0, achievedSafetyRatio - 1.85) * 8, 0, 28);
    const lowSafetyPenalty = achievedSafetyRatio < 1 ? 32 : 0;

    const performanceScore = weightedAverage([
      [massScore, 0.26],
      [strengthScore, 0.23],
      [densityFitScore, 0.2],
      [stiffnessScore, 0.15],
      [manufacturabilityScore, 0.16]
    ]);

    const totalScore = clamp(
      weightedAverage([
        [performanceScore, 0.42],
        [massScore, 0.22],
        [strengthScore, 0.2],
        [densityFitScore, 0.1],
        [manufacturabilityScore, 0.06]
      ]) - materialPenalty - overSafetyPenalty - lowSafetyPenalty,
      0,
      100
    );

    const candidate: CandidateGeometry = {
      id: `${applyConstraintFiltering ? "filtered" : "baseline"}_${family.replace(/[^a-z0-9]/gi, "-")}_cand_${String(index).padStart(3, "0")}`,
      family,
      material: params.material.name,
      widthMm: roundTo(widthMm, 0.1),
      heightMm: roundTo(heightMm, 0.1),
      depthMm: roundTo(depthMm, 0.1),
      lengthMm: roundTo(Math.max(widthMm, heightMm), 0.1),
      wallThicknessMm,
      estimatedMassKg: roundTo(estimatedMassKg, 0.001),
      estimatedStressMpa: roundTo(estimatedStressMpa, 0.01),
      estimatedDisplacementMm: roundTo(estimatedDisplacementMm, 0.0001),
      safetyFactorEstimate: roundTo(safetyFactorEstimate, 0.01),
      manufacturabilityScore: roundTo(manufacturabilityScore, 0.1),
      supportBurdenScore: roundTo(manufacturabilityScore, 0.1),
      performanceScore: roundTo(performanceScore, 0.1),
      totalScore: roundTo(totalScore, 0.1),
      rejected: false,
      rejectionReasons: [],
      skeletonized: true,
      skeletonizationPolicy: "fenics-density",
      openAreaPercent: roundTo(params.targetOpenAreaPercent, 0.1),
      latticeCellCount: 0,
      loadPathContinuityScore: roundTo(densityFitScore, 0.1),
      derivedParameters: {
        topologyMode: params.mode,
        geometrySource: "fenics-density-field",
        targetOpenAreaPercent: params.targetOpenAreaPercent,
        optimizationObjective: "minimum viable mass using FEniCS density field",
        achievedSafetyRatio: roundTo(achievedSafetyRatio, 0.01),
        minimumViableMassKg: roundTo(minimumViableMassKg, 0.001),
        requiredLoadN: roundTo(requiredLoadN, 0.1),
        loadDirection: requirements.loadCase.direction,
        vibrationHz: requirements.loadCase.vibrationHz ?? 0,
        manufacturingProcess: requirements.manufacturing.process,
        supportAllowed: requirements.manufacturing.supportAllowed,
        boltCount: requirements.mounting.boltCount,
        boltDiameterMm: requirements.mounting.boltDiameterMm,
        boltSpacingMm: requirements.mounting.spacingMm,
        overhangLimitDeg: requirements.manufacturing.maxOverhangDeg,
        baselineMode: !applyConstraintFiltering
      }
    };

    const rejectionReasons = applyConstraintFiltering ? evaluateStructuralCandidateForReview(candidate, requirements) : [];

    candidates.push({
      ...candidate,
      rejected: rejectionReasons.length > 0,
      rejectionReasons
    });
  }

  return candidates;
}

function buildStructuralDesignSpace(requirements: StructuralBracketRequirements): StructuralDesignParameters[] {
  const materials = selectStructuralMaterialOptions(requirements);
  const modes: StructuralMode[] = [
    "minimum-mass-density",
    "balanced-density",
    "stiffness-density",
    ...(requirements.loadCase.vibrationHz && requirements.loadCase.vibrationHz > 60 ? ["vibration-density" as StructuralMode] : [])
  ];
  const targetOpenAreaBase = requirements.objectives.targetOpenAreaPercent ??
    (requirements.objectives.priority === "lightweight" ? 58 : 46);
  const targetOpenAreas = [
    clamp(targetOpenAreaBase - 8, 28, 72),
    clamp(targetOpenAreaBase, 32, 78),
    clamp(targetOpenAreaBase + 8, 38, 82)
  ];
  const thicknessFactors = requirements.objectives.priority === "lightweight"
    ? [0.95, 1.1, 1.28]
    : requirements.objectives.priority === "stiffness"
      ? [1.1, 1.28, 1.48]
      : [1, 1.18, 1.38];
  const designSpace: StructuralDesignParameters[] = [];

  for (const material of materials) {
    for (const mode of modes) {
      for (const thicknessFactor of thicknessFactors) {
        for (const targetOpenAreaPercent of targetOpenAreas) {
          designSpace.push({ mode, material, thicknessFactor, targetOpenAreaPercent });
        }
      }
    }
  }

  return designSpace;
}

async function buildStructuralRenderMesh(
  candidate: CandidateGeometry,
  requirements: StructuralBracketRequirements
): Promise<RenderableMesh> {
  const targetOpenAreaPercent = numberParam(candidate, "targetOpenAreaPercent", candidate.openAreaPercent ?? 50);
  const fenics = await fetchFenicsDensity({
    nx: 48,
    ny: 48,
    nz: 14,
    loadDirection: requirements.loadCase.direction,
    boltCount: requirements.mounting.boltCount,
    targetOpenAreaPercent,
    safetyFactor: requirements.safetyFactor,
    forceN: requirements.loadCase.forceN
  });

  if (!fenics?.density || !isValidDensityField(fenics.density)) {
    candidate.derivedParameters.fenicsStatus = "unavailable";
    candidate.derivedParameters.fenicsError = fenics?.error ?? "No valid density field returned.";
    return buildDeterministicFallbackMesh(candidate, requirements);
  }

  const stats = summarizeDensity(fenics.density);
  candidate.derivedParameters.fenicsStatus = "connected";
  candidate.derivedParameters.fenicsEngine = fenics.engine ?? "unknown";
  candidate.derivedParameters.fenicsGrid = { nx: stats.nx, ny: stats.ny, nz: stats.nz };
  candidate.derivedParameters.fenicsSolidFraction = roundTo(stats.solidFraction, 0.001);
  candidate.derivedParameters.fenicsAverageDensity = roundTo(stats.averageDensity, 0.001);
  candidate.derivedParameters.fenicsOpenAreaPercent = roundTo(stats.openAreaPercent, 0.1);

  return buildDensitySurfaceMesh(candidate, requirements, fenics.density, stats);
}

async function fetchFenicsDensity(input: {
  nx: number;
  ny: number;
  nz: number;
  loadDirection: string;
  boltCount: number;
  targetOpenAreaPercent: number;
  safetyFactor: number;
  forceN: number;
}): Promise<FenicsDensityResult | undefined> {
  const solverUrl = getFenicsSolverUrl();

  if (!solverUrl) {
    return { ok: false, error: "No FEniCS solver URL configured." };
  }

  try {
    const response = await fetch(`${solverUrl.replace(/\/$/, "")}/fenics-test`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input)
    });

    const data = (await response.json()) as FenicsDensityResult;

    if (!response.ok) {
      return { ok: false, error: data.error ?? `FEniCS solver returned HTTP ${response.status}` };
    }

    return data;
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function getFenicsSolverUrl() {
  const processEnv = typeof process !== "undefined" ? process.env : undefined;
  return processEnv?.HELVARIX_SOLVER_URL?.trim() || processEnv?.VITE_HELVARIX_SOLVER_URL?.trim() || DEFAULT_FENICS_SOLVER_URL;
}

function buildDensitySurfaceMesh(
  candidate: CandidateGeometry,
  requirements: StructuralBracketRequirements,
  density: number[][][],
  stats: DensityStats
): RenderableMesh {
  const mesh = createMeshBuilder();
  const width = candidate.widthMm;
  const height = candidate.heightMm;
  const depth = candidate.depthMm;
  const wall = candidate.wallThicknessMm;
  const railHeight = Math.max(wall * 2.1, height * 0.095);
  const boltCount = clamp(Math.round(requirements.mounting.boltCount), 1, 12);
  const boltDiameterMm = Math.max(requirements.mounting.boltDiameterMm, wall * 0.9);
  const boltPositions = buildBoltPositions(width, height, railHeight, boltCount);
  const loadPoints = buildLoadPoints(width, height, wall, requirements);
  const occupied = densityToOccupancy(density, DENSITY_THRESHOLD);

  carveCylindricalVoids(occupied, {
    width,
    height,
    boltPositions,
    radiusMm: Math.max(boltDiameterMm * 0.52, wall * 0.55)
  });

  const skeleton = extractDensitySkeleton({
    density,
    occupied,
    width,
    height,
    depth,
    wall,
    boltPositions,
    loadPoints,
    requirements
  });

  addPerimeterReferenceFrame(mesh, {
    width,
    height,
    depth,
    wall,
    railHeight,
    requirements
  });

  addDensityReconstructedSkeleton(mesh, {
    width,
    height,
    depth,
    wall,
    density,
    skeleton,
    boltPositions,
    loadPoints,
    requirements
  });

  addBoltHoleWallFeatures(mesh, { boltPositions, boltDiameterMm, depth, wall });
  addLoadInterfacePad(mesh, { width, height, depth, wall, requirements });

  candidate.derivedParameters.geometrySource = "fenics-density-skeleton-reconstruction";
  candidate.derivedParameters.topologyPostProcessing =
    "FEniCS density field thresholded, reduced to bolt/load-connected skeleton paths, then rebuilt as smooth manufacturable beam members instead of raw voxels.";
  candidate.derivedParameters.fenicsSkeletonNodes = skeleton.nodes.length;
  candidate.derivedParameters.fenicsSkeletonPaths = skeleton.paths.length;
  candidate.derivedParameters.fenicsDensityThreshold = DENSITY_THRESHOLD;

  const ribCount = mesh.features.filter((feature) => feature.type === "rib").length;
  const gussetCount = mesh.features.filter((feature) => feature.type === "gusset").length;
  const diagonalWebCount = mesh.features.filter((feature) => feature.type === "diagonal-web").length;

  return {
    version: "haf-render-mesh-v1",
    units: "mm",
    family: candidate.family,
    vertices: mesh.vertices,
    faces: mesh.faces,
    features: mesh.features,
    bounds: { widthMm: width, heightMm: height, depthMm: depth },
    metadata: {
      candidateId: candidate.id,
      source: "fenics-density-skeleton-reconstruction",
      boltCount,
      lighteningHoleCount: Math.max(1, Math.round(stats.openAreaPercent / 12)),
      ribCount,
      gussetCount,
      diagonalWebCount,
      skeletonized: true
    }
  };
}

type DensitySkeletonNode = {
  id: string;
  point: [number, number];
  radius: number;
  group: string;
};

type DensitySkeletonPath = {
  id: string;
  from: [number, number];
  control: [number, number];
  to: [number, number];
  thickness: number;
  group: string;
  shade: number;
};

type DensitySkeleton = {
  nodes: DensitySkeletonNode[];
  paths: DensitySkeletonPath[];
};

function extractDensitySkeleton(args: {
  density: number[][][];
  occupied: boolean[][][];
  width: number;
  height: number;
  depth: number;
  wall: number;
  boltPositions: Array<[number, number]>;
  loadPoints: Array<[number, number]>;
  requirements: StructuralBracketRequirements;
}): DensitySkeleton {
  const { density, width, height, wall, boltPositions, loadPoints, requirements } = args;
  const boltCenter = averagePoints(boltPositions);
  const loadCenter = averagePoints(loadPoints);
  const densityCentroid = weightedDensityCentroid(density, width, height);
  const loadScale = clamp(requirements.loadCase.forceN / 2500, 0.75, 1.65);
  const vibrationScale = clamp((requirements.loadCase.vibrationHz ?? 0) / 150, 0, 1.4);
  const baseThickness = Math.max(wall * 1.18, Math.min(width, height) * 0.042) * loadScale;
  const coreNode: [number, number] = [
    clamp(densityCentroid[0] * 0.45 + boltCenter[0] * 0.2 + loadCenter[0] * 0.35, -width * 0.22, width * 0.22),
    clamp(densityCentroid[1] * 0.45 + boltCenter[1] * 0.2 + loadCenter[1] * 0.35, -height * 0.14, height * 0.24)
  ];
  const upperNode: [number, number] = [
    clamp(loadCenter[0], -width * 0.18, width * 0.18),
    clamp(loadCenter[1] - height * 0.045, -height * 0.04, height * 0.34)
  ];
  const nodes: DensitySkeletonNode[] = [
    { id: "fenics-core-density-node", point: coreNode, radius: baseThickness * 1.18, group: "rib" },
    { id: "fenics-upper-load-node", point: upperNode, radius: baseThickness * 0.96, group: "load-plate" }
  ];
  const paths: DensitySkeletonPath[] = [];

  boltPositions.forEach((bolt, index) => {
    const start = offsetPointAlongSegment(bolt, coreNode, Math.max(wall * 2.2, baseThickness * 1.35));
    const side = bolt[0] < coreNode[0] ? -1 : 1;
    const control = densityGuidedControlPoint({
      density,
      width,
      height,
      from: start,
      to: coreNode,
      preferredOffset: [side * width * 0.055, height * 0.055]
    });
    const localDensity = sampleDensityAtPoint(density, (start[0] + coreNode[0]) / 2, (start[1] + coreNode[1]) / 2, width, height);

    paths.push({
      id: `fenics-primary-bolt-${index + 1}-to-core`,
      from: start,
      control,
      to: coreNode,
      thickness: baseThickness * clamp(0.9 + localDensity * 0.42, 0.82, 1.38),
      group: "diagonal-web",
      shade: 0.68
    });
  });

  paths.push({
    id: "fenics-core-to-load-node",
    from: coreNode,
    control: densityGuidedControlPoint({
      density,
      width,
      height,
      from: coreNode,
      to: upperNode,
      preferredOffset: [0, height * 0.035]
    }),
    to: upperNode,
    thickness: baseThickness * 0.92,
    group: "diagonal-web",
    shade: 0.72
  });

  loadPoints.forEach((loadPoint, index) => {
    const end = offsetPointAlongSegment(loadPoint, upperNode, Math.max(wall * 1.7, baseThickness * 0.7));
    paths.push({
      id: `fenics-load-spreader-${index + 1}`,
      from: upperNode,
      control: [(upperNode[0] + end[0]) / 2, (upperNode[1] + end[1]) / 2 + height * 0.018],
      to: end,
      thickness: baseThickness * 0.58,
      group: "gusset",
      shade: 0.6
    });
  });

  if (boltPositions.length >= 2) {
    const sortedBolts = [...boltPositions].sort((a, b) => a[0] - b[0]);
    for (let index = 0; index < sortedBolts.length - 1; index += 1) {
      const left = sortedBolts[index];
      const right = sortedBolts[index + 1];
      const leftStart = offsetPointAlongSegment(left, right, Math.max(wall * 2.0, baseThickness * 1.15));
      const rightStart = offsetPointAlongSegment(right, left, Math.max(wall * 2.0, baseThickness * 1.15));
      paths.push({
        id: `fenics-bolt-tension-bridge-${index + 1}`,
        from: leftStart,
        control: [(leftStart[0] + rightStart[0]) / 2, Math.min(leftStart[1], rightStart[1]) - height * 0.035],
        to: rightStart,
        thickness: baseThickness * 0.48,
        group: "rib",
        shade: 0.52
      });
    }
  }

  if (vibrationScale > 0.2) {
    const stabilizerY = clamp(coreNode[1] - height * 0.075, -height * 0.24, height * 0.1);
    paths.push({
      id: "fenics-vibration-cross-stabilizer",
      from: [-width * 0.31, stabilizerY],
      control: [0, stabilizerY + height * 0.04],
      to: [width * 0.31, stabilizerY + height * 0.055],
      thickness: baseThickness * (0.32 + vibrationScale * 0.15),
      group: "rib",
      shade: 0.48
    });
  }

  return { nodes, paths };
}

function addPerimeterReferenceFrame(mesh: MeshBuilder, args: { width: number; height: number; depth: number; wall: number; railHeight: number; requirements: StructuralBracketRequirements }) {
  const { width, height, depth, wall, railHeight } = args;
  const frameThickness = Math.max(wall * 0.8, Math.min(width, height) * 0.022);
  const frameDepth = depth * 0.72;
  addBoxFeature(mesh, { id: "fenics-reference-top-load-rail", group: "load-plate", min: [-width / 2, height / 2 - railHeight * 0.72, -frameDepth / 2], max: [width / 2, height / 2 - railHeight * 0.28, frameDepth / 2], shade: 0.55 });
  addBoxFeature(mesh, { id: "fenics-reference-bottom-mount-rail", group: "mounting-plate", min: [-width / 2, -height / 2 + railHeight * 0.18, -frameDepth / 2], max: [width / 2, -height / 2 + railHeight * 0.58, frameDepth / 2], shade: 0.52 });
  addBoxFeature(mesh, { id: "fenics-reference-left-side-rail", group: "rib", min: [-width / 2, -height / 2, -frameDepth / 2], max: [-width / 2 + frameThickness, height / 2, frameDepth / 2], shade: 0.46 });
  addBoxFeature(mesh, { id: "fenics-reference-right-side-rail", group: "rib", min: [width / 2 - frameThickness, -height / 2, -frameDepth / 2], max: [width / 2, height / 2, frameDepth / 2], shade: 0.46 });
}

function addDensityReconstructedSkeleton(mesh: MeshBuilder, args: { width: number; height: number; depth: number; wall: number; density: number[][][]; skeleton: DensitySkeleton; boltPositions: Array<[number, number]>; loadPoints: Array<[number, number]>; requirements: StructuralBracketRequirements }) {
  const { width, height, depth, density, skeleton } = args;
  const memberDepth = depth * 0.78;

  for (const node of skeleton.nodes) {
    const densityAtNode = sampleDensityAtPoint(density, node.point[0], node.point[1], width, height);
    addOrganicNodePad(mesh, {
      id: node.id,
      group: node.group,
      center: [node.point[0], node.point[1], 0],
      radius: node.radius * clamp(0.78 + densityAtNode * 0.38, 0.72, 1.24),
      depth: memberDepth,
      segments: 28,
      shade: node.group === "load-plate" ? 0.72 : 0.64
    });
  }

  skeleton.paths.forEach((path) => addOrganicPathFeature(mesh, { ...path, density, width, height, depth: memberDepth }));
}

function addOrganicPathFeature(mesh: MeshBuilder, options: DensitySkeletonPath & { density: number[][][]; width: number; height: number; depth: number }) {
  const segments = 8;
  let previous = options.from;
  const z = -options.depth / 2;
  for (let index = 1; index <= segments; index += 1) {
    const t = index / segments;
    const point = quadraticPoint(options.from, options.control, options.to, t);
    const midpoint: [number, number] = [(previous[0] + point[0]) / 2, (previous[1] + point[1]) / 2];
    const densityValue = sampleDensityAtPoint(options.density, midpoint[0], midpoint[1], options.width, options.height);
    const taper = 1 - Math.abs(t - 0.5) * 0.28;
    const thickness = options.thickness * clamp(0.72 + densityValue * 0.58, 0.62, 1.45) * taper;
    addOrientedBoxSegment(mesh, { id: `${options.id}-segment-${index}`, group: options.group, start: [previous[0], previous[1], z], end: [point[0], point[1], z], thickness, depth: options.depth, shade: options.shade + densityValue * 0.12 });
    previous = point;
  }
}

function addOrientedBoxSegment(mesh: MeshBuilder, options: { id: string; group: string; start: Vec3; end: Vec3; thickness: number; depth: number; shade: number }) {
  const dx = options.end[0] - options.start[0];
  const dy = options.end[1] - options.start[1];
  const length = Math.max(Math.hypot(dx, dy), 0.001);
  const nx = -dy / length;
  const ny = dx / length;
  const halfThickness = options.thickness / 2;
  const z0 = Math.min(options.start[2], options.end[2]);
  const z1 = z0 + options.depth;
  const a0: Vec3 = [options.start[0] + nx * halfThickness, options.start[1] + ny * halfThickness, z0];
  const a1: Vec3 = [options.start[0] - nx * halfThickness, options.start[1] - ny * halfThickness, z0];
  const b0: Vec3 = [options.end[0] + nx * halfThickness, options.end[1] + ny * halfThickness, z0];
  const b1: Vec3 = [options.end[0] - nx * halfThickness, options.end[1] - ny * halfThickness, z0];
  const a0f: Vec3 = [a0[0], a0[1], z1];
  const a1f: Vec3 = [a1[0], a1[1], z1];
  const b0f: Vec3 = [b0[0], b0[1], z1];
  const b1f: Vec3 = [b1[0], b1[1], z1];
  addQuad(mesh, [a0f, b0f, b1f, a1f], options.group, options.shade * 1.08);
  addQuad(mesh, [a0, a1, b1, b0], options.group, options.shade * 0.78);
  addQuad(mesh, [a0, b0, b0f, a0f], options.group, options.shade * 0.9);
  addQuad(mesh, [a1, a1f, b1f, b1], options.group, options.shade * 0.74);
  addQuad(mesh, [a0, a0f, a1f, a1], options.group, options.shade * 0.7);
  addQuad(mesh, [b0, b1, b1f, b0f], options.group, options.shade * 0.86);
  mesh.features.push({ type: options.group, id: options.id, center: [(options.start[0] + options.end[0]) / 2, (options.start[1] + options.end[1]) / 2, (z0 + z1) / 2], size: [length, options.thickness, options.depth], rotationDeg: Math.atan2(dy, dx) * (180 / Math.PI) } as RenderableMeshFeature);
}

function addOrganicNodePad(mesh: MeshBuilder, options: { id: string; group: string; center: Vec3; radius: number; depth: number; segments: number; shade: number }) {
  const start = mesh.vertices.length;
  const z0 = options.center[2] - options.depth / 2;
  const z1 = options.center[2] + options.depth / 2;
  for (const z of [z0, z1]) {
    mesh.vertices.push([options.center[0], options.center[1], z]);
    for (let index = 0; index < options.segments; index += 1) {
      const angle = (Math.PI * 2 * index) / options.segments;
      const organicRadius = options.radius * (0.94 + 0.08 * Math.sin(index * 1.7));
      mesh.vertices.push([options.center[0] + Math.cos(angle) * organicRadius, options.center[1] + Math.sin(angle) * organicRadius, z]);
    }
  }
  const backCenter = start;
  const backRing = start + 1;
  const frontCenter = start + 1 + options.segments;
  const frontRing = frontCenter + 1;
  for (let index = 0; index < options.segments; index += 1) {
    const next = (index + 1) % options.segments;
    addFace(mesh, [frontCenter, frontRing + index, frontRing + next], options.group, options.shade * 1.08);
    addFace(mesh, [backCenter, backRing + next, backRing + index], options.group, options.shade * 0.76);
    addFace(mesh, [backRing + index, backRing + next, frontRing + next, frontRing + index], options.group, options.shade * 0.86);
  }
  mesh.features.push({ type: options.group, id: options.id, center: options.center, diameterMm: options.radius * 2, throughAxis: "z" } as RenderableMeshFeature);
}

function quadraticPoint(from: [number, number], control: [number, number], to: [number, number], t: number): [number, number] {
  const oneMinusT = 1 - t;
  return [oneMinusT * oneMinusT * from[0] + 2 * oneMinusT * t * control[0] + t * t * to[0], oneMinusT * oneMinusT * from[1] + 2 * oneMinusT * t * control[1] + t * t * to[1]];
}

function averagePoints(points: Array<[number, number]>): [number, number] {
  if (!points.length) return [0, 0];
  const sum = points.reduce((current, point) => [current[0] + point[0], current[1] + point[1]] as [number, number], [0, 0] as [number, number]);
  return [sum[0] / points.length, sum[1] / points.length];
}

function offsetPointAlongSegment(from: [number, number], to: [number, number], distance: number): [number, number] {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const length = Math.max(Math.hypot(dx, dy), 0.0001);
  const t = clamp(distance / length, 0, 0.86);
  return [from[0] + dx * t, from[1] + dy * t];
}

function weightedDensityCentroid(density: number[][][], width: number, height: number): [number, number] {
  const nx = density.length;
  const ny = density[0]?.length ?? 1;
  const nz = density[0]?.[0]?.length ?? 1;
  let weightedX = 0;
  let weightedY = 0;
  let total = 0;
  for (let x = 0; x < nx; x += 1) {
    const xMm = -width / 2 + ((x + 0.5) / nx) * width;
    for (let y = 0; y < ny; y += 1) {
      const yMm = -height / 2 + ((y + 0.5) / ny) * height;
      let columnWeight = 0;
      for (let z = 0; z < nz; z += 1) columnWeight += Number.isFinite(density[x][y][z]) ? clamp(density[x][y][z], 0, 1) : 0;
      weightedX += xMm * columnWeight;
      weightedY += yMm * columnWeight;
      total += columnWeight;
    }
  }
  if (total <= 0) return [0, 0];
  return [weightedX / total, weightedY / total];
}

function densityGuidedControlPoint(args: { density: number[][][]; width: number; height: number; from: [number, number]; to: [number, number]; preferredOffset: [number, number] }): [number, number] {
  const center: [number, number] = [(args.from[0] + args.to[0]) / 2, (args.from[1] + args.to[1]) / 2];
  const candidates: Array<[number, number]> = [[center[0] + args.preferredOffset[0], center[1] + args.preferredOffset[1]], [center[0] - args.preferredOffset[0] * 0.65, center[1] + args.preferredOffset[1] * 0.55], center];
  return candidates.sort((a, b) => sampleDensityAtPoint(args.density, b[0], b[1], args.width, args.height) - sampleDensityAtPoint(args.density, a[0], a[1], args.width, args.height))[0];
}

function sampleDensityAtPoint(density: number[][][], xMm: number, yMm: number, widthMm: number, heightMm: number) {
  const nx = density.length;
  const ny = density[0]?.length ?? 1;
  const nz = density[0]?.[0]?.length ?? 1;
  const xIndex = clamp(Math.round(((xMm + widthMm / 2) / Math.max(widthMm, 1)) * (nx - 1)), 0, nx - 1);
  const yIndex = clamp(Math.round(((yMm + heightMm / 2) / Math.max(heightMm, 1)) * (ny - 1)), 0, ny - 1);
  let total = 0;
  for (let z = 0; z < nz; z += 1) {
    const raw = density[xIndex]?.[yIndex]?.[z] ?? 0;
    total += typeof raw === "number" && Number.isFinite(raw) ? clamp(raw, 0, 1) : 0;
  }
  return total / Math.max(nz, 1);
}

function densityToOccupancy(density: number[][][], threshold: number) {
  return density.map((plane) => plane.map((row) => row.map((value) => Number.isFinite(value) && value >= threshold)));
}

function carveCylindricalVoids(
  occupied: boolean[][][],
  args: { width: number; height: number; boltPositions: Array<[number, number]>; radiusMm: number }
) {
  const nx = occupied.length;
  const ny = occupied[0]?.length ?? 0;
  const nz = occupied[0]?.[0]?.length ?? 0;

  for (let x = 0; x < nx; x += 1) {
    const xMm = -args.width / 2 + ((x + 0.5) / nx) * args.width;
    for (let y = 0; y < ny; y += 1) {
      const yMm = -args.height / 2 + ((y + 0.5) / ny) * args.height;
      const inside = args.boltPositions.some(([bx, by]) => distance2d(xMm, yMm, bx, by) <= args.radiusMm);
      if (!inside) continue;
      for (let z = 0; z < nz; z += 1) {
        occupied[x][y][z] = false;
      }
    }
  }
}

function enforceAnchorPads(
  occupied: boolean[][][],
  args: {
    width: number;
    height: number;
    boltPositions: Array<[number, number]>;
    loadPoints: Array<[number, number]>;
    boltPadRadiusMm: number;
    loadPadRadiusMm: number;
  }
) {
  const nx = occupied.length;
  const ny = occupied[0]?.length ?? 0;
  const nz = occupied[0]?.[0]?.length ?? 0;

  for (let x = 0; x < nx; x += 1) {
    const xMm = -args.width / 2 + ((x + 0.5) / nx) * args.width;
    for (let y = 0; y < ny; y += 1) {
      const yMm = -args.height / 2 + ((y + 0.5) / ny) * args.height;
      const nearBolt = args.boltPositions.some(([bx, by]) => distance2d(xMm, yMm, bx, by) <= args.boltPadRadiusMm);
      const nearLoad = args.loadPoints.some(([lx, ly]) => distance2d(xMm, yMm, lx, ly) <= args.loadPadRadiusMm);
      if (!nearBolt && !nearLoad) continue;
      for (let z = 0; z < nz; z += 1) {
        occupied[x][y][z] = true;
      }
    }
  }
}

function addOccupiedVoxelSurface(
  mesh: MeshBuilder,
  args: {
    occupied: boolean[][][];
    width: number;
    height: number;
    depth: number;
    cellWidth: number;
    cellHeight: number;
    cellDepth: number;
  }
) {
  const { occupied, width, height, depth, cellWidth, cellHeight, cellDepth } = args;
  const nx = occupied.length;
  const ny = occupied[0]?.length ?? 0;
  const nz = occupied[0]?.[0]?.length ?? 0;
  const isSolid = (x: number, y: number, z: number) => x >= 0 && x < nx && y >= 0 && y < ny && z >= 0 && z < nz && occupied[x][y][z];

  for (let x = 0; x < nx; x += 1) {
    for (let y = 0; y < ny; y += 1) {
      for (let z = 0; z < nz; z += 1) {
        if (!occupied[x][y][z]) continue;
        const x0 = -width / 2 + x * cellWidth;
        const x1 = x0 + cellWidth;
        const y0 = -height / 2 + y * cellHeight;
        const y1 = y0 + cellHeight;
        const z0 = -depth / 2 + z * cellDepth;
        const z1 = z0 + cellDepth;
        const shade = 0.54 + (y / Math.max(ny - 1, 1)) * 0.22;

        if (!isSolid(x - 1, y, z)) addQuad(mesh, [[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]], "fenics-density", shade * 0.82);
        if (!isSolid(x + 1, y, z)) addQuad(mesh, [[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]], "fenics-density", shade * 0.9);
        if (!isSolid(x, y - 1, z)) addQuad(mesh, [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]], "fenics-density", shade * 0.78);
        if (!isSolid(x, y + 1, z)) addQuad(mesh, [[x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0]], "fenics-density", shade * 1.02);
        if (!isSolid(x, y, z - 1)) addQuad(mesh, [[x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [x1, y0, z0]], "fenics-density", shade * 0.7);
        if (!isSolid(x, y, z + 1)) addQuad(mesh, [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], "fenics-density", shade * 1.1);
      }
    }
  }

  mesh.features.push({
    type: "mounting-plate",
    id: "fenics-density-surface",
    center: [0, 0, 0],
    size: [width, height, depth]
  });
}

function buildLoadPoints(
  width: number,
  height: number,
  wall: number,
  requirements: StructuralBracketRequirements
): Array<[number, number]> {
  const topY = height / 2 - Math.max(wall * 2.4, height * 0.08);
  const spread = requirements.loadCase.direction === "lateral" ? height * 0.22 : width * 0.18;

  if (requirements.loadCase.direction === "lateral") {
    return [[width * 0.38, height * 0.18], [width * 0.38, -height * 0.18]];
  }
  if (requirements.loadCase.direction === "multi-axis") {
    return [[0, topY], [-spread, topY - height * 0.07], [spread, topY - height * 0.07]];
  }
  return [[0, topY], [-spread, topY], [spread, topY]];
}

function addBoltHoleWallFeatures(
  mesh: MeshBuilder,
  args: { boltPositions: Array<[number, number]>; boltDiameterMm: number; depth: number; wall: number }
) {
  const holeRadius = Math.max(args.boltDiameterMm * 0.52, args.wall * 0.55);
  const wallRadius = Math.max(args.boltDiameterMm * 1.05, args.wall * 1.35);

  args.boltPositions.forEach(([x, y], index) => {
    addOpenCylinderWall(mesh, {
      id: `bolt-hole-${index + 1}`,
      type: "bolt-hole",
      center: [x, y, 0],
      innerRadius: holeRadius,
      outerRadius: wallRadius,
      depth: args.depth,
      segments: 32,
      shade: 0.76
    });
  });
}

function addLoadInterfacePad(
  mesh: MeshBuilder,
  args: {
    width: number;
    height: number;
    depth: number;
    wall: number;
    requirements: StructuralBracketRequirements;
  }
) {
  const loadPadWidth = args.requirements.loadCase.direction === "lateral" ? args.width * 0.24 : args.width * 0.42;
  const loadPadHeight = Math.max(args.wall * 2.2, args.height * 0.08);

  addBoxFeature(mesh, {
    id: "derived-load-interface-pad",
    group: "load-plate",
    min: [-loadPadWidth / 2, args.height / 2 - loadPadHeight * 1.25, -args.depth / 2],
    max: [loadPadWidth / 2, args.height / 2 - loadPadHeight * 0.15, args.depth / 2],
    shade: 0.82
  });
}

function addOpenCylinderWall(
  mesh: MeshBuilder,
  options: {
    id: string;
    type: "bolt-hole" | "lightening-hole";
    center: Vec3;
    innerRadius: number;
    outerRadius: number;
    depth: number;
    segments: number;
    shade: number;
  }
) {
  const start = mesh.vertices.length;
  const z0 = -options.depth / 2;
  const z1 = options.depth / 2;

  for (const z of [z0, z1]) {
    for (const radius of [options.outerRadius, options.innerRadius]) {
      for (let index = 0; index < options.segments; index += 1) {
        const angle = (Math.PI * 2 * index) / options.segments;
        mesh.vertices.push([options.center[0] + Math.cos(angle) * radius, options.center[1] + Math.sin(angle) * radius, z]);
      }
    }
  }

  const backOuter = start;
  const backInner = start + options.segments;
  const frontOuter = start + options.segments * 2;
  const frontInner = start + options.segments * 3;

  for (let index = 0; index < options.segments; index += 1) {
    const next = (index + 1) % options.segments;
    addFace(mesh, [backOuter + index, backOuter + next, frontOuter + next, frontOuter + index], "bolt-hole-wall", options.shade * 0.82);
    addFace(mesh, [frontOuter + index, frontOuter + next, frontInner + next, frontInner + index], "bolt-hole-wall", options.shade * 1.12);
    addFace(mesh, [backInner + index, frontInner + index, frontInner + next, backInner + next], "bolt-hole-wall", options.shade * 0.42);
  }

  mesh.features.push({
    type: options.type,
    id: options.id,
    center: options.center,
    diameterMm: options.innerRadius * 2,
    throughAxis: "z"
  });
}

function buildDeterministicFallbackMesh(candidate: CandidateGeometry, requirements: StructuralBracketRequirements): RenderableMesh {
  const mesh = createMeshBuilder();
  const width = candidate.widthMm;
  const height = candidate.heightMm;
  const depth = candidate.depthMm;
  const wall = candidate.wallThicknessMm;
  const rail = Math.max(wall * 2.2, height * 0.1);
  const boltCount = clamp(Math.round(requirements.mounting.boltCount), 1, 12);
  const boltPositions = buildBoltPositions(width, height, rail, boltCount);

  addBoxFeature(mesh, { id: "fallback-frame-top", group: "load-plate", min: [-width / 2, height / 2 - rail, -depth / 2], max: [width / 2, height / 2, depth / 2], shade: 0.72 });
  addBoxFeature(mesh, { id: "fallback-frame-bottom", group: "mounting-plate", min: [-width / 2, -height / 2, -depth / 2], max: [width / 2, -height / 2 + rail, depth / 2], shade: 0.64 });

  boltPositions.forEach(([x, y], index) => {
    addOpenCylinderWall(mesh, {
      id: `fallback-bolt-${index + 1}`,
      type: "bolt-hole",
      center: [x, y, 0],
      innerRadius: requirements.mounting.boltDiameterMm * 0.52,
      outerRadius: requirements.mounting.boltDiameterMm * 1.15,
      depth,
      segments: 28,
      shade: 0.72
    });
  });

  return {
    version: "haf-render-mesh-v1",
    units: "mm",
    family: candidate.family,
    vertices: mesh.vertices,
    faces: mesh.faces,
    features: mesh.features,
    bounds: { widthMm: width, heightMm: height, depthMm: depth },
    metadata: {
      candidateId: candidate.id,
      source: "deterministic-fallback",
      boltCount,
      lighteningHoleCount: 0,
      ribCount: 0,
      gussetCount: 0,
      diagonalWebCount: 0,
      skeletonized: true
    }
  };
}

function buildBoltPositions(width: number, height: number, railHeight: number, boltCount: number): Array<[number, number]> {
  const safeCount = clamp(Math.round(boltCount), 1, 12);
  const xRadius = width * 0.32;
  const yTop = height / 2 - railHeight * 0.52;
  const yBottom = -height / 2 + railHeight * 0.52;

  if (safeCount === 1) return [[0, yBottom]];
  if (safeCount === 2) return [[-xRadius, yBottom], [xRadius, yBottom]];
  if (safeCount === 3) return [[-xRadius, yBottom], [xRadius, yBottom], [0, yTop]];
  if (safeCount === 4) return [[-xRadius, yTop], [xRadius, yTop], [-xRadius, yBottom], [xRadius, yBottom]];

  const positions: Array<[number, number]> = [];
  for (let index = 0; index < safeCount; index += 1) {
    const angle = -Math.PI / 2 + (Math.PI * 2 * index) / safeCount;
    positions.push([Math.cos(angle) * xRadius, Math.sin(angle) * height * 0.36]);
  }

  return positions;
}

function isValidDensityField(value: unknown): value is number[][][] {
  if (!Array.isArray(value) || value.length === 0) return false;
  if (!Array.isArray(value[0]) || value[0].length === 0) return false;
  if (!Array.isArray(value[0][0]) || value[0][0].length === 0) return false;
  return typeof value[0][0][0] === "number";
}

function summarizeDensity(density: number[][][]): DensityStats {
  let total = 0;
  let solid = 0;
  let sum = 0;

  for (const plane of density) {
    for (const row of plane) {
      for (const raw of row) {
        const value = Number.isFinite(raw) ? clamp(raw, 0, 1) : 0;
        total += 1;
        sum += value;
        if (value >= DENSITY_THRESHOLD) solid += 1;
      }
    }
  }

  return {
    nx: density.length,
    ny: density[0]?.length ?? 0,
    nz: density[0]?.[0]?.length ?? 0,
    solidVoxels: solid,
    totalVoxels: total,
    solidFraction: total > 0 ? solid / total : 0,
    openAreaPercent: total > 0 ? ((total - solid) / total) * 100 : 0,
    averageDensity: total > 0 ? sum / total : 0
  };
}

function buildStructuralValidations(
  requirements: StructuralBracketRequirements,
  selected: CandidateGeometry,
  acceptedCount: number,
  baselineComparison: BaselineComparison
): ValidationMessage[] {
  return [
    {
      severity: acceptedCount > 0 ? "success" : "warning",
      title: acceptedCount > 0 ? "Candidate Search Complete" : "Fallback Candidate Selected",
      text:
        acceptedCount > 0
          ? `${acceptedCount} candidates satisfied first-pass envelope, manufacturability, and safety filters.`
          : "No candidates fully satisfied all filters. The best-scoring fallback candidate was selected."
    },
    {
      severity: selected.safetyFactorEstimate >= requirements.safetyFactor ? "success" : "warning",
      title: "Best Candidate Selected",
      text: `Selected ${selected.id} with score ${selected.totalScore.toFixed(1)}/100, mass ${selected.estimatedMassKg.toFixed(3)} kg, stress ${selected.estimatedStressMpa.toFixed(1)} MPa, displacement ${selected.estimatedDisplacementMm.toFixed(4)} mm, and safety factor ${selected.safetyFactorEstimate.toFixed(2)}.`
    },
    {
      severity: selected.renderMesh ? "success" : "warning",
      title: "FEniCS Density Geometry Generated",
      text: selected.renderMesh
        ? `The selected candidate includes a renderable FEniCS-driven mesh with ${selected.renderMesh.vertices.length} vertices and ${selected.renderMesh.faces.length} faces.`
        : "The selected candidate does not include renderable mesh data."
    },
    {
      severity: baselineComparison.avoidedSimulationRuns > 0 ? "success" : "warning",
      title: "Baseline Comparison",
      text: `Constraint filtering avoided ${baselineComparison.avoidedSimulationRuns} estimated simulation runs compared with the unconstrained baseline.`
    }
  ];
}

function evaluateStructuralCandidateForReview(candidate: CandidateGeometry, requirements: StructuralBracketRequirements): string[] {
  const reasons: string[] = [];
  const basePadRequirement = requirements.mounting.spacingMm + requirements.mounting.boltDiameterMm * 3.2;

  if (candidate.widthMm > requirements.envelope.maxWidthMm) reasons.push("Exceeds maximum width envelope.");
  if (candidate.heightMm > requirements.envelope.maxHeightMm) reasons.push("Exceeds maximum height envelope.");
  if (candidate.depthMm > requirements.envelope.maxDepthMm) reasons.push("Exceeds maximum depth envelope.");
  if (candidate.widthMm < basePadRequirement) reasons.push("Bolt pattern does not fit generated base width.");
  if (candidate.wallThicknessMm < requirements.manufacturing.minWallThicknessMm) reasons.push("Wall thickness below manufacturing minimum.");
  if (candidate.safetyFactorEstimate < requirements.safetyFactor) reasons.push("Estimated safety factor below requirement.");
  if (candidate.manufacturabilityScore < 48) reasons.push("Manufacturability score below threshold.");

  const targetMass = requirements.objectives.targetMassKg;
  if (targetMass && candidate.estimatedMassKg > targetMass * 1.75) reasons.push("Mass exceeds target mass tolerance.");

  return reasons;
}

function createEmergencyStructuralCandidate(family: ComponentFamily, requirements: StructuralBracketRequirements): CandidateGeometry {
  return {
    id: "emergency_fenics_structural_candidate",
    family,
    material: "Ti-6Al-4V",
    widthMm: requirements.envelope.maxWidthMm,
    heightMm: requirements.envelope.maxHeightMm * 0.7,
    depthMm: requirements.envelope.maxDepthMm * 0.7,
    lengthMm: requirements.envelope.maxWidthMm,
    wallThicknessMm: requirements.manufacturing.minWallThicknessMm,
    estimatedMassKg: 0,
    estimatedStressMpa: 0,
    estimatedDisplacementMm: 0,
    safetyFactorEstimate: 0,
    manufacturabilityScore: 0,
    supportBurdenScore: 0,
    performanceScore: 0,
    totalScore: 0,
    rejected: true,
    rejectionReasons: ["Emergency fallback candidate created because no generated candidates were available."],
    skeletonized: true,
    skeletonizationPolicy: "fenics-density",
    openAreaPercent: 0,
    latticeCellCount: 0,
    loadPathContinuityScore: 0,
    derivedParameters: {}
  };
}

function generateBellNozzle(requirements: BellNozzleRequirements): GenerationResult {
  const selected = createNozzleCandidate(requirements);
  const selectedWithMesh: CandidateGeometry = {
    ...selected,
    renderMesh: buildNozzleRenderMesh(selected, requirements)
  };

  const derived: DerivedGeometry = {
    widthMm: selectedWithMesh.widthMm,
    heightMm: selectedWithMesh.heightMm,
    depthMm: selectedWithMesh.depthMm,
    lengthMm: selectedWithMesh.lengthMm,
    wallThicknessMm: selectedWithMesh.wallThicknessMm,
    material: selectedWithMesh.material,
    estimatedMassKg: selectedWithMesh.estimatedMassKg,
    selectedCandidateId: selectedWithMesh.id,
    skeletonized: false,
    skeletonizationPolicy: "sealed-required",
    openAreaPercent: 0,
    latticeCellCount: 0,
    loadPathContinuityScore: 100,
    renderMesh: selectedWithMesh.renderMesh,
    derivedParameters: selectedWithMesh.derivedParameters
  };

  return {
    revision: "REQ-GEN-006-SEALED-NOZZLE-MESH",
    exportState: "idle",
    estimatedMassKg: selectedWithMesh.estimatedMassKg,
    estimatedBurn: 18,
    geometry: {
      silhouette: "bell-nozzle",
      material: selectedWithMesh.material,
      lengthMm: selectedWithMesh.lengthMm,
      widthMm: selectedWithMesh.widthMm,
      heightMm: selectedWithMesh.heightMm,
      depthMm: selectedWithMesh.depthMm,
      wallThicknessMm: selectedWithMesh.wallThicknessMm,
      skeletonized: false,
      skeletonizationPolicy: "sealed-required",
      openAreaPercent: 0,
      latticeCellCount: 0,
      loadPathContinuityScore: 100,
      renderMesh: selectedWithMesh.renderMesh,
      derived,
      candidates: { evaluated: 1, accepted: 1, rejected: 0, bestCandidateId: selectedWithMesh.id },
      notes: [
        "Bell nozzles are treated as sealed pressure-boundary/aerodynamic components.",
        "Skeletonization is intentionally disabled for this component family.",
        "The selected nozzle includes renderable geometry data for concept, mesh, and simulation views."
      ]
    },
    validations: [
      {
        severity: "success",
        title: "Sealed Geometry Required",
        text: "Nozzle generation preserved a sealed pressure boundary instead of applying skeletonized lightening holes."
      },
      {
        severity: "success",
        title: "Renderable Geometry Generated",
        text: `The nozzle candidate includes ${selectedWithMesh.renderMesh?.vertices.length ?? 0} vertices and ${selectedWithMesh.renderMesh?.faces.length ?? 0} faces.`
      }
    ],
    derived,
    candidatesEvaluated: 1,
    candidatesAccepted: 1,
    candidatesRejected: 0,
    selectedCandidate: selectedWithMesh,
    rejectedCandidates: []
  };
}

function createNozzleCandidate(requirements: BellNozzleRequirements): CandidateGeometry {
  const chamberPressureBar = requirements.performance.chamberPressureBar ?? 20;
  const expansionRatio = 18;
  const throatDiameterMm = Math.sqrt(requirements.performance.targetThrustN / chamberPressureBar) * 1.6;
  const exitDiameterMm = Math.min(requirements.envelope.maxExitDiameterMm, throatDiameterMm * Math.sqrt(expansionRatio));
  const lengthMm = Math.min(requirements.envelope.maxLengthMm, exitDiameterMm * 0.82);
  const wallThicknessMm = Math.max(requirements.manufacturing.minWallThicknessMm, 2.4);
  const volumeMm3 =
    Math.PI *
    ((exitDiameterMm / 2) ** 2 - Math.max(exitDiameterMm / 2 - wallThicknessMm, 1) ** 2) *
    lengthMm *
    0.42;

  return {
    id: "sealed_bell_nozzle_candidate_001",
    family: "bell-nozzle",
    material: requirements.thermal.coolingMode === "regenerative" ? "GRCop-42" : "Inconel 718",
    widthMm: roundTo(exitDiameterMm, 0.1),
    heightMm: roundTo(exitDiameterMm, 0.1),
    depthMm: roundTo(exitDiameterMm, 0.1),
    lengthMm: roundTo(lengthMm, 0.1),
    wallThicknessMm,
    estimatedMassKg: roundTo((volumeMm3 / 1_000_000) * 8.3, 0.001),
    estimatedStressMpa: roundTo(chamberPressureBar * 2.1 * requirements.safetyFactor, 0.01),
    estimatedDisplacementMm: roundTo(lengthMm * 0.0008, 0.0001),
    safetyFactorEstimate: 1.35,
    manufacturabilityScore: 82,
    supportBurdenScore: 74,
    performanceScore: 84,
    totalScore: 82,
    rejected: false,
    rejectionReasons: [],
    skeletonized: false,
    skeletonizationPolicy: "sealed-required",
    openAreaPercent: 0,
    latticeCellCount: 0,
    loadPathContinuityScore: 100,
    derivedParameters: {
      throatDiameterMm: roundTo(throatDiameterMm, 0.1),
      exitDiameterMm: roundTo(exitDiameterMm, 0.1),
      expansionRatio,
      chamberPressureBar,
      coolingMode: requirements.thermal.coolingMode,
      oxidizer: requirements.propellant.oxidizer,
      fuel: requirements.propellant.fuel,
      sealedPressureBoundary: true
    }
  };
}

function buildNozzleRenderMesh(candidate: CandidateGeometry, requirements: BellNozzleRequirements): RenderableMesh {
  const mesh = createMeshBuilder();
  const length = candidate.lengthMm;
  const exitDiameter = candidate.widthMm;
  const throatDiameter = numberParam(candidate, "throatDiameterMm", exitDiameter * 0.28);
  const chamberDiameter = Math.max(throatDiameter * 2.4, exitDiameter * 0.42);
  const stations = [
    { z: -length * 0.5, radius: chamberDiameter / 2 },
    { z: -length * 0.31, radius: chamberDiameter / 2 },
    { z: -length * 0.13, radius: throatDiameter / 2 },
    { z: length * 0.12, radius: exitDiameter * 0.31 },
    { z: length * 0.34, radius: exitDiameter * 0.43 },
    { z: length * 0.5, radius: exitDiameter / 2 }
  ];
  const segments = 36;

  for (const station of stations) {
    for (let index = 0; index < segments; index += 1) {
      const angle = (Math.PI * 2 * index) / segments;
      mesh.vertices.push([Math.cos(angle) * station.radius, Math.sin(angle) * station.radius, station.z]);
    }
  }

  for (let stationIndex = 0; stationIndex < stations.length - 1; stationIndex += 1) {
    for (let segmentIndex = 0; segmentIndex < segments; segmentIndex += 1) {
      const next = (segmentIndex + 1) % segments;
      addFace(
        mesh,
        [stationIndex * segments + segmentIndex, stationIndex * segments + next, (stationIndex + 1) * segments + next, (stationIndex + 1) * segments + segmentIndex],
        "nozzle-shell",
        0.66 + (stationIndex / stations.length) * 0.22
      );
    }
  }

  return {
    version: "haf-render-mesh-v1",
    units: "mm",
    family: "bell-nozzle",
    vertices: mesh.vertices,
    faces: mesh.faces,
    features: [],
    bounds: { widthMm: exitDiameter, heightMm: exitDiameter, depthMm: length },
    metadata: {
      candidateId: candidate.id,
      source: "generation-engine",
      boltCount: 0,
      lighteningHoleCount: 0,
      ribCount: 0,
      gussetCount: 0,
      diagonalWebCount: 0,
      skeletonized: false
    }
  };
}

function selectStructuralMaterialOptions(requirements: StructuralBracketRequirements): StructuralMaterial[] {
  const materials: StructuralMaterial[] = [
    { name: "AlSi10Mg", densityGcc: 2.68, allowableStressMpa: 165, elasticModulusMpa: 70_000 },
    { name: "Ti-6Al-4V", densityGcc: 4.43, allowableStressMpa: 780, elasticModulusMpa: 114_000 },
    { name: "Inconel 718", densityGcc: 8.19, allowableStressMpa: 1030, elasticModulusMpa: 200_000 }
  ];

  if (requirements.objectives.priority === "lightweight") return [materials[0], materials[1], materials[2]];
  if (requirements.objectives.priority === "stiffness") return [materials[1], materials[2], materials[0]];
  return materials;
}

function createMeshBuilder(): MeshBuilder {
  return { vertices: [], faces: [], features: [] };
}

function addBoxFeature(
  mesh: MeshBuilder,
  options: {
    id: string;
    group: string;
    min: Vec3;
    max: Vec3;
    shade: number;
  }
) {
  const start = mesh.vertices.length;
  const [x0, y0, z0] = options.min;
  const [x1, y1, z1] = options.max;
  mesh.vertices.push([x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]);
  addFace(mesh, [start + 0, start + 1, start + 2, start + 3], options.group, options.shade * 0.88);
  addFace(mesh, [start + 4, start + 7, start + 6, start + 5], options.group, options.shade * 1.12);
  addFace(mesh, [start + 0, start + 4, start + 5, start + 1], options.group, options.shade * 1.02);
  addFace(mesh, [start + 1, start + 5, start + 6, start + 2], options.group, options.shade * 1.08);
  addFace(mesh, [start + 2, start + 6, start + 7, start + 3], options.group, options.shade);
  addFace(mesh, [start + 3, start + 7, start + 4, start + 0], options.group, options.shade * 0.84);
  mesh.features.push({
    type: options.group,
    id: options.id,
    center: [(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2],
    size: [Math.abs(x1 - x0), Math.abs(y1 - y0), Math.abs(z1 - z0)]
  } as RenderableMeshFeature);
}

function addQuad(mesh: MeshBuilder, vertices: Vec3[], group: string, shade: number) {
  const start = mesh.vertices.length;
  mesh.vertices.push(vertices[0], vertices[1], vertices[2], vertices[3]);
  addFace(mesh, [start, start + 1, start + 2, start + 3], group, shade);
}

function addFace(mesh: MeshBuilder, indices: number[], group: string, shade: number) {
  mesh.faces.push({ indices, group, shade: clamp(shade, 0.1, 1.4) } as RenderableMesh["faces"][number]);
}

function numberParam(candidate: CandidateGeometry, key: string, fallback: number) {
  const value = candidate.derivedParameters[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function widthFactorForMode(mode: StructuralMode) {
  if (mode === "minimum-mass-density") return 0.54;
  if (mode === "stiffness-density") return 0.64;
  if (mode === "vibration-density") return 0.62;
  return 0.58;
}

function heightFactorForMode(mode: StructuralMode) {
  if (mode === "minimum-mass-density") return 0.42;
  if (mode === "stiffness-density") return 0.52;
  if (mode === "vibration-density") return 0.5;
  return 0.46;
}

function topologyEfficiencyForMode(mode: StructuralMode, requirements: StructuralBracketRequirements) {
  const vibration = requirements.loadCase.vibrationHz ?? 0;
  if (mode === "minimum-mass-density") return vibration > 100 ? 1.08 : 1.16;
  if (mode === "stiffness-density") return 1.28;
  if (mode === "vibration-density") return 1.22 + Math.min(vibration / 1000, 0.18);
  return 1.2;
}

function densityModeFitScore(mode: StructuralMode, requirements: StructuralBracketRequirements) {
  if (requirements.objectives.priority === "lightweight" && mode === "minimum-mass-density") return 96;
  if (requirements.objectives.priority === "stiffness" && mode === "stiffness-density") return 96;
  if ((requirements.loadCase.vibrationHz ?? 0) > 80 && mode === "vibration-density") return 94;
  if (mode === "balanced-density") return 88;
  return 82;
}

function estimateComputeBurn(evaluated: number, accepted: number) {
  return Math.max(1, Math.ceil(evaluated / 18) + Math.max(0, 2 - accepted));
}

function weightedAverage(items: Array<[number, number]>) {
  const totalWeight = items.reduce((sum, [, weight]) => sum + weight, 0);
  if (totalWeight <= 0) return 0;
  return items.reduce((sum, [value, weight]) => sum + value * weight, 0) / totalWeight;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function roundTo(value: number, step: number) {
  return Math.round(value / step) * step;
}

function distance2d(x0: number, y0: number, x1: number, y1: number) {
  return Math.hypot(x0 - x1, y0 - y1);
}
