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
const FENICS_DENSITY_THRESHOLD = 0.42;

type FenicsDensityResult = {
  ok?: boolean;
  engine?: string;
  density?: number[][][];
  error?: string;
};

type FenicsDensitySample = {
  value: number;
  normalized: number;
};

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

type StructuralTopologyMode =
  | "direct-load-path"
  | "split-y-truss"
  | "arched-bridge"
  | "cantilever-side-load"
  | "vibration-stabilized";

type StructuralDesignParameters = {
  topologyMode: StructuralTopologyMode;
  thicknessFactor: number;
  ribCount: number;
  gussetCount: number;
  diagonalWebCount: number;
  lighteningHoleCount: number;
  lighteningHoleDiameterMm: number;
  skeletonLevel: "none" | "light" | "moderate" | "aggressive";
};

async function generateStructuralPart(
  family: ComponentFamily,
  requirements: StructuralBracketRequirements
): Promise<GenerationResult> {
  const filteredCandidates = buildStructuralCandidates(family, requirements, {
    applyConstraintFiltering: true,
    idPrefix: "filtered"
  });

  const baselineCandidates = buildStructuralCandidates(family, requirements, {
    applyConstraintFiltering: false,
    idPrefix: "baseline"
  });

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
    revision: "REQ-GEN-005-CONSTRAINT-DRIVEN-TOPOLOGY",
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
        `${filteredCandidates.length} constraint-driven topology candidates were generated and scored.`,
        `${rejected.length} candidates were rejected before simulation by manufacturability, load-path, envelope, and safety filters.`,
        `${accepted.length} candidates advanced to simulation-ready review.`,
        `Selected candidate ${selected.id} with total score ${selected.totalScore.toFixed(1)}/100.`,
        `Selected geometry uses ${requirements.mounting.boltCount} bolt hole${
          requirements.mounting.boltCount === 1 ? "" : "s"
        } from the input requirements.`,
        `Selected geometry is ${
          selected.skeletonized ? "skeletonized" : "solid/sealed"
        } with ${(selected.openAreaPercent ?? 0).toFixed(1)}% open area and topology mode ${String(selected.derivedParameters.topologyMode ?? "auto")}.`,
        `Estimated mass is ${selected.estimatedMassKg.toFixed(
          3
        )} kg with estimated safety factor ${selected.safetyFactorEstimate.toFixed(2)}.`,
        `Constraint-filtered generation avoided ${baselineComparison.avoidedSimulationRuns} estimated simulation runs compared with the unconstrained baseline.`
      ]
    },
    validations: buildStructuralValidations(
      requirements,
      selected,
      accepted.length,
      baselineComparison
    ),
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
        "Fabrication review placeholder. Populate after external AM print with vendor, material, orientation, support outcome, dimensional observations, defects, and predicted-vs-observed comparison."
    }
  };
}

function buildStructuralCandidates(
  family: ComponentFamily,
  requirements: StructuralBracketRequirements,
  options: {
    applyConstraintFiltering: boolean;
    idPrefix: string;
  }
): CandidateGeometry[] {
  const candidates: CandidateGeometry[] = [];
  const materialOptions = selectStructuralMaterialOptions(requirements);
  const designSpace = buildStructuralDesignSpace(family, requirements);
  const skeletonPolicy = resolveSkeletonizationPolicy(family, requirements);
  const sealedRequired = skeletonPolicy === "sealed-required" || skeletonPolicy === "none";

  const loadMultiplier =
    requirements.loadCase.direction === "multi-axis"
      ? 1.35
      : requirements.loadCase.direction === "lateral"
        ? 1.18
        : 1;

  const vibrationMultiplier = requirements.loadCase.vibrationHz
    ? 1 + Math.min(requirements.loadCase.vibrationHz / 500, 0.45)
    : 1;

  const requiredLoadN =
    requirements.loadCase.forceN *
    requirements.safetyFactor *
    loadMultiplier *
    vibrationMultiplier;

  const basePadRequirement =
    requirements.mounting.spacingMm + requirements.mounting.boltDiameterMm * 3.2;

  let index = 0;

  for (const material of materialOptions) {
    for (const params of designSpace) {
      index += 1;

      const wallThicknessMm = roundTo(
        requirements.manufacturing.minWallThicknessMm * params.thicknessFactor,
        0.1
      );

      const widthMm = clamp(
        Math.max(
          basePadRequirement * (params.ribCount <= 2 ? 0.96 : 1),
          requirements.envelope.maxWidthMm * (0.48 + params.ribCount * 0.038)
        ),
        requirements.mounting.boltDiameterMm * 4,
        requirements.envelope.maxWidthMm * 1.08
      );

      const heightMm = clamp(
        requirements.envelope.maxHeightMm * (0.36 + params.gussetCount * 0.043),
        requirements.mounting.boltDiameterMm * 4,
        requirements.envelope.maxHeightMm * 1.08
      );

      const depthMm = clamp(
        requirements.envelope.maxDepthMm * (0.42 + params.thicknessFactor * 0.075),
        requirements.mounting.boltDiameterMm * 3.5,
        requirements.envelope.maxDepthMm * 1.08
      );

      const openAreaPercent = sealedRequired
        ? 0
        : calculateOpenAreaPercent(requirements, params);

      const skeletonized = openAreaPercent > 8;
      const latticeCellCount = skeletonized
        ? params.ribCount +
          params.gussetCount +
          params.diagonalWebCount +
          params.lighteningHoleCount
        : 0;

      const loadPathContinuityScore = calculateLoadPathContinuityScore(params, openAreaPercent);

      const ribEfficiency = 1 + params.ribCount * 0.105;
      const gussetEfficiency = 1 + params.gussetCount * 0.067;
      const diagonalWebEfficiency = 1 + params.diagonalWebCount * 0.052;

      const loadPathMultiplier = clamp(loadPathContinuityScore / 100, 0.45, 1.12);
      const lighteningPenalty = skeletonized
        ? clamp(openAreaPercent * 0.0065 + params.lighteningHoleDiameterMm * 0.006, 0, 0.34)
        : 0;

      const boltInterfacePenalty = widthMm < basePadRequirement ? 0.72 : 1;
      const sectionAreaMm2 = wallThicknessMm * (widthMm + heightMm * 0.7);

      const loadCapacityN =
        sectionAreaMm2 *
        material.allowableStressMpa *
        ribEfficiency *
        gussetEfficiency *
        diagonalWebEfficiency *
        loadPathMultiplier *
        boltInterfacePenalty *
        (1 - lighteningPenalty) *
        0.82;

      const safetyFactorEstimate = loadCapacityN / Math.max(requirements.loadCase.forceN, 1);

      const estimatedStressMpa =
        requiredLoadN /
        Math.max(
          sectionAreaMm2 *
            ribEfficiency *
            diagonalWebEfficiency *
            loadPathMultiplier *
            boltInterfacePenalty *
            (1 - lighteningPenalty * 0.72),
          1
        );

      const estimatedDisplacementMm =
        (requirements.loadCase.forceN * Math.pow(heightMm, 2)) /
        Math.max(
          material.elasticModulusMpa *
            sectionAreaMm2 *
            ribEfficiency *
            diagonalWebEfficiency *
            loadPathMultiplier *
            175,
          1
        );

      const solidVolumeMm3 =
        widthMm * depthMm * wallThicknessMm * 2.2 +
        heightMm * depthMm * wallThicknessMm * 1.5 +
        params.ribCount * heightMm * wallThicknessMm * depthMm * 0.42 +
        params.gussetCount * widthMm * wallThicknessMm * depthMm * 0.28 +
        params.diagonalWebCount * heightMm * wallThicknessMm * depthMm * 0.18;

      const removedVolumeFactor = clamp(openAreaPercent / 100, 0, 0.55);
      const reinforcedEdgeVolumeFactor = skeletonized ? 0.04 + latticeCellCount * 0.002 : 0;
      const volumeMm3 = solidVolumeMm3 * (1 - removedVolumeFactor + reinforcedEdgeVolumeFactor);

      const estimatedMassKg = (volumeMm3 / 1_000_000) * material.densityGcc;

      const targetMass = requirements.objectives.targetMassKg;
      const requiredSafetyFactor = Math.max(requirements.safetyFactor, 0.1);
      const achievedSafetyRatio = safetyFactorEstimate / requiredSafetyFactor;
      const minimumViableMassKg = Math.max(
        0.08,
        (requirements.loadCase.forceN * requiredSafetyFactor) /
          Math.max(material.allowableStressMpa * 35_000, 1)
      );
      const massTargetKg = targetMass ?? minimumViableMassKg * 3.2;

      const massScore = clamp(
        targetMass
          ? 100 - Math.max(0, estimatedMassKg - targetMass) * 95 - Math.max(0, targetMass - estimatedMassKg) * 18
          : 112 - (estimatedMassKg / Math.max(massTargetKg, 0.001)) * 34,
        0,
        100
      );

      const stiffnessScore = clamp(100 - estimatedDisplacementMm * 28, 0, 100);

      const strengthScore = achievedSafetyRatio < 1
        ? clamp(achievedSafetyRatio * 78, 0, 78)
        : clamp(104 - Math.max(0, achievedSafetyRatio - 1.25) * 14, 72, 104);

      const skeletonScore = sealedRequired
        ? 100
        : calculateSkeletonScore(requirements, openAreaPercent, loadPathContinuityScore);

      const supportAccessPenalty =
        requirements.manufacturing.process === "additive" && params.gussetCount === 0 ? 16 : 0;

      const overhangPenalty =
        requirements.manufacturing.process === "additive" &&
        requirements.manufacturing.maxOverhangDeg < 45 &&
        params.gussetCount < 4
          ? 22
          : 0;

      const unsupportedPenalty =
        requirements.manufacturing.process === "additive" &&
        !requirements.manufacturing.supportAllowed &&
        params.gussetCount < 4
          ? 18
          : 0;

      const skeletonManufacturingBonus = skeletonized ? 8 : 0;

      const skeletonManufacturingPenalty =
        skeletonized && openAreaPercent > 52
          ? 18
          : skeletonized && loadPathContinuityScore < 72
            ? 12
            : 0;

      const manufacturabilityScore = clamp(
        100 -
          overhangPenalty -
          unsupportedPenalty -
          supportAccessPenalty -
          skeletonManufacturingPenalty -
          Math.max(0, wallThicknessMm - requirements.manufacturing.minWallThicknessMm * 2.4) * 4 -
          (widthMm < basePadRequirement ? 18 : 0) +
          skeletonManufacturingBonus,
        0,
        100
      );

      const supportBurdenScore = clamp(
        100 -
          (requirements.manufacturing.supportAllowed ? 4 : 16) -
          Math.max(0, 45 - requirements.manufacturing.maxOverhangDeg) * 1.2 -
          Math.max(0, 4 - params.gussetCount) * 6 -
          (skeletonized && params.lighteningHoleDiameterMm < wallThicknessMm * 2 ? 10 : 0),
        0,
        100
      );

      const boltCount = clamp(Math.round(requirements.mounting.boltCount), 1, 12);
      const memberCount = params.ribCount + params.gussetCount + params.diagonalWebCount;
      const idealMemberCount = boltCount <= 2
        ? requirements.loadCase.vibrationHz && requirements.loadCase.vibrationHz > 120
          ? 4
          : 3
        : Math.min(8, boltCount + 2);
      const estimatedNodeCount =
        boltCount +
        (params.topologyMode === "direct-load-path" ? 1 : 2) +
        (params.topologyMode === "vibration-stabilized" ? 1 : 0) +
        (params.topologyMode === "arched-bridge" ? 1 : 0);

      const topologyFitScore = calculateTopologyFitScore(
        params.topologyMode,
        requirements,
        boltCount,
        memberCount
      );

      const efficiencyScore = clamp(
        100 -
          Math.abs(achievedSafetyRatio - 1.35) * 18 -
          Math.max(0, estimatedMassKg / Math.max(minimumViableMassKg, 0.001) - 3.5) * 7 -
          Math.max(0, material.densityGcc - 4.5) * 7,
        0,
        100
      );

      const excessSafetyPenalty = clamp(Math.max(0, achievedSafetyRatio - 1.75) * 7, 0, 22);
      const memberPenalty = clamp(Math.max(0, memberCount - idealMemberCount) * 3.8, 0, 24);
      const nodePenalty = clamp(Math.max(0, estimatedNodeCount - (boltCount + 2)) * 3.2, 0, 16);
      const heavyMaterialPenalty = clamp(Math.max(0, material.densityGcc - 4.6) * 4.8, 0, 20);
      const topologyComplexityPenalty = clamp(
        memberPenalty + nodePenalty + heavyMaterialPenalty + excessSafetyPenalty,
        0,
        46
      );

      const performanceScore =
        requirements.objectives.priority === "lightweight"
          ? weightedAverage([
              [massScore, 0.34],
              [efficiencyScore, 0.24],
              [strengthScore, 0.18],
              [topologyFitScore, 0.14],
              [manufacturabilityScore, 0.1]
            ])
          : requirements.objectives.priority === "stiffness"
            ? weightedAverage([
                [stiffnessScore, 0.27],
                [strengthScore, 0.23],
                [efficiencyScore, 0.2],
                [topologyFitScore, 0.16],
                [massScore, 0.14]
              ])
            : weightedAverage([
                [efficiencyScore, 0.25],
                [massScore, 0.22],
                [strengthScore, 0.19],
                [topologyFitScore, 0.16],
                [manufacturabilityScore, 0.11],
                [stiffnessScore, 0.07]
              ]);

      const totalScore = clamp(
        weightedAverage([
          [performanceScore, 0.42],
          [efficiencyScore, 0.2],
          [massScore, 0.18],
          [topologyFitScore, 0.12],
          [manufacturabilityScore, 0.08]
        ]) - topologyComplexityPenalty,
        0,
        100
      );

      const candidate: CandidateGeometry = {
        id: `${options.idPrefix}_${family.replace(/[^a-z0-9]/gi, "-")}_cand_${String(
          index
        ).padStart(3, "0")}`,
        family,
        material: material.name,
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
        supportBurdenScore: roundTo(supportBurdenScore, 0.1),
        performanceScore: roundTo(performanceScore, 0.1),
        totalScore: roundTo(totalScore, 0.1),
        rejected: false,
        rejectionReasons: [],
        skeletonized,
        skeletonizationPolicy: skeletonPolicy,
        openAreaPercent: roundTo(openAreaPercent, 0.1),
        latticeCellCount,
        loadPathContinuityScore: roundTo(loadPathContinuityScore, 0.1),
        derivedParameters: {
          topologyMode: params.topologyMode,
          ribCount: params.ribCount,
          gussetCount: params.gussetCount,
          diagonalWebCount: params.diagonalWebCount,
          lighteningHoleCount: params.lighteningHoleCount,
          lighteningHoleDiameterMm: params.lighteningHoleDiameterMm,
          skeletonLevel: params.skeletonLevel,
          openAreaPercent: roundTo(openAreaPercent, 0.1),
          latticeCellCount,
          loadPathContinuityScore: roundTo(loadPathContinuityScore, 0.1),
          optimizationObjective: "minimum viable mass at required safety factor",
          achievedSafetyRatio: roundTo(achievedSafetyRatio, 0.01),
          minimumViableMassKg: roundTo(minimumViableMassKg, 0.001),
          massTargetKg: roundTo(massTargetKg, 0.001),
          efficiencyScore: roundTo(efficiencyScore, 0.1),
          topologyFitScore: roundTo(topologyFitScore, 0.1),
          topologyComplexityPenalty: roundTo(topologyComplexityPenalty, 0.1),
          estimatedMemberCount: memberCount,
          idealMemberCount,
          estimatedNodeCount,
          boltPadDiameterMm: roundTo(requirements.mounting.boltDiameterMm * 2.4, 0.1),
          requiredLoadN: roundTo(requiredLoadN, 0.1),
          loadDirection: requirements.loadCase.direction,
          vibrationHz: requirements.loadCase.vibrationHz ?? 0,
          manufacturingProcess: requirements.manufacturing.process,
          supportAllowed: requirements.manufacturing.supportAllowed,
          boltCount: requirements.mounting.boltCount,
          boltDiameterMm: requirements.mounting.boltDiameterMm,
          boltSpacingMm: requirements.mounting.spacingMm,
          overhangLimitDeg: requirements.manufacturing.maxOverhangDeg,
          baselineMode: !options.applyConstraintFiltering
        }
      };

      const rejectionReasons = options.applyConstraintFiltering
        ? evaluateStructuralCandidateForReview(candidate, requirements)
        : [];

      candidates.push({
        ...candidate,
        rejected: rejectionReasons.length > 0,
        rejectionReasons
      });
    }
  }

  return candidates;
}

