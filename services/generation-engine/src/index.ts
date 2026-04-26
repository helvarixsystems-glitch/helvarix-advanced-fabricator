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

type StructuralDesignParameters = {
  thicknessFactor: number;
  ribCount: number;
  gussetCount: number;
  diagonalWebCount: number;
  lighteningHoleCount: number;
  lighteningHoleDiameterMm: number;
  skeletonLevel: "none" | "light" | "moderate" | "aggressive";
};

function generateStructuralPart(
  family: ComponentFamily,
  requirements: StructuralBracketRequirements
): GenerationResult {
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
    renderMesh: buildStructuralRenderMesh(selectedWithoutMesh, requirements)
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
    revision: "REQ-GEN-004-RENDERABLE-CANDIDATE-MESH",
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
        `${filteredCandidates.length} candidate designs were generated and scored.`,
        `${rejected.length} candidates were rejected before simulation by manufacturability, load-path, envelope, and safety filters.`,
        `${accepted.length} candidates advanced to simulation-ready review.`,
        `Selected candidate ${selected.id} with total score ${selected.totalScore.toFixed(1)}/100.`,
        `Selected geometry uses ${requirements.mounting.boltCount} bolt hole${
          requirements.mounting.boltCount === 1 ? "" : "s"
        } from the input requirements.`,
        `Selected geometry is ${
          selected.skeletonized ? "skeletonized" : "solid/sealed"
        } with ${(selected.openAreaPercent ?? 0).toFixed(1)}% open area.`,
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

      const massScore = targetMass
        ? clamp(100 - Math.abs(estimatedMassKg - targetMass) * 55, 0, 100)
        : clamp(100 - estimatedMassKg * 18, 0, 100);

      const stiffnessScore = clamp(100 - estimatedDisplacementMm * 28, 0, 100);

      const strengthScore = clamp(
        (safetyFactorEstimate / Math.max(requirements.safetyFactor, 0.1)) * 100,
        0,
        125
      );

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

      const performanceScore =
        requirements.objectives.priority === "lightweight"
          ? weightedAverage([
              [massScore, 0.32],
              [skeletonScore, 0.24],
              [strengthScore, 0.2],
              [stiffnessScore, 0.12],
              [manufacturabilityScore, 0.12]
            ])
          : requirements.objectives.priority === "stiffness"
            ? weightedAverage([
                [stiffnessScore, 0.34],
                [strengthScore, 0.27],
                [loadPathContinuityScore, 0.18],
                [manufacturabilityScore, 0.12],
                [massScore, 0.09]
              ])
            : weightedAverage([
                [strengthScore, 0.24],
                [stiffnessScore, 0.21],
                [skeletonScore, 0.19],
                [manufacturabilityScore, 0.16],
                [supportBurdenScore, 0.11],
                [massScore, 0.09]
              ]);

      const totalScore = weightedAverage([
        [performanceScore, 0.48],
        [manufacturabilityScore, 0.19],
        [supportBurdenScore, 0.11],
        [massScore, 0.12],
        [loadPathContinuityScore, 0.1]
      ]);

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
          ribCount: params.ribCount,
          gussetCount: params.gussetCount,
          diagonalWebCount: params.diagonalWebCount,
          lighteningHoleCount: params.lighteningHoleCount,
          lighteningHoleDiameterMm: params.lighteningHoleDiameterMm,
          skeletonLevel: params.skeletonLevel,
          openAreaPercent: roundTo(openAreaPercent, 0.1),
          latticeCellCount,
          loadPathContinuityScore: roundTo(loadPathContinuityScore, 0.1),
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

function buildStructuralRenderMesh(
  candidate: CandidateGeometry,
  requirements: StructuralBracketRequirements
): RenderableMesh {
  const mesh = createMeshBuilder();

  const width = candidate.widthMm;
  const height = candidate.heightMm;
  const depth = candidate.depthMm;
  const wall = candidate.wallThicknessMm;

  const ribCount = numberParam(candidate, "ribCount", 4);
  const gussetCount = numberParam(candidate, "gussetCount", 4);
  const diagonalWebCount = numberParam(candidate, "diagonalWebCount", 6);
  const lighteningHoleCount = numberParam(candidate, "lighteningHoleCount", 6);
  const lighteningHoleDiameterMm = numberParam(
    candidate,
    "lighteningHoleDiameterMm",
    wall * 3.25
  );

  const boltCount = clamp(Math.round(requirements.mounting.boltCount), 1, 12);
  const boltDiameterMm = Math.max(requirements.mounting.boltDiameterMm, wall * 0.9);

  const railHeight = Math.max(wall * 2.6, height * 0.13);
  const sideRailWidth = Math.max(wall * 2.2, width * 0.08);
  const ribWidth = Math.max(wall * 1.25, width * 0.04);

  addBoxFeature(mesh, {
    id: "mounting-plate-bottom",
    group: "mounting-plate",
    min: [-width / 2, -height / 2, -depth / 2],
    max: [width / 2, -height / 2 + railHeight, depth / 2],
    shade: 0.72
  });

  addBoxFeature(mesh, {
    id: "load-plate-top",
    group: "load-plate",
    min: [-width / 2, height / 2 - railHeight, -depth / 2],
    max: [width / 2, height / 2, depth / 2],
    shade: 0.82
  });

  addBoxFeature(mesh, {
    id: "side-rail-left",
    group: "rib",
    min: [-width / 2, -height / 2, -depth / 2],
    max: [-width / 2 + sideRailWidth, height / 2, depth / 2],
    shade: 0.68
  });

  addBoxFeature(mesh, {
    id: "side-rail-right",
    group: "rib",
    min: [width / 2 - sideRailWidth, -height / 2, -depth / 2],
    max: [width / 2, height / 2, depth / 2],
    shade: 0.7
  });

  const usableHeight = height - railHeight * 2.35;
  const ribSlots = Math.max(1, Math.min(9, ribCount));

  for (let index = 0; index < ribSlots; index += 1) {
    const x = lerp(-width * 0.34, width * 0.34, ribSlots === 1 ? 0.5 : index / (ribSlots - 1));

    addBoxFeature(mesh, {
      id: `vertical-rib-${index + 1}`,
      group: "rib",
      min: [x - ribWidth / 2, -usableHeight / 2, -depth * 0.42],
      max: [x + ribWidth / 2, usableHeight / 2, depth * 0.42],
      shade: 0.64 + index * 0.012
    });
  }

  const gussetSlots = Math.max(0, Math.min(10, gussetCount));

  for (let index = 0; index < gussetSlots; index += 1) {
    const side = index % 2 === 0 ? -1 : 1;
    const y = lerp(
      -height * 0.32,
      height * 0.32,
      gussetSlots <= 2 ? 0.5 : Math.floor(index / 2) / Math.max(Math.ceil(gussetSlots / 2) - 1, 1)
    );

    addDiagonalBoxFeature(mesh, {
      id: `gusset-${index + 1}`,
      group: "gusset",
      start: [side * width * 0.38, y - wall * 0.5, -depth * 0.38],
      end: [side * width * 0.18, y + height * 0.14, depth * 0.36],
      thickness: Math.max(wall * 1.1, 4),
      shade: 0.62
    });
  }

  if (candidate.skeletonized) {
    const webSlots = Math.max(0, Math.min(12, diagonalWebCount));

    for (let index = 0; index < webSlots; index += 1) {
      const y = lerp(
        -height * 0.28,
        height * 0.28,
        webSlots === 1 ? 0.5 : index / Math.max(webSlots - 1, 1)
      );

      const tilt = index % 2 === 0 ? 1 : -1;

      addDiagonalBoxFeature(mesh, {
        id: `diagonal-web-${index + 1}`,
        group: "diagonal-web",
        start: [-width * 0.33, y - wall * 0.3, -depth * 0.24],
        end: [width * 0.33, y + tilt * height * 0.12, depth * 0.22],
        thickness: Math.max(wall * 0.78, 3.5),
        shade: 0.56
      });
    }
  } else {
    addBoxFeature(mesh, {
      id: "solid-center-web",
      group: "rib",
      min: [-width * 0.28, -height * 0.22, -depth * 0.28],
      max: [width * 0.28, height * 0.22, depth * 0.28],
      shade: 0.56
    });
  }

  const boltPositions = buildBoltPositions(width, height, railHeight, boltCount);

  boltPositions.forEach((center, index) => {
    addCylinderFeature(mesh, {
      id: `bolt-hole-${index + 1}`,
      type: "bolt-hole",
      center: [center[0], center[1], depth / 2 + wall * 0.08],
      radius: boltDiameterMm * 0.85,
      innerRadius: boltDiameterMm * 0.42,
      height: wall * 1.15,
      segments: 24,
      group: "bolt-hole",
      shade: 0.88
    });
  });

  if (candidate.skeletonized) {
    const lighteningPositions = buildLighteningHolePositions(
      width,
      height,
      railHeight,
      lighteningHoleCount
    );

    lighteningPositions.forEach((center, index) => {
      addCylinderFeature(mesh, {
        id: `lightening-hole-${index + 1}`,
        type: "lightening-hole",
        center: [center[0], center[1], depth / 2 + wall * 0.06],
        radius: lighteningHoleDiameterMm / 2,
        innerRadius: lighteningHoleDiameterMm * 0.31,
        height: wall * 0.9,
        segments: 24,
        group: "lightening-hole",
        shade: 0.77
      });
    });
  }

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
      lighteningHoleCount: candidate.skeletonized ? lighteningHoleCount : 0,
      ribCount,
      gussetCount,
      diagonalWebCount,
      skeletonized: candidate.skeletonized
    }
  };

  return renderMesh;
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

  const targetOpenArea =
    requirements.objectives.targetOpenAreaPercent ??
    (requirements.objectives.priority === "lightweight" ? 42 : 32);

  const thicknessFactors = [0.85, 1, 1.15, 1.3, 1.55, 1.85, 2.15];
  const ribCounts = [2, 3, 4, 5, 6, 7];
  const gussetCounts = [2, 4, 6, 8];
  const diagonalWebCounts = sealedRequired ? [0] : [2, 4, 6, 8, 10];
  const lighteningHoleCounts = sealedRequired
    ? [0]
    : targetOpenArea >= 40
      ? [4, 6, 8, 10, 12]
      : [2, 4, 6, 8];

  const holeDiameterOptions = sealedRequired
    ? [0]
    : [
        requirements.manufacturing.minWallThicknessMm * 2.5,
        requirements.manufacturing.minWallThicknessMm * 3.25,
        requirements.manufacturing.minWallThicknessMm * 4,
        requirements.manufacturing.minWallThicknessMm * 5
      ];

  const designSpace: StructuralDesignParameters[] = [];

  for (const thicknessFactor of thicknessFactors) {
    for (const ribCount of ribCounts) {
      for (const gussetCount of gussetCounts) {
        for (const diagonalWebCount of diagonalWebCounts) {
          for (const lighteningHoleCount of lighteningHoleCounts) {
            for (const lighteningHoleDiameterMm of holeDiameterOptions) {
              const skeletonLevel =
                sealedRequired || lighteningHoleCount === 0
                  ? "none"
                  : targetOpenArea >= 44 || lighteningHoleCount >= 10
                    ? "aggressive"
                    : targetOpenArea >= 30 || lighteningHoleCount >= 6
                      ? "moderate"
                      : "light";

              designSpace.push({
                thicknessFactor,
                ribCount,
                gussetCount,
                diagonalWebCount,
                lighteningHoleCount,
                lighteningHoleDiameterMm: roundTo(lighteningHoleDiameterMm, 0.1),
                skeletonLevel
              });
            }
          }
        }
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
