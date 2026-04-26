import type {
  BaselineComparison,
  BellNozzleRequirements,
  CandidateGeometry,
  ComponentFamily,
  DerivedGeometry,
  GenerationInput,
  GenerationResult,
  StructuralBracketRequirements,
  ValidationMessage
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

  const selected =
    accepted[0] ??
    [...filteredCandidates].sort((a, b) => b.totalScore - a.totalScore)[0] ??
    createEmergencyStructuralCandidate(family, requirements);

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
    derivedParameters: selected.derivedParameters
  };

  return {
    revision: "REQ-GEN-003-SKELETONIZED-DESIGN-SEARCH",
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
        `Selected geometry is ${
          selected.skeletonized ? "skeletonized" : "solid/sealed"
        } with ${(selected.openAreaPercent ?? 0).toFixed(1)}% open area.`,
        `Estimated mass is ${selected.estimatedMassKg.toFixed(3)} kg with estimated safety factor ${selected.safetyFactorEstimate.toFixed(
          2
        )}.`,
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

  const derived: DerivedGeometry = {
    widthMm: selected.widthMm,
    heightMm: selected.heightMm,
    depthMm: selected.depthMm,
    lengthMm: selected.lengthMm,
    wallThicknessMm: selected.wallThicknessMm,
    material: selected.material,
    estimatedMassKg: selected.estimatedMassKg,
    selectedCandidateId: selected.id,
    skeletonized: false,
    skeletonizationPolicy: "sealed-required",
    openAreaPercent: 0,
    latticeCellCount: 0,
    loadPathContinuityScore: 100,
    derivedParameters: selected.derivedParameters
  };

  return {
    revision: "REQ-GEN-003-SEALED-NOZZLE",
    exportState: "idle",
    estimatedMassKg: selected.estimatedMassKg,
    estimatedBurn: 18,
    geometry: {
      silhouette: "bell-nozzle",
      material: selected.material,
      lengthMm: selected.lengthMm,
      widthMm: selected.widthMm,
      heightMm: selected.heightMm,
      depthMm: selected.depthMm,
      wallThicknessMm: selected.wallThicknessMm,
      skeletonized: false,
      skeletonizationPolicy: "sealed-required",
      openAreaPercent: 0,
      latticeCellCount: 0,
      loadPathContinuityScore: 100,
      derived,
      candidates: {
        evaluated: 1,
        accepted: 1,
        rejected: 0,
        bestCandidateId: selected.id
      },
      notes: [
        "Bell nozzles are treated as sealed pressure-boundary/aerodynamic components.",
        "Skeletonization is intentionally disabled for this component family.",
        "Later versions may add internal cooling passages, but the external aerodynamic and pressure boundary remains sealed."
      ]
    },
    validations: [
      {
        severity: "success",
        title: "Sealed Geometry Required",
        text: "Nozzle generation preserved a sealed pressure boundary instead of applying skeletonized lightening holes."
      }
    ],
    derived,
    candidatesEvaluated: 1,
    candidatesAccepted: 1,
    candidatesRejected: 0,
    selectedCandidate: selected,
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

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function roundTo(value: number, step: number) {
  return Math.round(value / step) * step;
}