async function buildStructuralRenderMesh(
  candidate: CandidateGeometry,
  requirements: StructuralBracketRequirements
): Promise<RenderableMesh> {
  const fenics = await fetchFenicsDensity({
    nx: 36,
    ny: 36,
    nz: 12,
    loadDirection: requirements.loadCase.direction
  });

  if (fenics?.density && isValidDensityField(fenics.density)) {
    candidate.derivedParameters.fenicsEngine = fenics.engine ?? "fenics-topology-placeholder";
    candidate.derivedParameters.fenicsStatus = "connected";
    candidate.derivedParameters.fenicsGrid = {
      nx: fenics.density.length,
      ny: fenics.density[0]?.length ?? 0,
      nz: fenics.density[0]?.[0]?.length ?? 0
    };

    return buildFenicsDensityDrivenStructuralMesh(candidate, requirements, fenics.density);
  }

  candidate.derivedParameters.fenicsStatus = "fallback-local-topology";
  if (fenics?.error) {
    candidate.derivedParameters.fenicsError = fenics.error;
  }

  return buildTopologyOptimizedStructuralMesh(candidate, requirements);
}

async function fetchFenicsDensity(input: {
  nx: number;
  ny: number;
  nz: number;
  loadDirection: string;
}): Promise<FenicsDensityResult | undefined> {
  const solverUrl = getFenicsSolverUrl();

  if (!solverUrl) {
    return {
      ok: false,
      error: "HELVARIX_SOLVER_URL is not configured and no default solver URL is available."
    };
  }

  try {
    const response = await fetch(`${solverUrl.replace(/\/$/, "")}/fenics-test`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify(input)
    });

    const data = (await response.json()) as FenicsDensityResult;

    if (!response.ok) {
      return {
        ok: false,
        error: data?.error ?? `FEniCS solver returned HTTP ${response.status}`
      };
    }

    return data;
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err)
    };
  }
}

function getFenicsSolverUrl() {
  const processEnv = typeof process !== "undefined" ? process.env : undefined;

  return (
    processEnv?.HELVARIX_SOLVER_URL?.trim() ||
    processEnv?.VITE_HELVARIX_SOLVER_URL?.trim() ||
    DEFAULT_FENICS_SOLVER_URL
  );
}

function isValidDensityField(value: unknown): value is number[][][] {
  if (!Array.isArray(value) || value.length === 0) return false;
  if (!Array.isArray(value[0]) || value[0].length === 0) return false;
  if (!Array.isArray(value[0][0]) || value[0][0].length === 0) return false;

  return typeof value[0][0][0] === "number";
}


function buildFenicsDensityDrivenStructuralMesh(
  candidate: CandidateGeometry,
  requirements: StructuralBracketRequirements,
  density: number[][][]
): RenderableMesh {
  const mesh = createMeshBuilder();

  const width = candidate.widthMm;
  const height = candidate.heightMm;
  const depth = candidate.depthMm;
  const wall = candidate.wallThicknessMm;

  const boltCount = clamp(Math.round(requirements.mounting.boltCount), 1, 12);
  const boltDiameterMm = Math.max(requirements.mounting.boltDiameterMm, wall * 0.9);
  const railHeight = Math.max(wall * 2.05, height * 0.105);
  const boltPositions = buildBoltPositions(width, height, railHeight, boltCount);
  const loadPoints = buildFenicsLoadPoints(width, height, wall, requirements);

  const field = createFenicsTopologyField({
    width,
    height,
    wall,
    boltPositions,
    boltDiameterMm,
    loadPoints,
    density
  });

  addPerimeterSkin(mesh, {
    width,
    height,
    depth,
    wall,
    field
  });

  addFenicsOrganicSkeleton(mesh, {
    width,
    height,
    depth,
    wall,
    density,
    field,
    candidate,
    requirements
  });

  addBoltHoleWallFeatures(mesh, {
    boltPositions,
    boltDiameterMm,
    depth,
    wall
  });

  addLoadInterfaceFeatures(mesh, {
    width,
    height,
    depth,
    wall,
    requirements
  });

  const loadPathMembers = mesh.features.filter((feature) =>
    feature.type === "diagonal-web" || feature.type === "gusset" || feature.type === "rib"
  ).length;

  const densityStats = summarizeDensity(density);
  const actualOpenAreaPercent = roundTo(field.actualOpenAreaPercent, 0.1);

  candidate.derivedParameters.fenicsAverageDensity = roundTo(densityStats.average, 0.001);
  candidate.derivedParameters.fenicsSolidFraction = roundTo(densityStats.solidFraction, 0.001);
  candidate.derivedParameters.fenicsOpenAreaPercent = actualOpenAreaPercent;
  candidate.derivedParameters.topologyMode = "fenics-density-field";
  candidate.derivedParameters.topologyPostProcessing =
    "FEniCS density field, thresholded load paths, density-guided member thickness, manufacturable node and beam reconstruction";
  candidate.derivedParameters.topologySkeletonMembers = loadPathMembers;

  return {
    version: "haf-render-mesh-v1",
    units: "mm",
    family: candidate.family,
    vertices: mesh.vertices,
    faces: mesh.faces,
    features: mesh.features,
    bounds: {
      widthMm: width,
      heightMm: height,
      depthMm: depth
    },
    metadata: {
      candidateId: candidate.id,
      source: "fenics-density-field",
      boltCount,
      lighteningHoleCount: Math.max(0, Math.round(actualOpenAreaPercent / 7)),
      ribCount: Math.max(1, Math.round(loadPathMembers * 0.25)),
      gussetCount: Math.max(0, Math.round(loadPathMembers * 0.35)),
      diagonalWebCount: Math.max(1, Math.round(loadPathMembers * 0.4)),
      skeletonized: true
    }
  };
}

function createFenicsTopologyField(args: {
  width: number;
  height: number;
  wall: number;
  boltPositions: Array<[number, number]>;
  boltDiameterMm: number;
  loadPoints: Array<[number, number]>;
  density: number[][][];
}): TopologyField {
  const { width, height, wall, boltPositions, boltDiameterMm, loadPoints, density } = args;

  const columns = density.length;
  const rows = density[0]?.length ?? 1;
  const cellWidth = width / Math.max(columns, 1);
  const cellHeight = height / Math.max(rows, 1);
  const boltHoleRadius = Math.max(boltDiameterMm * 0.52, wall * 0.55);
  const boltPadRadius = Math.max(boltDiameterMm * 1.85, wall * 2.45);

  const occupied = Array.from({ length: rows }, () =>
    Array.from({ length: columns }, () => false)
  );

  const cells: TopologyCell[] = [];

  for (let row = 0; row < rows; row += 1) {
    const y = -height / 2 + (row + 0.5) * cellHeight;

    for (let column = 0; column < columns; column += 1) {
      const x = -width / 2 + (column + 0.5) * cellWidth;
      const sample = sampleFenicsDensity(density, x, y, 0, width, height);
      const insideBoltVoid = boltPositions.some(([bx, by]) => {
        return distance2d(x, y, bx, by) < boltHoleRadius;
      });

      const nearAnchor = boltPositions.some(([bx, by]) => {
        return distance2d(x, y, bx, by) < boltPadRadius * 1.1;
      });

      const nearLoad = loadPoints.some(([lx, ly]) => {
        return distance2d(x, y, lx, ly) < Math.max(wall * 3.4, width * 0.06);
      });

      const keep = !insideBoltVoid && (nearAnchor || nearLoad || sample.normalized >= FENICS_DENSITY_THRESHOLD);
      occupied[row][column] = keep;

      if (keep) {
        cells.push({
          column,
          row,
          x,
          y,
          density: sample.normalized,
          stress: sample.normalized,
          group: nearAnchor ? "bolt-load-pad" : nearLoad ? "load-interface" : "fenics-density-field"
        });
      }
    }
  }

  const total = Math.max(columns * rows, 1);
  const actualOpenAreaPercent = ((total - cells.length) / total) * 100;

  return {
    columns,
    rows,
    cellWidth,
    cellHeight,
    occupied,
    cells,
    boltPositions,
    boltHoleRadius,
    boltPadRadius,
    loadPoints,
    targetOpenAreaPercent: actualOpenAreaPercent,
    actualOpenAreaPercent,
    threshold: FENICS_DENSITY_THRESHOLD
  };
}

function buildFenicsLoadPoints(
  width: number,
  height: number,
  wall: number,
  requirements: StructuralBracketRequirements
): Array<[number, number]> {
  const topY = height / 2 - Math.max(wall * 2.4, height * 0.08);
  const spread = requirements.loadCase.direction === "lateral" ? height * 0.22 : width * 0.18;

  if (requirements.loadCase.direction === "lateral") {
    return [
      [width * 0.38, height * 0.18],
      [width * 0.38, -height * 0.18]
    ];
  }

  if (requirements.loadCase.direction === "multi-axis") {
    return [
      [0, topY],
      [-spread, topY - height * 0.07],
      [spread, topY - height * 0.07]
    ];
  }

  return [
    [0, topY],
    [-spread, topY],
    [spread, topY]
  ];
}

function addFenicsOrganicSkeleton(
  mesh: MeshBuilder,
  args: {
    width: number;
    height: number;
    depth: number;
    wall: number;
    density: number[][][];
    field: TopologyField;
    candidate: CandidateGeometry;
    requirements: StructuralBracketRequirements;
  }
) {
  const { width, height, depth, wall, density, field, candidate, requirements } = args;

  const boltPositions = field.boltPositions;
  const loadPoints = field.loadPoints;
  const loadCenter = averagePoints(loadPoints);
  const boltCenter = averagePoints(boltPositions);
  const loadScale = clamp(requirements.loadCase.forceN / 2500, 0.72, 1.55);
  const vibrationScale = clamp((requirements.loadCase.vibrationHz ?? 0) / 150, 0, 1.25);
  const baseThickness = Math.max(wall * 1.05, Math.min(width, height) * 0.042) * loadScale;
  const memberDepth = depth * 0.82;
  const z = -memberDepth / 2;

  const coreNode: [number, number] = [
    clamp((loadCenter[0] + boltCenter[0]) / 2, -width * 0.18, width * 0.18),
    clamp((loadCenter[1] + boltCenter[1]) / 2, -height * 0.14, height * 0.22)
  ];

  const upperNode: [number, number] = [
    clamp(loadCenter[0], -width * 0.16, width * 0.16),
    clamp(height * 0.22, -height * 0.05, height * 0.34)
  ];

  const coreDensity = sampleFenicsDensity(density, coreNode[0], coreNode[1], 0, width, height).normalized;
  const upperDensity = sampleFenicsDensity(density, upperNode[0], upperNode[1], 0, width, height).normalized;

  addSolidNodePad(mesh, {
    id: "fenics-core-load-node",
    group: "rib",
    center: [coreNode[0], coreNode[1], 0],
    radius: baseThickness * (0.9 + coreDensity * 0.65),
    depth: memberDepth,
    segments: 28,
    shade: 0.72
  });

  addSolidNodePad(mesh, {
    id: "fenics-upper-load-node",
    group: "load-plate",
    center: [upperNode[0], upperNode[1], 0],
    radius: baseThickness * (0.72 + upperDensity * 0.54),
    depth: memberDepth,
    segments: 28,
    shade: 0.78
  });

  boltPositions.forEach((bolt, index) => {
    const start = offsetPointAlongSegment(bolt, coreNode, field.boltPadRadius * 0.68);
    const side = bolt[0] < 0 ? -1 : 1;
    const bow = requirements.loadCase.direction === "vertical"
      ? [side * width * 0.05, height * 0.055] as [number, number]
      : [width * 0.055, side * height * 0.05] as [number, number];

    addDensityGuidedOrganicPath(mesh, {
      id: `fenics-bolt-${index + 1}-to-core`,
      group: "diagonal-web",
      from: start,
      to: coreNode,
      control: [
        (start[0] + coreNode[0]) / 2 + bow[0],
        (start[1] + coreNode[1]) / 2 + bow[1]
      ],
      z,
      depth: memberDepth,
      baseThickness,
      density,
      width,
      height,
      shade: 0.66
    });
  });

  addDensityGuidedOrganicPath(mesh, {
    id: "fenics-core-to-upper-load",
    group: "diagonal-web",
    from: coreNode,
    to: upperNode,
    control: [
      (coreNode[0] + upperNode[0]) / 2,
      Math.max(coreNode[1], upperNode[1]) + height * 0.035
    ],
    z,
    depth: memberDepth,
    baseThickness: baseThickness * 0.92,
    density,
    width,
    height,
    shade: 0.7
  });

  loadPoints.forEach((loadPoint, index) => {
    const end = offsetPointAlongSegment(loadPoint, upperNode, Math.max(wall * 1.7, baseThickness * 0.65));

    addDensityGuidedOrganicPath(mesh, {
      id: `fenics-upper-node-to-load-${index + 1}`,
      group: "gusset",
      from: upperNode,
      to: end,
      control: [
        (upperNode[0] + end[0]) / 2,
        (upperNode[1] + end[1]) / 2 + height * 0.018
      ],
      z,
      depth: memberDepth * 0.92,
      baseThickness: baseThickness * 0.62,
      density,
      width,
      height,
      shade: 0.62
    });
  });

  if (boltPositions.length >= 2) {
    for (let index = 0; index < boltPositions.length - 1; index += 1) {
      const a = offsetPointAlongSegment(boltPositions[index], boltPositions[index + 1], field.boltPadRadius * 0.64);
      const b = offsetPointAlongSegment(boltPositions[index + 1], boltPositions[index], field.boltPadRadius * 0.64);

      addDensityGuidedOrganicPath(mesh, {
        id: `fenics-bolt-tension-tie-${index + 1}`,
        group: "gusset",
        from: a,
        to: b,
        control: [(a[0] + b[0]) / 2, Math.min(a[1], b[1]) - height * 0.035],
        z,
        depth: memberDepth * 0.74,
        baseThickness: baseThickness * 0.48,
        density,
        width,
        height,
        shade: 0.54
      });
    }
  }

  if (vibrationScale > 0.15) {
    const stabilizerThickness = baseThickness * (0.34 + vibrationScale * 0.18);
    const leftAnchor: [number, number] = [-width * 0.28, coreNode[1] - height * 0.06];
    const rightAnchor: [number, number] = [width * 0.28, coreNode[1] + height * 0.045];

    addDensityGuidedOrganicPath(mesh, {
      id: "fenics-vibration-stabilizer",
      group: "rib",
      from: leftAnchor,
      to: rightAnchor,
      control: [0, coreNode[1] + height * 0.02],
      z,
      depth: memberDepth * 0.56,
      baseThickness: stabilizerThickness,
      density,
      width,
      height,
      shade: 0.5
    });
  }

  if (requirements.objectives.priority !== "lightweight") {
    const sideDensityLeft = sampleFenicsDensity(density, -width * 0.33, coreNode[1], 0, width, height).normalized;
    const sideDensityRight = sampleFenicsDensity(density, width * 0.33, coreNode[1], 0, width, height).normalized;

    for (const [side, sideDensity] of [[-1, sideDensityLeft], [1, sideDensityRight]] as const) {
      if (sideDensity < FENICS_DENSITY_THRESHOLD * 0.65) continue;

      const sideNode: [number, number] = [side * width * 0.34, coreNode[1]];
      addDensityGuidedOrganicPath(mesh, {
        id: `fenics-side-stability-path-${side < 0 ? "left" : "right"}`,
        group: "rib",
        from: coreNode,
        to: sideNode,
        control: [
          (coreNode[0] + sideNode[0]) / 2,
          coreNode[1] + side * height * 0.02
        ],
        z,
        depth: memberDepth * 0.62,
        baseThickness: baseThickness * 0.38,
        density,
        width,
        height,
        shade: 0.48
      });
    }
  }
}

function addDensityGuidedOrganicPath(
  mesh: MeshBuilder,
  options: {
    id: string;
    group: "gusset" | "diagonal-web" | "rib";
    from: [number, number];
    to: [number, number];
    control: [number, number];
    z: number;
    depth: number;
    baseThickness: number;
    density: number[][][];
    width: number;
    height: number;
    shade: number;
  }
) {
  const segments = 5;
  let previous = options.from;

  for (let index = 1; index <= segments; index += 1) {
    const t = index / segments;
    const point = quadraticPoint(options.from, options.control, options.to, t);
    const mid = [(previous[0] + point[0]) / 2, (previous[1] + point[1]) / 2] as [number, number];
    const sample = sampleFenicsDensity(options.density, mid[0], mid[1], 0, options.width, options.height);
    const thickness = options.baseThickness * clamp(0.72 + sample.normalized * 0.72, 0.62, 1.58);

    addOrientedWebFeature(mesh, {
      id: `${options.id}-segment-${index}`,
      group: options.group === "rib" ? "gusset" : options.group,
      start: [previous[0], previous[1], options.z],
      end: [point[0], point[1], options.z],
      thickness,
      depth: options.depth,
      shade: options.shade + sample.normalized * 0.12
    });

    previous = point;
  }
}

function quadraticPoint(
  from: [number, number],
  control: [number, number],
  to: [number, number],
  t: number
): [number, number] {
  const omt = 1 - t;
  return [
    omt * omt * from[0] + 2 * omt * t * control[0] + t * t * to[0],
    omt * omt * from[1] + 2 * omt * t * control[1] + t * t * to[1]
  ];
}

function sampleFenicsDensity(
  density: number[][][],
  xMm: number,
  yMm: number,
  zMm: number,
  widthMm: number,
  heightMm: number
): FenicsDensitySample {
  const nx = density.length;
  const ny = density[0]?.length ?? 1;
  const nz = density[0]?.[0]?.length ?? 1;

  const xIndex = clamp(Math.round(((xMm + widthMm / 2) / Math.max(widthMm, 1)) * (nx - 1)), 0, nx - 1);
  const yIndex = clamp(Math.round(((yMm + heightMm / 2) / Math.max(heightMm, 1)) * (ny - 1)), 0, ny - 1);
  const zIndex = clamp(Math.round(((zMm + 0.5) / 1) * (nz - 1)), 0, nz - 1);

  const raw = density[xIndex]?.[yIndex]?.[zIndex] ?? 0;
  const value = typeof raw === "number" && Number.isFinite(raw) ? raw : 0;

  return {
    value,
    normalized: clamp(value, 0, 1)
  };
}

function summarizeDensity(density: number[][][]) {
  let sum = 0;
  let count = 0;
  let solid = 0;

  for (const plane of density) {
    for (const row of plane) {
      for (const value of row) {
        const normalized = typeof value === "number" && Number.isFinite(value) ? clamp(value, 0, 1) : 0;
        sum += normalized;
        count += 1;
        if (normalized >= FENICS_DENSITY_THRESHOLD) {
          solid += 1;
        }
      }
    }
  }

  return {
    average: count > 0 ? sum / count : 0,
    solidFraction: count > 0 ? solid / count : 0
  };
}


type TopologyCell = {
  column: number;
  row: number;
  x: number;
  y: number;
  density: number;
  stress: number;
  group: string;
};

type TopologyField = {
  columns: number;
  rows: number;
  cellWidth: number;
  cellHeight: number;
  occupied: boolean[][];
  cells: TopologyCell[];
  boltPositions: Array<[number, number]>;
  boltHoleRadius: number;
  boltPadRadius: number;
  loadPoints: Array<[number, number]>;
  targetOpenAreaPercent: number;
  actualOpenAreaPercent: number;
  threshold: number;
};

function buildTopologyOptimizedStructuralMesh(
  candidate: CandidateGeometry,
  requirements: StructuralBracketRequirements
): RenderableMesh {
  const mesh = createMeshBuilder();

  const width = candidate.widthMm;
  const height = candidate.heightMm;
  const depth = candidate.depthMm;
  const wall = candidate.wallThicknessMm;

  const boltCount = clamp(Math.round(requirements.mounting.boltCount), 1, 12);
  const boltDiameterMm = Math.max(requirements.mounting.boltDiameterMm, wall * 0.9);
  const railHeight = Math.max(wall * 2.35, height * 0.12);
  const boltPositions = buildBoltPositions(width, height, railHeight, boltCount);

  const field = buildTopologyField({
    width,
    height,
    wall,
    boltPositions,
    boltDiameterMm,
    candidate,
    requirements
  });

  addPerimeterSkin(mesh, {
    width,
    height,
    depth,
    wall,
    field
  });

  addTopologySkeletonMembers(mesh, {
    width,
    height,
    depth,
    wall,
    field,
    candidate,
    requirements
  });

  addBoltHoleWallFeatures(mesh, {
    boltPositions,
    boltDiameterMm,
    depth,
    wall
  });

  addLoadInterfaceFeatures(mesh, {
    width,
    height,
    depth,
    wall,
    requirements
  });

  const actualOpenAreaPercent = roundTo(field.actualOpenAreaPercent, 0.1);
  const ribCount = numberParam(candidate, "ribCount", 4);
  const gussetCount = numberParam(candidate, "gussetCount", 4);
  const diagonalWebCount = numberParam(candidate, "diagonalWebCount", 6);
  const skeletonMembers = mesh.features.filter((feature) =>
    feature.type === "diagonal-web" || feature.type === "gusset" || feature.type === "rib"
  ).length;

  const renderMesh: RenderableMesh = {
    version: "haf-render-mesh-v1",
    units: "mm",
    family: candidate.family,
    vertices: mesh.vertices,
    faces: mesh.faces,
    features: mesh.features,
    bounds: {
      widthMm: width,
      heightMm: height,
      depthMm: depth
    },
    metadata: {
      candidateId: candidate.id,
      source: "generation-engine",
      boltCount,
      lighteningHoleCount: Math.max(0, Math.round((field.actualOpenAreaPercent / 100) * 12)),
      ribCount,
      gussetCount,
      diagonalWebCount,
      skeletonized: true
    }
  };

  candidate.derivedParameters.topologyCells = field.cells.length;
  candidate.derivedParameters.topologyGridColumns = field.columns;
  candidate.derivedParameters.topologyGridRows = field.rows;
  candidate.derivedParameters.topologyOpenAreaPercent = actualOpenAreaPercent;
  candidate.derivedParameters.topologyThreshold = roundTo(field.threshold, 0.001);
  candidate.derivedParameters.topologyMode = "skeleton-reconstructed-load-path";
  candidate.derivedParameters.topologySkeletonMembers = skeletonMembers;
  candidate.derivedParameters.topologyPostProcessing =
    "thresholded density field, connectivity-reinforced load paths, beam skeleton extraction, manufacturable member reconstruction";

  return renderMesh;
}

function buildTopologyField(args: {
  width: number;
  height: number;
  wall: number;
  boltPositions: Array<[number, number]>;
  boltDiameterMm: number;
  candidate: CandidateGeometry;
  requirements: StructuralBracketRequirements;
}): TopologyField {
  const { width, height, wall, boltPositions, boltDiameterMm, candidate, requirements } = args;

  const targetOpenAreaPercent = clamp(
    requirements.objectives.targetOpenAreaPercent ?? candidate.openAreaPercent ?? 48,
    35,
    80
  );

  const columns = clamp(Math.round(width / 2.4), 34, 76);
  const rows = clamp(Math.round(height / 2.4), 26, 58);
  const cellWidth = width / columns;
  const cellHeight = height / rows;

  const boltHoleRadius = Math.max(boltDiameterMm * 0.52, wall * 0.55);
  const boltPadRadius = Math.max(boltDiameterMm * 1.85, wall * 2.45);
  const edgeBand = Math.max(wall * 1.05, Math.min(width, height) * 0.035);
  const topLoadY = height / 2 - edgeBand * 1.1;

  const loadSpread = requirements.loadCase.direction === "lateral" ? width * 0.34 : width * 0.22;
  const loadPoints: Array<[number, number]> = requirements.loadCase.direction === "lateral"
    ? [[width * 0.38, height * 0.18], [width * 0.38, -height * 0.18]]
    : requirements.loadCase.direction === "multi-axis"
      ? [[0, topLoadY], [-loadSpread, topLoadY - height * 0.08], [loadSpread, topLoadY - height * 0.08]]
      : [[0, topLoadY]];

  const samples: Array<{
    column: number;
    row: number;
    x: number;
    y: number;
    density: number;
    stress: number;
    group: string;
    hardKeep: boolean;
    isVoid: boolean;
  }> = [];

  for (let row = 0; row < rows; row += 1) {
    const y = -height / 2 + (row + 0.5) * cellHeight;

    for (let column = 0; column < columns; column += 1) {
      const x = -width / 2 + (column + 0.5) * cellWidth;
      const field = evaluateTopologyDensity({
        x,
        y,
        width,
        height,
        wall,
        edgeBand,
        boltPositions,
        boltHoleRadius,
        boltPadRadius,
        loadPoints,
        requirements,
        candidate
      });

      samples.push({ column, row, x, y, ...field });
    }
  }

  const sorted = samples
    .filter((sample) => !sample.isVoid && !sample.hardKeep)
    .map((sample) => sample.density)
    .sort((a, b) => a - b);

  const removalFraction = targetOpenAreaPercent / 100;
  const thresholdIndex = clamp(Math.floor(sorted.length * removalFraction), 0, Math.max(sorted.length - 1, 0));
  const threshold = sorted[thresholdIndex] ?? 0.28;

  const occupied = Array.from({ length: rows }, () => Array.from({ length: columns }, () => false));
  const cells: TopologyCell[] = [];

  for (const sample of samples) {
    const keep = !sample.isVoid && (sample.hardKeep || sample.density >= threshold);
    occupied[sample.row][sample.column] = keep;

    if (keep) {
      cells.push({
        column: sample.column,
        row: sample.row,
        x: sample.x,
        y: sample.y,
        density: sample.density,
        stress: sample.stress,
        group: sample.group
      });
    }
  }

  reinforceConnectivity({
    occupied,
    samples,
    columns,
    rows,
    width,
    height,
    boltPositions,
    loadPoints
  });

  const finalCells: TopologyCell[] = [];

  for (const sample of samples) {
    if (!occupied[sample.row][sample.column]) continue;

    finalCells.push({
      column: sample.column,
      row: sample.row,
      x: sample.x,
      y: sample.y,
      density: sample.density,
      stress: sample.stress,
      group: sample.group
    });
  }

  const totalCells = columns * rows;
  const actualOpenAreaPercent = totalCells > 0
    ? ((totalCells - finalCells.length) / totalCells) * 100
    : 0;

  return {
    columns,
    rows,
    cellWidth,
    cellHeight,
    occupied,
    cells: finalCells,
    boltPositions,
    boltHoleRadius,
    boltPadRadius,
    loadPoints,
    targetOpenAreaPercent,
    actualOpenAreaPercent,
    threshold
  };
}

function evaluateTopologyDensity(args: {
  x: number;
  y: number;
  width: number;
  height: number;
  wall: number;
  edgeBand: number;
  boltPositions: Array<[number, number]>;
  boltHoleRadius: number;
  boltPadRadius: number;
  loadPoints: Array<[number, number]>;
  requirements: StructuralBracketRequirements;
  candidate: CandidateGeometry;
}): {
  density: number;
  stress: number;
  group: string;
  hardKeep: boolean;
  isVoid: boolean;
} {
  const {
    x,
    y,
    width,
    height,
    wall,
    edgeBand,
    boltPositions,
    boltHoleRadius,
    boltPadRadius,
    loadPoints,
    requirements,
    candidate
  } = args;

  const distanceToOuterEdge = Math.min(
    x + width / 2,
    width / 2 - x,
    y + height / 2,
    height / 2 - y
  );

  const insideBoltVoid = boltPositions.some(([bx, by]) => distance2d(x, y, bx, by) < boltHoleRadius);

  if (insideBoltVoid) {
    return {
      density: 0,
      stress: 0,
      group: "through-hole-void",
      hardKeep: false,
      isVoid: true
    };
  }

  let density = 0;
  let stress = 0;
  let group = "topology-web";
  let hardKeep = false;

  const edgeDensity = smoothBand(distanceToOuterEdge, edgeBand * 0.15, edgeBand * 1.25);

  if (edgeDensity > 0.12) {
    density = Math.max(density, 0.36 + edgeDensity * 0.44);
    group = "perimeter-load-frame";
  }

  for (const [bx, by] of boltPositions) {
    const distanceToBolt = distance2d(x, y, bx, by);
    const padDensity = annularBand(distanceToBolt, boltHoleRadius, boltPadRadius);

    if (padDensity > 0.03) {
      density = Math.max(density, 0.48 + padDensity * 0.5);
      stress = Math.max(stress, 0.58 + padDensity * 0.34);
      group = "bolt-load-pad";
    }

    if (distanceToBolt < boltPadRadius * 1.08) {
      hardKeep = true;
    }
  }

  for (const loadPoint of loadPoints) {
    const distanceToLoad = distance2d(x, y, loadPoint[0], loadPoint[1]);
    const loadPadDensity = gaussian(distanceToLoad, Math.max(wall * 3.2, width * 0.055));

    if (loadPadDensity > 0.05) {
      density = Math.max(density, 0.42 + loadPadDensity * 0.48);
      stress = Math.max(stress, 0.62 + loadPadDensity * 0.3);
      group = "load-interface";
    }
  }

  const pathWidth = Math.max(wall * 1.75, Math.min(width, height) * 0.045);
  const secondaryPathWidth = Math.max(wall * 1.15, Math.min(width, height) * 0.032);

  for (const bolt of boltPositions) {
    for (const loadPoint of loadPoints) {
      const distanceToPath = distancePointToSegment(x, y, bolt[0], bolt[1], loadPoint[0], loadPoint[1]);
      const loadPathDensity = gaussian(distanceToPath, pathWidth);

      if (loadPathDensity > 0.035) {
        const pathStress = loadPathDensity * pathLoadBias(x, y, bolt, loadPoint, requirements.loadCase.direction);
        density = Math.max(density, 0.2 + loadPathDensity * 0.8);
        stress = Math.max(stress, pathStress);
        group = "primary-load-path";
      }
    }
  }

  const diagonalWebCount = numberParam(candidate, "diagonalWebCount", 6);
  const webInfluence = clamp(diagonalWebCount / 10, 0.2, 1.1);

  if (boltPositions.length >= 2) {
    for (let index = 0; index < boltPositions.length - 1; index += 1) {
      const a = boltPositions[index];
      const b = boltPositions[index + 1];

      for (const loadPoint of loadPoints) {
        const midX = (a[0] + b[0] + loadPoint[0]) / 3;
        const midY = (a[1] + b[1] + loadPoint[1]) / 3;
        const d1 = distancePointToSegment(x, y, a[0], a[1], midX, midY);
        const d2 = distancePointToSegment(x, y, b[0], b[1], midX, midY);
        const d3 = distancePointToSegment(x, y, midX, midY, loadPoint[0], loadPoint[1]);
        const trussDensity = Math.max(
          gaussian(d1, secondaryPathWidth),
          gaussian(d2, secondaryPathWidth),
          gaussian(d3, secondaryPathWidth)
        ) * webInfluence;

        if (trussDensity > 0.04) {
          density = Math.max(density, 0.16 + trussDensity * 0.68);
          stress = Math.max(stress, trussDensity * 0.78);
          group = "branching-truss-web";
        }
      }
    }
  }

  const vibrationHz = requirements.loadCase.vibrationHz ?? 0;
  const vibrationBrace = vibrationHz > 0
    ? Math.max(
        gaussian(Math.abs(y), Math.max(wall * 2.4, height * 0.055)),
        gaussian(Math.abs(x), Math.max(wall * 2.2, width * 0.045)) * 0.65
      ) * clamp(vibrationHz / 150, 0.1, 1)
    : 0;

  if (vibrationBrace > 0.08) {
    density = Math.max(density, 0.16 + vibrationBrace * 0.44);
    stress = Math.max(stress, vibrationBrace * 0.45);
    group = "vibration-stabilizer";
  }

  const materialNoise = deterministicNoise(x, y, candidate.id) * 0.075;
  density = clamp(density + materialNoise, 0, 1.4);
  stress = clamp(stress + density * 0.18, 0, 1.25);

  return {
    density,
    stress,
    group,
    hardKeep,
    isVoid: false
  };
}

function reinforceConnectivity(args: {
  occupied: boolean[][];
  samples: Array<{
    column: number;
    row: number;
    x: number;
    y: number;
    density: number;
    stress: number;
    group: string;
    hardKeep: boolean;
    isVoid: boolean;
  }>;
  columns: number;
  rows: number;
  width: number;
  height: number;
  boltPositions: Array<[number, number]>;
  loadPoints: Array<[number, number]>;
}) {
  const { occupied, samples, columns, rows, width, height, boltPositions, loadPoints } = args;

  const sampleMap = new Map<string, (typeof samples)[number]>();
  for (const sample of samples) {
    sampleMap.set(`${sample.column}:${sample.row}`, sample);
  }

  const toGrid = (point: [number, number]) => ({
    column: clamp(Math.floor(((point[0] + width / 2) / width) * columns), 0, columns - 1),
    row: clamp(Math.floor(((point[1] + height / 2) / height) * rows), 0, rows - 1)
  });

  const drawGridLine = (from: [number, number], to: [number, number], radiusCells: number) => {
    const a = toGrid(from);
    const b = toGrid(to);
    const steps = Math.max(Math.abs(b.column - a.column), Math.abs(b.row - a.row), 1);

    for (let step = 0; step <= steps; step += 1) {
      const t = step / steps;
      const column = Math.round(lerp(a.column, b.column, t));
      const row = Math.round(lerp(a.row, b.row, t));

      for (let dy = -radiusCells; dy <= radiusCells; dy += 1) {
        for (let dx = -radiusCells; dx <= radiusCells; dx += 1) {
          if (dx * dx + dy * dy > radiusCells * radiusCells) continue;
          const c = column + dx;
          const r = row + dy;
          if (c < 0 || c >= columns || r < 0 || r >= rows) continue;
          const sample = sampleMap.get(`${c}:${r}`);
          if (sample?.isVoid) continue;
          occupied[r][c] = true;
        }
      }
    }
  };

  for (const bolt of boltPositions) {
    for (const loadPoint of loadPoints) {
      drawGridLine(bolt, loadPoint, 0);
    }
  }

  if (boltPositions.length > 1) {
    for (let index = 0; index < boltPositions.length - 1; index += 1) {
      drawGridLine(boltPositions[index], boltPositions[index + 1], 0);
    }
  }
}


function addTopologySkeletonMembers(
  mesh: MeshBuilder,
  args: {
    width: number;
    height: number;
    depth: number;
    wall: number;
    field: TopologyField;
    candidate: CandidateGeometry;
    requirements: StructuralBracketRequirements;
  }
) {
  const { width, height, depth, wall, field, candidate, requirements } = args;
  const boltPositions = field.boltPositions;
  const topologyMode = String(candidate.derivedParameters.topologyMode ?? "direct-load-path") as StructuralTopologyMode;

  if (boltPositions.length === 2) {
    addTwoBoltOptimizedSkeleton(mesh, {
      width,
      height,
      depth,
      wall,
      field,
      candidate,
      requirements,
      topologyMode
    });
    return;
  }

  addGeneralBoltOptimizedSkeleton(mesh, {
    width,
    height,
    depth,
    wall,
    field,
    candidate,
    requirements,
    topologyMode
  });
}

function addTwoBoltOptimizedSkeleton(
  mesh: MeshBuilder,
  args: {
    width: number;
    height: number;
    depth: number;
    wall: number;
    field: TopologyField;
    candidate: CandidateGeometry;
    requirements: StructuralBracketRequirements;
    topologyMode: StructuralTopologyMode;
  }
) {
  const { width, height, depth, wall, field, candidate, requirements, topologyMode } = args;
  const [leftBolt, rightBolt] = field.boltPositions[0][0] <= field.boltPositions[1][0]
    ? field.boltPositions
    : [field.boltPositions[1], field.boltPositions[0]];

  const loadCenter = averagePoints(field.loadPoints);
  const boltCenter = averagePoints([leftBolt, rightBolt]);
  const loadScale = clamp(requirements.loadCase.forceN / 2500, 0.78, 1.55);
  const vibrationScale = clamp((requirements.loadCase.vibrationHz ?? 0) / 160, 0, 1.25);
  const targetOpenArea = clamp(requirements.objectives.targetOpenAreaPercent ?? candidate.openAreaPercent ?? 52, 35, 80);
  const memberDepth = depth * 0.88;
  const frontZ = -memberDepth / 2;

  const mainThickness = Math.max(wall * 1.2, Math.min(width, height) * 0.052) * loadScale;
  const tieThickness = Math.max(wall * 0.78, Math.min(width, height) * 0.026) * (1 + vibrationScale * 0.15);
  const nodeRadius = Math.max(mainThickness * 1.05, wall * 1.55);
  const boltPadOffset = Math.max(field.boltPadRadius * 0.72, wall * 2.2);

  const apexY = requirements.loadCase.direction === "lateral"
    ? clamp(loadCenter[1], -height * 0.18, height * 0.3)
    : clamp(height * 0.22, height * 0.06, height * 0.33);
  const apexX = requirements.loadCase.direction === "lateral"
    ? clamp(width * 0.23, -width * 0.1, width * 0.34)
    : clamp(loadCenter[0], -width * 0.12, width * 0.12);
  const apex: [number, number] = [apexX, apexY];

  const lowerNodeY = clamp(boltCenter[1] + height * 0.08, -height * 0.32, height * 0.02);
  const lowerNode: [number, number] = [boltCenter[0], lowerNodeY];

  addSolidNodePad(mesh, {
    id: "optimized-apex-load-node",
    group: "load-plate",
    center: [apex[0], apex[1], 0],
    radius: nodeRadius,
    depth: memberDepth,
    segments: 28,
    shade: 0.78
  });

  addSolidNodePad(mesh, {
    id: "optimized-bolt-bridge-node",
    group: "mounting-plate",
    center: [lowerNode[0], lowerNode[1], 0],
    radius: Math.max(tieThickness * 1.25, wall * 1.1),
    depth: memberDepth * 0.84,
    segments: 24,
    shade: 0.64
  });

  const leftStart = offsetPointAlongSegment(leftBolt, apex, boltPadOffset);
  const rightStart = offsetPointAlongSegment(rightBolt, apex, boltPadOffset);
  const leftLower = offsetPointAlongSegment(leftBolt, lowerNode, boltPadOffset * 0.72);
  const rightLower = offsetPointAlongSegment(rightBolt, lowerNode, boltPadOffset * 0.72);

  addOrientedWebFeature(mesh, {
    id: "primary-load-member-left-bolt-to-apex",
    group: "diagonal-web",
    start: [leftStart[0], leftStart[1], frontZ],
    end: [apex[0], apex[1], frontZ],
    thickness: mainThickness,
    depth: memberDepth,
    shade: 0.74
  });

  addOrientedWebFeature(mesh, {
    id: "primary-load-member-right-bolt-to-apex",
    group: "diagonal-web",
    start: [rightStart[0], rightStart[1], frontZ],
    end: [apex[0], apex[1], frontZ],
    thickness: mainThickness,
    depth: memberDepth,
    shade: 0.74
  });

  addOrientedWebFeature(mesh, {
    id: "bolt-to-bolt-tension-tie",
    group: "rib",
    start: [leftLower[0], leftLower[1], frontZ],
    end: [rightLower[0], rightLower[1], frontZ],
    thickness: tieThickness,
    depth: memberDepth * 0.78,
    shade: 0.58
  });

  for (let index = 0; index < field.loadPoints.length; index += 1) {
    const loadPoint = field.loadPoints[index];
    const end = offsetPointAlongSegment(loadPoint, apex, Math.max(wall * 1.6, mainThickness * 0.62));

    addOrientedWebFeature(mesh, {
      id: `apex-to-load-interface-${index + 1}`,
      group: "gusset",
      start: [apex[0], apex[1], frontZ],
      end: [end[0], end[1], frontZ],
      thickness: Math.max(tieThickness * 1.05, wall * 0.9),
      depth: memberDepth * 0.82,
      shade: 0.68
    });
  }

  if (topologyMode === "split-y-truss" || topologyMode === "vibration-stabilized" || vibrationScale > 0.55) {
    const braceNode: [number, number] = [
      clamp((apex[0] + lowerNode[0]) / 2, -width * 0.16, width * 0.16),
      clamp((apex[1] + lowerNode[1]) / 2, -height * 0.1, height * 0.16)
    ];

    addSolidNodePad(mesh, {
      id: "secondary-shear-node",
      group: "rib",
      center: [braceNode[0], braceNode[1], 0],
      radius: Math.max(tieThickness * 1.1, wall),
      depth: memberDepth * 0.72,
      segments: 20,
      shade: 0.6
    });

    addOrientedWebFeature(mesh, {
      id: "left-shear-brace",
      group: "gusset",
      start: [leftStart[0], leftStart[1], frontZ],
      end: [braceNode[0], braceNode[1], frontZ],
      thickness: tieThickness * 0.82,
      depth: memberDepth * 0.66,
      shade: 0.52
    });

    addOrientedWebFeature(mesh, {
      id: "right-shear-brace",
      group: "gusset",
      start: [rightStart[0], rightStart[1], frontZ],
      end: [braceNode[0], braceNode[1], frontZ],
      thickness: tieThickness * 0.82,
      depth: memberDepth * 0.66,
      shade: 0.52
    });
  }

  if (topologyMode === "arched-bridge") {
    const crown: [number, number] = [apex[0], clamp(apex[1] - height * 0.08, -height * 0.02, height * 0.2)];
    addOrientedWebFeature(mesh, {
      id: "arched-compression-bridge-left",
      group: "diagonal-web",
      start: [leftStart[0], leftStart[1], frontZ],
      end: [crown[0], crown[1], frontZ],
      thickness: Math.max(tieThickness * 0.95, wall * 0.8),
      depth: memberDepth * 0.72,
      shade: 0.55
    });
    addOrientedWebFeature(mesh, {
      id: "arched-compression-bridge-right",
      group: "diagonal-web",
      start: [rightStart[0], rightStart[1], frontZ],
      end: [crown[0], crown[1], frontZ],
      thickness: Math.max(tieThickness * 0.95, wall * 0.8),
      depth: memberDepth * 0.72,
      shade: 0.55
    });
  }

  candidate.derivedParameters.optimizationSummary = {
    selectedArchitecture: topologyMode,
    boltConstraint: "two-bolt load path",
    primaryMembers: 2,
    auxiliaryMembers:
      topologyMode === "direct-load-path"
        ? 1
        : topologyMode === "arched-bridge"
          ? 3
          : 4,
    targetOpenAreaPercent: roundTo(targetOpenArea, 0.1),
    sizingBasis: "required load, vibration, wall minimum, bolt pad radius"
  };
}

function addGeneralBoltOptimizedSkeleton(
  mesh: MeshBuilder,
  args: {
    width: number;
    height: number;
    depth: number;
    wall: number;
    field: TopologyField;
    candidate: CandidateGeometry;
    requirements: StructuralBracketRequirements;
    topologyMode: StructuralTopologyMode;
  }
) {
  const { width, height, depth, wall, field, candidate, requirements, topologyMode } = args;
  const boltPositions = field.boltPositions;
  const loadPoints = field.loadPoints;
  const loadCenter = averagePoints(loadPoints);
  const boltCenter = averagePoints(boltPositions);

  const loadScale = clamp(requirements.loadCase.forceN / 2500, 0.78, 1.5);
  const vibrationScale = clamp((requirements.loadCase.vibrationHz ?? 0) / 160, 0, 1.15);
  const memberDepth = depth * 0.88;
  const frontZ = -memberDepth / 2;
  const mainThickness = Math.max(wall * 1.18, Math.min(width, height) * 0.048) * loadScale;
  const secondaryThickness = Math.max(wall * 0.76, Math.min(width, height) * 0.028) * (1 + vibrationScale * 0.15);

  const hub: [number, number] = [
    clamp((loadCenter[0] + boltCenter[0]) / 2, -width * 0.2, width * 0.2),
    clamp((loadCenter[1] + boltCenter[1]) / 2, -height * 0.12, height * 0.24)
  ];

  addSolidNodePad(mesh, {
    id: "optimized-central-load-hub",
    group: "rib",
    center: [hub[0], hub[1], 0],
    radius: mainThickness,
    depth: memberDepth,
    segments: 26,
    shade: 0.72
  });

  boltPositions.forEach((bolt, index) => {
    const start = offsetPointAlongSegment(bolt, hub, field.boltPadRadius * 0.7);
    addOrientedWebFeature(mesh, {
      id: `bolt-${index + 1}-to-load-hub`,
      group: "diagonal-web",
      start: [start[0], start[1], frontZ],
      end: [hub[0], hub[1], frontZ],
      thickness: mainThickness * (boltPositions.length > 4 ? 0.78 : 0.92),
      depth: memberDepth,
      shade: 0.7
    });
  });

  loadPoints.forEach((loadPoint, index) => {
    const end = offsetPointAlongSegment(loadPoint, hub, Math.max(wall * 1.6, mainThickness * 0.7));
    addOrientedWebFeature(mesh, {
      id: `hub-to-load-${index + 1}`,
      group: "gusset",
      start: [hub[0], hub[1], frontZ],
      end: [end[0], end[1], frontZ],
      thickness: secondaryThickness * 1.08,
      depth: memberDepth * 0.82,
      shade: 0.66
    });
  });

  if (topologyMode === "vibration-stabilized" || vibrationScale > 0.45) {
    addOrientedWebFeature(mesh, {
      id: "single-vibration-tie",
      group: "rib",
      start: [-width * 0.28, hub[1] - height * 0.07, frontZ],
      end: [width * 0.28, hub[1] + height * 0.06, frontZ],
      thickness: secondaryThickness * 0.78,
      depth: memberDepth * 0.62,
      shade: 0.52
    });
  }

  candidate.derivedParameters.optimizationSummary = {
    selectedArchitecture: topologyMode,
    boltConstraint: `${boltPositions.length}-bolt load path`,
    primaryMembers: boltPositions.length,
    auxiliaryMembers: loadPoints.length + (topologyMode === "vibration-stabilized" ? 1 : 0),
    sizingBasis: "required load, vibration, wall minimum, bolt pad radius"
  };
}
function addSolidNodePad(
  mesh: MeshBuilder,
  options: {
    id: string;
    group: "rib" | "gusset" | "diagonal-web" | "mounting-plate" | "load-plate";
    center: Vec3;
    radius: number;
    depth: number;
    segments: number;
    shade: number;
  }
) {
  const start = mesh.vertices.length;
  const z0 = options.center[2] - options.depth / 2;
  const z1 = options.center[2] + options.depth / 2;

  for (const z of [z0, z1]) {
    mesh.vertices.push([options.center[0], options.center[1], z]);
    for (let index = 0; index < options.segments; index += 1) {
      const angle = (Math.PI * 2 * index) / options.segments;
      mesh.vertices.push([
        options.center[0] + Math.cos(angle) * options.radius,
        options.center[1] + Math.sin(angle) * options.radius,
        z
      ]);
    }
  }

  const backCenter = start;
  const backRing = start + 1;
  const frontCenter = start + 1 + options.segments;
  const frontRing = frontCenter + 1;

  for (let index = 0; index < options.segments; index += 1) {
    const next = (index + 1) % options.segments;

    mesh.faces.push({
      indices: [frontCenter, frontRing + index, frontRing + next],
      group: options.group,
      shade: options.shade * 1.06
    });

    mesh.faces.push({
      indices: [backCenter, backRing + next, backRing + index],
      group: options.group,
      shade: options.shade * 0.76
    });

    mesh.faces.push({
      indices: [backRing + index, backRing + next, frontRing + next, frontRing + index],
      group: options.group,
      shade: options.shade * 0.86
    });
  }

  mesh.features.push({
    type: options.group,
    id: options.id,
    center: options.center,
    diameterMm: options.radius * 2,
    throughAxis: "z"
  });
}

function averagePoints(points: Array<[number, number]>): [number, number] {
  if (!points.length) return [0, 0];

  const sum = points.reduce(
    (current, point) => [current[0] + point[0], current[1] + point[1]] as [number, number],
    [0, 0] as [number, number]
  );

  return [sum[0] / points.length, sum[1] / points.length];
}

function offsetPointAlongSegment(
  from: [number, number],
  to: [number, number],
  distance: number
): [number, number] {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const length = Math.max(Math.hypot(dx, dy), 0.0001);
  const t = clamp(distance / length, 0, 0.85);

  return [from[0] + dx * t, from[1] + dy * t];
}

function addTopologyCell(
  mesh: MeshBuilder,
  options: {
    id: string;
    group: string;
    center: Vec3;
    size: Vec3;
    density: number;
    stress: number;
  }
) {
  const [cx, cy, cz] = options.center;
  const [sx, sy, sz] = options.size;
  const min: Vec3 = [cx - sx / 2, cy - sy / 2, cz - sz / 2];
  const max: Vec3 = [cx + sx / 2, cy + sy / 2, cz + sz / 2];
  const start = mesh.vertices.length;
  const shade = clamp(0.38 + options.density * 0.42 + options.stress * 0.16, 0.34, 1.08);

  mesh.vertices.push(
    [min[0], min[1], min[2]],
    [max[0], min[1], min[2]],
    [max[0], max[1], min[2]],
    [min[0], max[1], min[2]],
    [min[0], min[1], max[2]],
    [max[0], min[1], max[2]],
    [max[0], max[1], max[2]],
    [min[0], max[1], max[2]]
  );

  mesh.faces.push(
    { indices: [start + 0, start + 1, start + 2, start + 3], group: options.group, shade: shade * 0.74 },
    { indices: [start + 4, start + 7, start + 6, start + 5], group: options.group, shade: shade * 1.08 },
    { indices: [start + 0, start + 4, start + 5, start + 1], group: options.group, shade: shade * 0.92 },
    { indices: [start + 1, start + 5, start + 6, start + 2], group: options.group, shade: shade * 0.98 },
    { indices: [start + 2, start + 6, start + 7, start + 3], group: options.group, shade: shade * 1.02 },
    { indices: [start + 3, start + 7, start + 4, start + 0], group: options.group, shade: shade * 0.84 }
  );
}

function addPerimeterSkin(
  mesh: MeshBuilder,
  args: {
    width: number;
    height: number;
    depth: number;
    wall: number;
    field: TopologyField;
  }
) {
  const { width, height, depth, wall, field } = args;
  const skinThickness = Math.max(wall * 0.8, Math.min(width, height) * 0.026);
  const shade = 0.55;

  const bars: Array<{ id: string; min: Vec3; max: Vec3 }> = [
    {
      id: "top-load-skin",
      min: [-width / 2, height / 2 - skinThickness, -depth / 2],
      max: [width / 2, height / 2, depth / 2]
    },
    {
      id: "bottom-mounting-skin",
      min: [-width / 2, -height / 2, -depth / 2],
      max: [width / 2, -height / 2 + skinThickness, depth / 2]
    },
    {
      id: "left-side-skin",
      min: [-width / 2, -height / 2, -depth / 2],
      max: [-width / 2 + skinThickness, height / 2, depth / 2]
    },
    {
      id: "right-side-skin",
      min: [width / 2 - skinThickness, -height / 2, -depth / 2],
      max: [width / 2, height / 2, depth / 2]
    }
  ];

  for (const bar of bars) {
    addBoxFeature(mesh, {
      id: bar.id,
      group: bar.id.includes("top") ? "load-plate" : bar.id.includes("bottom") ? "mounting-plate" : "rib",
      min: bar.min,
      max: bar.max,
      shade
    });
  }

  mesh.features.push({
    type: "load-plate",
    id: "topology-field",
    center: [0, 0, 0],
    size: [width, height, depth],
    rotationDeg: roundTo(field.threshold * 100, 0.1)
  });
}

function addBoltHoleWallFeatures(
  mesh: MeshBuilder,
  args: {
    boltPositions: Array<[number, number]>;
    boltDiameterMm: number;
    depth: number;
    wall: number;
  }
) {
  const { boltPositions, boltDiameterMm, depth, wall } = args;
  const holeRadius = Math.max(boltDiameterMm * 0.52, wall * 0.55);
  const wallRadius = Math.max(boltDiameterMm * 1.05, wall * 1.35);

  boltPositions.forEach(([x, y], index) => {
    addOpenCylinderWall(mesh, {
      id: `bolt-hole-${index + 1}`,
      group: "bolt-hole-wall",
      type: "bolt-hole",
      center: [x, y, 0],
      innerRadius: holeRadius,
      outerRadius: wallRadius,
      depth,
      segments: 32,
      shade: 0.76
    });
  });
}

function addLoadInterfaceFeatures(
  mesh: MeshBuilder,
  args: {
    width: number;
    height: number;
    depth: number;
    wall: number;
    requirements: StructuralBracketRequirements;
  }
) {
  const { width, height, depth, wall, requirements } = args;
  const loadPadWidth = requirements.loadCase.direction === "lateral" ? width * 0.24 : width * 0.42;
  const loadPadHeight = Math.max(wall * 2.2, height * 0.08);

  addBoxFeature(mesh, {
    id: "derived-load-interface-pad",
    group: "load-plate",
    min: [-loadPadWidth / 2, height / 2 - loadPadHeight * 1.25, -depth / 2],
    max: [loadPadWidth / 2, height / 2 - loadPadHeight * 0.15, depth / 2],
    shade: 0.82
  });
}

function addOpenCylinderWall(
  mesh: MeshBuilder,
  options: {
    id: string;
    type: "bolt-hole" | "lightening-hole";
    group: string;
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
        mesh.vertices.push([
          options.center[0] + Math.cos(angle) * radius,
          options.center[1] + Math.sin(angle) * radius,
          z
        ]);
      }
    }
  }

  const backOuter = start;
  const backInner = start + options.segments;
  const frontOuter = start + options.segments * 2;
  const frontInner = start + options.segments * 3;

  for (let index = 0; index < options.segments; index += 1) {
    const next = (index + 1) % options.segments;

    mesh.faces.push({
      indices: [backOuter + index, backOuter + next, frontOuter + next, frontOuter + index],
      group: options.group,
      shade: options.shade * 0.82
    });

    mesh.faces.push({
      indices: [frontOuter + index, frontOuter + next, frontInner + next, frontInner + index],
      group: options.group,
      shade: options.shade * 1.12
    });

    mesh.faces.push({
      indices: [backInner + index, frontInner + index, frontInner + next, backInner + next],
      group: options.group,
      shade: options.shade * 0.42
    });
  }

  mesh.features.push({
    type: options.type,
    id: options.id,
    center: options.center,
    diameterMm: options.innerRadius * 2,
    throughAxis: "z"
  });
}

function distance2d(x0: number, y0: number, x1: number, y1: number) {
  return Math.hypot(x0 - x1, y0 - y1);
}

function distancePointToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const abx = bx - ax;
  const aby = by - ay;
  const apx = px - ax;
  const apy = py - ay;
  const lengthSquared = abx * abx + aby * aby;

  if (lengthSquared <= 1e-9) {
    return Math.hypot(px - ax, py - ay);
  }

  const t = clamp((apx * abx + apy * aby) / lengthSquared, 0, 1);
  const cx = ax + abx * t;
  const cy = ay + aby * t;

  return Math.hypot(px - cx, py - cy);
}

function gaussian(distance: number, sigma: number) {
  const safeSigma = Math.max(sigma, 0.0001);
  return Math.exp(-(distance * distance) / (2 * safeSigma * safeSigma));
}

function smoothBand(distance: number, inner: number, outer: number) {
  if (distance <= inner) return 1;
  if (distance >= outer) return 0;
  const t = (distance - inner) / Math.max(outer - inner, 0.0001);
  return 1 - t * t * (3 - 2 * t);
}

function annularBand(distance: number, innerRadius: number, outerRadius: number) {
  if (distance < innerRadius || distance > outerRadius) return 0;
  const mid = (innerRadius + outerRadius) / 2;
  const halfWidth = Math.max((outerRadius - innerRadius) / 2, 0.0001);
  return clamp(1 - Math.abs(distance - mid) / halfWidth, 0, 1);
}

function pathLoadBias(
  x: number,
  y: number,
  from: [number, number],
  to: [number, number],
  direction: StructuralBracketRequirements["loadCase"]["direction"]
) {
  const distanceFromAnchor = distance2d(x, y, from[0], from[1]);
  const distanceToLoad = distance2d(x, y, to[0], to[1]);
  const total = Math.max(distanceFromAnchor + distanceToLoad, 1);
  const axialBias = 1 - Math.abs(distanceFromAnchor - distanceToLoad) / total;

  if (direction === "lateral") return 0.78 + axialBias * 0.36;
  if (direction === "multi-axis") return 0.82 + axialBias * 0.42;
  return 0.86 + axialBias * 0.38;
}

function deterministicNoise(x: number, y: number, seed: string) {
  let hash = 2166136261;
  const text = `${seed}:${Math.round(x * 10)}:${Math.round(y * 10)}`;

  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return ((hash >>> 0) / 4294967295 - 0.5) * 2;
}

type MeshBuilder = {
  vertices: Vec3[];
  faces: RenderableMesh["faces"];
  features: RenderableMeshFeature[];
};

function createMeshBuilder(): MeshBuilder {
  return {
    vertices: [],
    faces: [],
    features: []
  };
}

type PlanarHole = {
  id: string;
  type: "bolt-hole" | "lightening-hole";
  x: number;
  y: number;
  radius: number;
};

function addPerforatedPlateFeature(
  mesh: MeshBuilder,
  options: {
    id: string;
    width: number;
    height: number;
    depth: number;
    holes: PlanarHole[];
    cellsX: number;
    cellsY: number;
    shade: number;
  }
) {
  const cellsX = Math.max(8, Math.round(options.cellsX));
  const cellsY = Math.max(8, Math.round(options.cellsY));
  const xStep = options.width / cellsX;
  const yStep = options.height / cellsY;
  const z0 = -options.depth / 2;
  const z1 = options.depth / 2;

  const occupied: boolean[][] = [];

  for (let ix = 0; ix < cellsX; ix += 1) {
    occupied[ix] = [];

    for (let iy = 0; iy < cellsY; iy += 1) {
      const x = -options.width / 2 + xStep * (ix + 0.5);
      const y = -options.height / 2 + yStep * (iy + 0.5);
      occupied[ix][iy] = !options.holes.some((hole) => isPointInsideHole(x, y, hole));
    }
  }

  for (let ix = 0; ix < cellsX; ix += 1) {
    for (let iy = 0; iy < cellsY; iy += 1) {
      if (!occupied[ix][iy]) continue;

      const x0 = -options.width / 2 + xStep * ix;
      const x1 = x0 + xStep;
      const y0 = -options.height / 2 + yStep * iy;
      const y1 = y0 + yStep;

      addQuad(mesh, [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], "mounting-plate", options.shade * 1.04);
      addQuad(mesh, [[x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [x1, y0, z0]], "mounting-plate", options.shade * 0.86);

      if (ix === 0 || !occupied[ix - 1][iy]) {
        addQuad(mesh, [[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]], "mounting-plate", options.shade * 0.72);
      }

      if (ix === cellsX - 1 || !occupied[ix + 1][iy]) {
        addQuad(mesh, [[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]], "mounting-plate", options.shade * 0.78);
      }

      if (iy === 0 || !occupied[ix][iy - 1]) {
        addQuad(mesh, [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]], "mounting-plate", options.shade * 0.74);
      }

      if (iy === cellsY - 1 || !occupied[ix][iy + 1]) {
        addQuad(mesh, [[x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0]], "mounting-plate", options.shade * 0.82);
      }
    }
  }

  mesh.features.push({
    type: "mounting-plate",
    id: options.id,
    center: [0, 0, 0],
    size: [options.width, options.height, options.depth]
  });

  options.holes.forEach((hole) => {
    mesh.features.push({
      type: hole.type,
      id: hole.id,
      center: [hole.x, hole.y, 0],
      diameterMm: hole.radius * 2,
      throughAxis: "z"
    });
  });
}

function isPointInsideHole(x: number, y: number, hole: PlanarHole) {
  const dx = x - hole.x;
  const dy = y - hole.y;
  return Math.sqrt(dx * dx + dy * dy) <= hole.radius * 0.98;
}

function addQuad(mesh: MeshBuilder, vertices: Vec3[], group: string, shade: number) {
  const start = mesh.vertices.length;
  mesh.vertices.push(vertices[0], vertices[1], vertices[2], vertices[3]);
  mesh.faces.push({
    indices: [start, start + 1, start + 2, start + 3],
    group,
    shade
  });
}

function addOrientedWebFeature(
  mesh: MeshBuilder,
  options: {
    id: string;
    group: "gusset" | "diagonal-web";
    start: Vec3;
    end: Vec3;
    thickness: number;
    depth: number;
    shade: number;
  }
) {
  const dx = options.end[0] - options.start[0];
  const dy = options.end[1] - options.start[1];
  const length = Math.max(Math.sqrt(dx * dx + dy * dy), 0.001);
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
  addQuad(mesh, [a0, a1, b1, b0], options.group, options.shade * 0.82);
  addQuad(mesh, [a0, b0, b0f, a0f], options.group, options.shade * 0.92);
  addQuad(mesh, [a1, a1f, b1f, b1], options.group, options.shade * 0.74);
  addQuad(mesh, [a0, a0f, a1f, a1], options.group, options.shade * 0.7);
  addQuad(mesh, [b0, b1, b1f, b0f], options.group, options.shade * 0.86);

  mesh.features.push({
    type: options.group,
    id: options.id,
    center: [
      (options.start[0] + options.end[0]) / 2,
      (options.start[1] + options.end[1]) / 2,
      (z0 + z1) / 2
    ],
    size: [length, options.thickness, options.depth],
    rotationDeg: Math.atan2(dy, dx) * (180 / Math.PI)
  });
}

function addBoxFeature(
  mesh: MeshBuilder,
  options: {
    id: string;
    group: "rib" | "gusset" | "diagonal-web" | "mounting-plate" | "load-plate";
    min: Vec3;
    max: Vec3;
    shade: number;
  }
) {
  const start = mesh.vertices.length;
  const [x0, y0, z0] = options.min;
  const [x1, y1, z1] = options.max;

  mesh.vertices.push(
    [x0, y0, z0],
    [x1, y0, z0],
    [x1, y1, z0],
    [x0, y1, z0],
    [x0, y0, z1],
    [x1, y0, z1],
    [x1, y1, z1],
    [x0, y1, z1]
  );

  mesh.faces.push(
    { indices: [start + 0, start + 1, start + 2, start + 3], group: options.group, shade: options.shade * 0.88 },
    { indices: [start + 4, start + 7, start + 6, start + 5], group: options.group, shade: options.shade * 1.12 },
    { indices: [start + 0, start + 4, start + 5, start + 1], group: options.group, shade: options.shade * 1.02 },
    { indices: [start + 1, start + 5, start + 6, start + 2], group: options.group, shade: options.shade * 1.08 },
    { indices: [start + 2, start + 6, start + 7, start + 3], group: options.group, shade: options.shade },
    { indices: [start + 3, start + 7, start + 4, start + 0], group: options.group, shade: options.shade * 0.84 }
  );

  mesh.features.push({
    type: options.group,
    id: options.id,
    center: [
      (options.min[0] + options.max[0]) / 2,
      (options.min[1] + options.max[1]) / 2,
      (options.min[2] + options.max[2]) / 2
    ],
    size: [
      Math.abs(options.max[0] - options.min[0]),
      Math.abs(options.max[1] - options.min[1]),
      Math.abs(options.max[2] - options.min[2])
    ]
  });
}

function addDiagonalBoxFeature(
  mesh: MeshBuilder,
  options: {
    id: string;
    group: "gusset" | "diagonal-web";
    start: Vec3;
    end: Vec3;
    thickness: number;
    shade: number;
  }
) {
  const min: Vec3 = [
    Math.min(options.start[0], options.end[0]) - options.thickness / 2,
    Math.min(options.start[1], options.end[1]) - options.thickness / 2,
    Math.min(options.start[2], options.end[2]) - options.thickness / 2
  ];

  const max: Vec3 = [
    Math.max(options.start[0], options.end[0]) + options.thickness / 2,
    Math.max(options.start[1], options.end[1]) + options.thickness / 2,
    Math.max(options.start[2], options.end[2]) + options.thickness / 2
  ];

  addBoxFeature(mesh, {
    id: options.id,
    group: options.group,
    min,
    max,
    shade: options.shade
  });
}

function addCylinderFeature(
  mesh: MeshBuilder,
  options: {
    id: string;
    type: "bolt-hole" | "lightening-hole";
    center: Vec3;
    radius: number;
    innerRadius: number;
    height: number;
    segments: number;
    group: string;
    shade: number;
  }
) {
  const start = mesh.vertices.length;
  const z0 = options.center[2] - options.height / 2;
  const z1 = options.center[2] + options.height / 2;

  for (const z of [z0, z1]) {
    for (const radius of [options.radius, options.innerRadius]) {
      for (let index = 0; index < options.segments; index += 1) {
        const angle = (Math.PI * 2 * index) / options.segments;
        mesh.vertices.push([
          options.center[0] + Math.cos(angle) * radius,
          options.center[1] + Math.sin(angle) * radius,
          z
        ]);
      }
    }
  }

  const backOuter = start;
  const backInner = start + options.segments;
  const frontOuter = start + options.segments * 2;
  const frontInner = start + options.segments * 3;

  for (let index = 0; index < options.segments; index += 1) {
    const next = (index + 1) % options.segments;

    mesh.faces.push({
      indices: [backOuter + index, backOuter + next, frontOuter + next, frontOuter + index],
      group: options.group,
      shade: options.shade * 0.86
    });

    mesh.faces.push({
      indices: [frontOuter + index, frontOuter + next, frontInner + next, frontInner + index],
      group: options.group,
      shade: options.shade * 1.14
    });

    mesh.faces.push({
      indices: [backInner + index, frontInner + index, frontInner + next, backInner + next],
      group: options.group,
      shade: options.shade * 0.46
    });
  }

  mesh.features.push({
    type: options.type,
    id: options.id,
    center: options.center,
    diameterMm: options.innerRadius * 2,
    throughAxis: "z"
  });
}

function buildBoltPositions(
  width: number,
  height: number,
  railHeight: number,
  boltCount: number
): Array<[number, number]> {
  const safeCount = clamp(Math.round(boltCount), 1, 12);
  const xRadius = width * 0.32;
  const yTop = height / 2 - railHeight * 0.52;
  const yBottom = -height / 2 + railHeight * 0.52;

  if (safeCount === 1) return [[0, yBottom]];
  if (safeCount === 2) return [[-xRadius, yBottom], [xRadius, yBottom]];

  if (safeCount === 3) {
    return [[-xRadius, yBottom], [xRadius, yBottom], [0, yTop]];
  }

  if (safeCount === 4) {
    return [
      [-xRadius, yTop],
      [xRadius, yTop],
      [-xRadius, yBottom],
      [xRadius, yBottom]
    ];
  }

  const positions: Array<[number, number]> = [];

  for (let index = 0; index < safeCount; index += 1) {
    const angle = -Math.PI / 2 + (Math.PI * 2 * index) / safeCount;
    positions.push([Math.cos(angle) * xRadius, Math.sin(angle) * height * 0.36]);
  }

  return positions;
}

function buildLighteningHolePositions(
  width: number,
  height: number,
  railHeight: number,
  count: number
): Array<[number, number]> {
  const safeCount = clamp(Math.round(count), 0, 14);
  const positions: Array<[number, number]> = [];
  const usableHeight = Math.max(height - railHeight * 2.8, height * 0.35);

  if (safeCount <= 0) return positions;

  const columns = safeCount <= 4 ? safeCount : safeCount <= 8 ? 4 : 5;
  const rows = Math.ceil(safeCount / columns);

  for (let index = 0; index < safeCount; index += 1) {
    const column = index % columns;
    const row = Math.floor(index / columns);

    const x = lerp(
      -width * 0.28,
      width * 0.28,
      columns === 1 ? 0.5 : column / Math.max(columns - 1, 1)
    );

    const y = lerp(
      usableHeight * 0.34,
      -usableHeight * 0.34,
      rows === 1 ? 0.5 : row / Math.max(rows - 1, 1)
    );

    positions.push([x, y]);
  }

  return positions;
}

function buildStructuralDesignSpace(
  family: ComponentFamily,
  requirements: StructuralBracketRequirements
): StructuralDesignParameters[] {
  const policy = resolveSkeletonizationPolicy(family, requirements);
  const sealedRequired = policy === "sealed-required" || policy === "none";

  const requestedOpenArea = requirements.objectives.targetOpenAreaPercent;
  const targetOpenArea = clamp(
    requestedOpenArea ?? (requirements.objectives.priority === "lightweight" ? 58 : 46),
    35,
    80
  );

  const loadMode = requirements.loadCase.direction;
  const vibrationHz = requirements.loadCase.vibrationHz ?? 0;

  const topologyModes: StructuralTopologyMode[] = sealedRequired
    ? ["direct-load-path"]
    : loadMode === "lateral"
      ? ["cantilever-side-load", "split-y-truss", "vibration-stabilized"]
      : vibrationHz > 80
        ? ["direct-load-path", "split-y-truss", "arched-bridge", "vibration-stabilized"]
        : ["direct-load-path", "split-y-truss", "arched-bridge"];

  const thicknessFactors = requirements.objectives.priority === "lightweight"
    ? [0.9, 1.05, 1.22]
    : requirements.objectives.priority === "stiffness"
      ? [1.05, 1.25, 1.45]
      : [0.95, 1.15, 1.35];

  const openAreaBuckets = sealedRequired
    ? [0]
    : Array.from(new Set([
        roundTo(targetOpenArea - 10, 1),
        roundTo(targetOpenArea, 1),
        roundTo(targetOpenArea + 10, 1)
      ])).map((value) => clamp(value, 35, 80));

  const designSpace: StructuralDesignParameters[] = [];

  for (const topologyMode of topologyModes) {
    for (const thicknessFactor of thicknessFactors) {
      for (const openArea of openAreaBuckets) {
        const skeletonLevel = sealedRequired
          ? "none"
          : openArea >= 64
            ? "aggressive"
            : openArea >= 48
              ? "moderate"
              : "light";

        const modeMultiplier =
          topologyMode === "direct-load-path"
            ? 0.8
            : topologyMode === "split-y-truss"
              ? 1
              : topologyMode === "arched-bridge"
                ? 1.08
                : topologyMode === "cantilever-side-load"
                  ? 0.95
                  : 1.18;

        designSpace.push({
          topologyMode,
          thicknessFactor,
          ribCount: topologyMode === "direct-load-path" ? 2 : topologyMode === "arched-bridge" ? 3 : 2,
          gussetCount: topologyMode === "vibration-stabilized" ? 4 : topologyMode === "split-y-truss" ? 3 : 2,
          diagonalWebCount: sealedRequired ? 0 : Math.max(1, Math.round((100 - openArea) / 16 * modeMultiplier)),
          lighteningHoleCount: sealedRequired ? 0 : Math.max(1, Math.round(openArea / 14)),
          lighteningHoleDiameterMm: sealedRequired
            ? 0
            : roundTo(requirements.manufacturing.minWallThicknessMm * clamp(openArea / 15, 2.4, 5.2), 0.1),
          skeletonLevel
        });
      }
    }
  }

  return designSpace;
}
function resolveSkeletonizationPolicy(
  family: ComponentFamily,
  requirements: StructuralBracketRequirements
) {
  const requested = requirements.objectives.skeletonization ?? "auto";

  if (family === "pressure-vessel") return "sealed-required";
  if (requested === "sealed-required") return "sealed-required";
  if (requested === "none") return "none";
  if (requested === "aggressive") return "aggressive";

  return "auto";
}

function calculateTopologyFitScore(
  topologyMode: StructuralTopologyMode,
  requirements: StructuralBracketRequirements,
  boltCount: number,
  memberCount: number
) {
  const direction = requirements.loadCase.direction;
  const vibrationHz = requirements.loadCase.vibrationHz ?? 0;

  let score = 72;

  if (boltCount <= 2 && direction === "vertical") {
    score = topologyMode === "direct-load-path"
      ? 100
      : topologyMode === "split-y-truss"
        ? 78
        : topologyMode === "arched-bridge"
          ? 74
          : topologyMode === "vibration-stabilized"
            ? vibrationHz > 140
              ? 82
              : 64
            : 58;
  } else if (direction === "lateral") {
    score = topologyMode === "cantilever-side-load"
      ? 100
      : topologyMode === "split-y-truss"
        ? 78
        : topologyMode === "vibration-stabilized"
          ? vibrationHz > 120
            ? 82
            : 68
          : 60;
  } else if (direction === "multi-axis") {
    score = topologyMode === "split-y-truss"
      ? 92
      : topologyMode === "vibration-stabilized"
        ? vibrationHz > 90
          ? 90
          : 76
        : topologyMode === "arched-bridge"
          ? 82
          : 74;
  } else {
    score = topologyMode === "direct-load-path" ? 96 : topologyMode === "split-y-truss" ? 82 : 76;
  }

  if (vibrationHz > 120 && topologyMode !== "vibration-stabilized") {
    score -= 4;
  }

  if (memberCount > (boltCount <= 2 ? 4 : boltCount + 3)) {
    score -= Math.min(18, (memberCount - (boltCount <= 2 ? 4 : boltCount + 3)) * 3);
  }

  return clamp(score, 0, 100);
}

function calculateOpenAreaPercent(
  requirements: StructuralBracketRequirements,
  params: StructuralDesignParameters
) {
  const requested =
    requirements.objectives.targetOpenAreaPercent ??
    (requirements.objectives.priority === "lightweight" ? 42 : 32);

  const raw =
    params.lighteningHoleCount * 2.15 +
    params.diagonalWebCount * 1.25 +
    params.lighteningHoleDiameterMm * 0.9 -
    params.thicknessFactor * 4.5;

  return clamp((raw + requested) / 2, 6, 56);
}

function calculateLoadPathContinuityScore(
  params: StructuralDesignParameters,
  openAreaPercent: number
) {
  return clamp(
    82 +
      params.ribCount * 2.1 +
      params.gussetCount * 1.7 +
      params.diagonalWebCount * 1.25 -
      openAreaPercent * 0.55 -
      Math.max(0, params.lighteningHoleDiameterMm - 20) * 0.4,
    0,
    100
  );
}

function calculateSkeletonScore(
  requirements: StructuralBracketRequirements,
  openAreaPercent: number,
  loadPathContinuityScore: number
) {
  const target =
    requirements.objectives.targetOpenAreaPercent ??
    (requirements.objectives.priority === "lightweight" ? 42 : 32);

  return clamp(
    100 -
      Math.abs(openAreaPercent - target) * 1.35 -
      Math.max(0, 76 - loadPathContinuityScore) * 1.2,
    0,
    100
  );
}

function evaluateStructuralCandidateForReview(
  candidate: CandidateGeometry,
  requirements: StructuralBracketRequirements
): string[] {
  const reasons: string[] = [];

  const basePadRequirement =
    requirements.mounting.spacingMm + requirements.mounting.boltDiameterMm * 3.2;

  if (candidate.widthMm > requirements.envelope.maxWidthMm) {
    reasons.push("Exceeds maximum width envelope.");
  }

  if (candidate.heightMm > requirements.envelope.maxHeightMm) {
    reasons.push("Exceeds maximum height envelope.");
  }

  if (candidate.depthMm > requirements.envelope.maxDepthMm) {
    reasons.push("Exceeds maximum depth envelope.");
  }

  if (candidate.widthMm < basePadRequirement) {
    reasons.push("Bolt pattern does not fit generated base width.");
  }

  if (candidate.wallThicknessMm < requirements.manufacturing.minWallThicknessMm) {
    reasons.push("Wall thickness below manufacturing minimum.");
  }

  if (candidate.safetyFactorEstimate < requirements.safetyFactor) {
    reasons.push("Estimated safety factor below requirement.");
  }

  if (candidate.manufacturabilityScore < 55) {
    reasons.push("Manufacturability score below threshold.");
  }

  if (candidate.supportBurdenScore < 50) {
    reasons.push("Support burden too high for first-pass fabrication readiness.");
  }

  if ((candidate.loadPathContinuityScore ?? 100) < 68) {
    reasons.push("Skeletonized load path continuity score below acceptable threshold.");
  }

  if ((candidate.openAreaPercent ?? 0) > 56) {
    reasons.push("Skeletonized open area too high for first-pass structural confidence.");
  }

  const targetMass = requirements.objectives.targetMassKg;

  if (targetMass && candidate.estimatedMassKg > targetMass * 1.75) {
    reasons.push("Mass exceeds target mass tolerance.");
  }

  return reasons;
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
          ? `${acceptedCount} candidates satisfied the first-pass load, envelope, skeletonization, manufacturability, and support-burden filters.`
          : "No candidates fully satisfied all filters. The best-scoring fallback candidate was selected for review."
    },
    {
      severity: selected.safetyFactorEstimate >= requirements.safetyFactor ? "success" : "warning",
      title: "Best Candidate Selected",
      text: `Selected ${selected.id} with score ${selected.totalScore.toFixed(
        1
      )}/100, mass ${selected.estimatedMassKg.toFixed(
        3
      )} kg, stress ${selected.estimatedStressMpa.toFixed(
        1
      )} MPa, displacement ${selected.estimatedDisplacementMm.toFixed(
        4
      )} mm, and safety factor ${selected.safetyFactorEstimate.toFixed(2)}.`
    },
    {
      severity: selected.renderMesh ? "success" : "warning",
      title: "Renderable Geometry Generated",
      text: selected.renderMesh
        ? `The selected candidate includes a renderable mesh with ${selected.renderMesh.vertices.length} vertices, ${selected.renderMesh.faces.length} faces, ${selected.renderMesh.metadata.boltCount} bolt holes, and ${selected.renderMesh.metadata.lighteningHoleCount} lightening holes.`
        : "The selected candidate does not include renderable mesh data."
    },
    {
      severity: selected.skeletonized ? "success" : "warning",
      title: "Skeletonized Weight Reduction",
      text: selected.skeletonized
        ? `The selected structural design uses skeletonization with ${(selected.openAreaPercent ?? 0).toFixed(
            1
          )}% open area and load-path continuity score ${(selected.loadPathContinuityScore ?? 0).toFixed(
            1
          )}/100.`
        : "The selected design is solid/sealed. This is expected only when skeletonization is disabled or sealing is required."
    },
    {
      severity: selected.manufacturabilityScore >= 70 ? "success" : "warning",
      title: "Manufacturability Filter",
      text: `Manufacturability score ${selected.manufacturabilityScore.toFixed(
        1
      )}/100 using additive manufacturing constraints.`
    },
    {
      severity: baselineComparison.avoidedSimulationRuns > 0 ? "success" : "warning",
      title: "Baseline Comparison",
      text: `Constraint-filtered generation avoided ${
        baselineComparison.avoidedSimulationRuns
      } estimated simulation runs compared with the unconstrained baseline, reducing simulation load by ${baselineComparison.reductionInSimulationLoadPercent.toFixed(
        1
      )}%.`
    }
  ];
}

function createEmergencyStructuralCandidate(
  family: ComponentFamily,
  requirements: StructuralBracketRequirements
): CandidateGeometry {
  return {
    id: "emergency_structural_candidate",
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
    skeletonized: false,
    skeletonizationPolicy: "auto",
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
    revision: "REQ-GEN-004-SEALED-NOZZLE-MESH",
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
      candidates: {
        evaluated: 1,
        accepted: 1,
        rejected: 0,
        bestCandidateId: selectedWithMesh.id
      },
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
  const exitDiameterMm = Math.min(
    requirements.envelope.maxExitDiameterMm,
    throatDiameterMm * Math.sqrt(expansionRatio)
  );
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

function buildNozzleRenderMesh(
  candidate: CandidateGeometry,
  requirements: BellNozzleRequirements
): RenderableMesh {
  const mesh = createMeshBuilder();

  const length = candidate.lengthMm;
  const exitDiameter = candidate.widthMm;
  const throatDiameter = numberParam(candidate, "throatDiameterMm", exitDiameter * 0.28);
  const wall = candidate.wallThicknessMm;
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
      mesh.vertices.push([
        Math.cos(angle) * station.radius,
        Math.sin(angle) * station.radius,
        station.z
      ]);
    }
  }

  for (let stationIndex = 0; stationIndex < stations.length - 1; stationIndex += 1) {
    for (let segmentIndex = 0; segmentIndex < segments; segmentIndex += 1) {
      const next = (segmentIndex + 1) % segments;

      mesh.faces.push({
        indices: [
          stationIndex * segments + segmentIndex,
          stationIndex * segments + next,
          (stationIndex + 1) * segments + next,
          (stationIndex + 1) * segments + segmentIndex
        ],
        group: "nozzle-shell",
        shade: 0.66 + (stationIndex / stations.length) * 0.22
      });
    }
  }

  return {
    version: "haf-render-mesh-v1",
    units: "mm",
    family: "bell-nozzle",
    vertices: mesh.vertices,
    faces: mesh.faces,
    features: [],
    bounds: {
      widthMm: exitDiameter,
      heightMm: exitDiameter,
      depthMm: length
    },
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
    {
      name: "AlSi10Mg",
      densityGcc: 2.68,
      allowableStressMpa: 165,
      elasticModulusMpa: 70_000
    },
    {
      name: "Ti-6Al-4V",
      densityGcc: 4.43,
      allowableStressMpa: 780,
      elasticModulusMpa: 114_000
    },
    {
      name: "Inconel 718",
      densityGcc: 8.19,
      allowableStressMpa: 1030,
      elasticModulusMpa: 200_000
    }
  ];

  if (requirements.objectives.priority === "lightweight") {
    return [materials[0], materials[1], materials[2]];
  }

  if (requirements.objectives.priority === "stiffness") {
    return [materials[1], materials[2], materials[0]];
  }

  return materials;
}

function numberParam(candidate: CandidateGeometry, key: string, fallback: number) {
  const value = candidate.derivedParameters[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function estimateComputeBurn(evaluated: number, accepted: number) {
  return Math.max(1, Math.ceil(evaluated / 45) + Math.max(0, 3 - accepted));
}

function weightedAverage(items: Array<[number, number]>) {
  const totalWeight = items.reduce((sum, [, weight]) => sum + weight, 0);

  if (totalWeight <= 0) {
    return 0;
  }

  return items.reduce((sum, [value, weight]) => sum + value * weight, 0) / totalWeight;
}

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function roundTo(value: number, step: number) {
  return Math.round(value / step) * step;
}
