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

// ==============================
// PUBLIC ENTRYPOINT
// ==============================

export async function generateComponent(input: GenerationInput): Promise<GenerationResult> {
  if (input.componentFamily === "bell-nozzle") {
    return generateBellNozzle(input.requirements);
  }

  return generateStructuralPart(input.componentFamily, input.requirements);
}

// Backwards-compatible alias in case other packages import the older name.
export const runGeneration = generateComponent;

// ==============================
// STRUCTURAL BRACKET / STRUCTURAL PART GENERATOR
// ==============================

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

  const baselineAcceptedAfterReview = baselineCandidates
    .map((candidate) => ({
      ...candidate,
      rejected: evaluateStructuralCandidateForReview(candidate, requirements).length > 0,
      rejectionReasons: evaluateStructuralCandidateForReview(candidate, requirements)
    }))
    .sort((a, b) => b.totalScore - a.totalScore);

  const selectedBaseline = baselineAcceptedAfterReview[0];

  const baselineRejectedAfterReview = baselineAcceptedAfterReview.filter(
    (candidate) => candidate.rejected
  );

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
    derivedParameters: selected.derivedParameters
  };

  const validations = buildStructuralValidations(
    requirements,
    selected,
    accepted.length,
    baselineComparison
  );

  return {
    revision: "REQ-GEN-002-PHASE-I-BRACKET",
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
      derived,
      candidates: {
        evaluated: filteredCandidates.length,
        accepted: accepted.length,
        rejected: rejected.length,
        bestCandidateId: selected.id
      },
      notes: [
        `${filteredCandidates.length} requirement-derived structural candidates evaluated.`,
        `${rejected.length} candidates rejected before simulation by design-time manufacturability and structural filters.`,
        `${accepted.length} candidates advanced to simulation-ready review.`,
        `Baseline comparison avoided ${baselineComparison.avoidedSimulationRuns} simulation runs, a ${baselineComparison.reductionInSimulationLoadPercent.toFixed(
          1
        )}% estimated reduction.`,
        `Selected ${selected.material} candidate ${selected.id} with estimated safety factor ${selected.safetyFactorEstimate.toFixed(
          2
        )}.`
      ]
    },
    validations,
    derived,
    candidatesEvaluated: filteredCandidates.length,
    candidatesAccepted: accepted.length,
    candidatesRejected: rejected.length,
    selectedCandidate: selected,
    rejectedCandidates: rejected.slice(0, 20),
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

  const minThickness = requirements.manufacturing.minWallThicknessMm;

  const basePadRequirement =
    requirements.mounting.spacingMm +
    requirements.mounting.boltDiameterMm * 3.2;

  let index = 0;

  for (const material of materialOptions) {
    for (const thicknessFactor of [0.8, 1, 1.15, 1.25, 1.5, 1.8, 2.15]) {
      for (const ribCount of [1, 2, 3, 4, 5, 6]) {
        for (const gussetCount of [0, 2, 4, 6]) {
          index += 1;

          const wallThicknessMm = roundTo(minThickness * thicknessFactor, 0.1);

          const widthMm = clamp(
            Math.max(
              basePadRequirement * (ribCount <= 1 ? 0.9 : 1),
              requirements.envelope.maxWidthMm * (0.5 + ribCount * 0.04)
            ),
            requirements.mounting.boltDiameterMm * 4,
            requirements.envelope.maxWidthMm * 1.08
          );

          const heightMm = clamp(
            requirements.envelope.maxHeightMm * (0.36 + gussetCount * 0.05),
            requirements.mounting.boltDiameterMm * 4,
            requirements.envelope.maxHeightMm * 1.08
          );

          const depthMm = clamp(
            requirements.envelope.maxDepthMm * (0.42 + thicknessFactor * 0.08),
            requirements.mounting.boltDiameterMm * 3.5,
            requirements.envelope.maxDepthMm * 1.08
          );

          const ribEfficiency = 1 + ribCount * 0.11;
          const gussetEfficiency = 1 + gussetCount * 0.07;
          const boltInterfacePenalty = widthMm < basePadRequirement ? 0.72 : 1;

          const sectionAreaMm2 = wallThicknessMm * (widthMm + heightMm * 0.7);

          const loadCapacityN =
            sectionAreaMm2 *
            material.allowableStressMpa *
            ribEfficiency *
            gussetEfficiency *
            boltInterfacePenalty *
            0.82;

          const safetyFactorEstimate = loadCapacityN / Math.max(requirements.loadCase.forceN, 1);

          const estimatedStressMpa =
            requiredLoadN / Math.max(sectionAreaMm2 * ribEfficiency * boltInterfacePenalty, 1);

          const estimatedDisplacementMm =
            (requirements.loadCase.forceN * Math.pow(heightMm, 2)) /
            Math.max(material.elasticModulusMpa * sectionAreaMm2 * ribEfficiency * 175, 1);

          const volumeMm3 =
            widthMm * depthMm * wallThicknessMm * 2.2 +
            heightMm * depthMm * wallThicknessMm * 1.5 +
            ribCount * heightMm * wallThicknessMm * depthMm * 0.42 +
            gussetCount * widthMm * wallThicknessMm * depthMm * 0.28;

          const estimatedMassKg = (volumeMm3 / 1_000_000) * material.densityGcc;

          const overhangPenalty =
            requirements.manufacturing.process === "additive" &&
            requirements.manufacturing.maxOverhangDeg < 45 &&
            gussetCount < 4
              ? 22
              : 0;

          const unsupportedPenalty =
            requirements.manufacturing.process === "additive" &&
            !requirements.manufacturing.supportAllowed &&
            gussetCount < 4
              ? 18
              : 0;

          const supportAccessPenalty =
            requirements.manufacturing.process === "additive" && gussetCount === 0 ? 16 : 0;

          const manufacturabilityScore = clamp(
            100 -
              overhangPenalty -
              unsupportedPenalty -
              supportAccessPenalty -
              Math.max(0, wallThicknessMm - minThickness * 2.4) * 4 -
              (widthMm < basePadRequirement ? 18 : 0),
            0,
            100
          );

          const supportBurdenScore = clamp(
            100 -
              (requirements.manufacturing.supportAllowed ? 4 : 16) -
              Math.max(0, 45 - requirements.manufacturing.maxOverhangDeg) * 1.2 -
              Math.max(0, 4 - gussetCount) * 6,
            0,
            100
          );

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

          const performanceScore =
            requirements.objectives.priority === "lightweight"
              ? weightedAverage([
                  [massScore, 0.45],
                  [strengthScore, 0.25],
                  [stiffnessScore, 0.15],
                  [manufacturabilityScore, 0.15]
                ])
              : requirements.objectives.priority === "stiffness"
                ? weightedAverage([
                    [stiffnessScore, 0.4],
                    [strengthScore, 0.3],
                    [manufacturabilityScore, 0.18],
                    [massScore, 0.12]
                  ])
                : weightedAverage([
                    [strengthScore, 0.3],
                    [stiffnessScore, 0.25],
                    [manufacturabilityScore, 0.2],
                    [supportBurdenScore, 0.15],
                    [massScore, 0.1]
                  ]);

          const baseCandidate: CandidateGeometry = {
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
            totalScore: roundTo(
              weightedAverage([
                [performanceScore, 0.55],
                [manufacturabilityScore, 0.22],
                [supportBurdenScore, 0.13],
                [massScore, 0.1]
              ]),
              0.1
            ),
            rejected: false,
            rejectionReasons: [],
            derivedParameters: {
              ribCount,
              gussetCount,
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
            ? evaluateStructuralCandidateForReview(baseCandidate, requirements)
            : [];

          candidates.push({
            ...baseCandidate,
            rejected: rejectionReasons.length > 0,
            rejectionReasons
          });
        }
      }
    }
  }

  return candidates;
}

function evaluateStructuralCandidateForReview(
  candidate: CandidateGeometry,
  requirements: StructuralBracketRequirements
): string[] {
  const reasons: string[] = [];

  const basePadRequirement =
    requirements.mounting.spacingMm +
    requirements.mounting.boltDiameterMm * 3.2;

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

  const targetMass = requirements.objectives.targetMassKg;

  if (targetMass && candidate.estimatedMassKg > targetMass * 1.75) {
    reasons.push("Mass exceeds target mass tolerance.");
  }

  return reasons;
}

function createEmergencyStructuralCandidate(
  family: ComponentFamily,
  requirements: StructuralBracketRequirements
): CandidateGeometry {
  const widthMm = requirements.envelope.maxWidthMm;
  const heightMm = requirements.envelope.maxHeightMm * 0.7;
  const depthMm = requirements.envelope.maxDepthMm * 0.7;
  const wallThicknessMm = requirements.manufacturing.minWallThicknessMm;

  return {
    id: "emergency_structural_candidate",
    family,
    material: "Ti-6Al-4V",
    widthMm,
    heightMm,
    depthMm,
    lengthMm: Math.max(widthMm, heightMm),
    wallThicknessMm,
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
    derivedParameters: {
      ribCount: 0,
      gussetCount: 0,
      boltPadDiameterMm: requirements.mounting.boltDiameterMm * 2.4,
      requiredLoadN: requirements.loadCase.forceN * requirements.safetyFactor,
      loadDirection: requirements.loadCase.direction,
      vibrationHz: requirements.loadCase.vibrationHz ?? 0,
      manufacturingProcess: requirements.manufacturing.process,
      supportAllowed: requirements.manufacturing.supportAllowed
    }
  };
}

// ==============================
// BELL NOZZLE GENERATOR
// ==============================

function generateBellNozzle(requirements: BellNozzleRequirements): GenerationResult {
  const candidates = buildBellNozzleCandidates(requirements);

  const accepted = candidates
    .filter((candidate) => !candidate.rejected)
    .sort((a, b) => b.totalScore - a.totalScore);

  const rejected = candidates.filter((candidate) => candidate.rejected);

  const selected =
    accepted[0] ??
    [...candidates].sort((a, b) => b.totalScore - a.totalScore)[0] ??
    createEmergencyNozzleCandidate(requirements);

  const derived: DerivedGeometry = {
    widthMm: selected.widthMm,
    heightMm: selected.heightMm,
    depthMm: selected.depthMm,
    lengthMm: selected.lengthMm,
    wallThicknessMm: selected.wallThicknessMm,
    material: selected.material,
    estimatedMassKg: selected.estimatedMassKg,
    selectedCandidateId: selected.id,
    derivedParameters: selected.derivedParameters
  };

  const validations = buildBellNozzleValidations(requirements, selected, accepted.length);

  return {
    revision: "REQ-GEN-002",
    exportState: "idle",
    estimatedMassKg: selected.estimatedMassKg,
    estimatedBurn: estimateComputeBurn(candidates.length, accepted.length),
    geometry: {
      silhouette: "bell-nozzle",
      material: selected.material,
      lengthMm: selected.lengthMm,
      widthMm: selected.widthMm,
      heightMm: selected.heightMm,
      depthMm: selected.depthMm,
      wallThicknessMm: selected.wallThicknessMm,
      derived,
      candidates: {
        evaluated: candidates.length,
        accepted: accepted.length,
        rejected: rejected.length,
        bestCandidateId: selected.id
      },
      notes: [
        `${candidates.length} nozzle candidates evaluated from thrust, burn, propellant, and envelope constraints.`,
        `Selected expansion ratio ${String(selected.derivedParameters.expansionRatio)} with ${selected.material}.`,
        `Estimated chamber pressure ${String(selected.derivedParameters.chamberPressureBar)} bar.`
      ]
    },
    validations,
    derived,
    candidatesEvaluated: candidates.length,
    candidatesAccepted: accepted.length,
    candidatesRejected: rejected.length,
    selectedCandidate: selected,
    rejectedCandidates: rejected.slice(0, 12)
  };
}

function buildBellNozzleCandidates(requirements: BellNozzleRequirements): CandidateGeometry[] {
  const candidates: CandidateGeometry[] = [];
  const propellant = resolvePropellantModel(requirements);
  const materialOptions = selectNozzleMaterialOptions(requirements);

  const chamberPressureBarOptions = requirements.performance.chamberPressureBar
    ? [requirements.performance.chamberPressureBar]
    : [12, 18, 24, 32];

  const mixtureRatioOptions = requirements.propellant.mixtureRatio
    ? [requirements.propellant.mixtureRatio]
    : propellant.defaultMixtureRatios;

  let index = 0;

  for (const material of materialOptions) {
    for (const chamberPressureBar of chamberPressureBarOptions) {
      for (const mixtureRatio of mixtureRatioOptions) {
        for (const expansionRatio of [8, 12, 18, 24, 32, 45]) {
          for (const lengthFraction of [0.68, 0.78, 0.88]) {
            index += 1;

            const chamberPressurePa = chamberPressureBar * 100_000;

            const thrustCoefficient = estimateThrustCoefficient(
              expansionRatio,
              requirements.performance.ambientPressurePa,
              chamberPressurePa
            );

            const throatAreaM2 =
              requirements.performance.targetThrustN /
              Math.max(chamberPressurePa * thrustCoefficient, 1);

            const throatDiameterMm = Math.sqrt((4 * throatAreaM2) / Math.PI) * 1000;
            const exitDiameterMm = throatDiameterMm * Math.sqrt(expansionRatio);
            const lengthMm = exitDiameterMm * lengthFraction * 1.18;

            const chamberTemperatureC =
              propellant.nominalFlameTemperatureC +
              (mixtureRatio - propellant.nominalMixtureRatio) * propellant.temperatureSlope;

            const coolingMultiplier =
              requirements.thermal.coolingMode === "regenerative"
                ? 0.72
                : requirements.thermal.coolingMode === "ablative"
                  ? 0.9
                  : 1.15;

            const thermalWallC = chamberTemperatureC * coolingMultiplier;

            const wallThicknessMm = roundTo(
              Math.max(
                requirements.manufacturing.minWallThicknessMm,
                (requirements.performance.burnDurationSec / 40) *
                  requirements.safetyFactor *
                  material.thermalThicknessFactor
              ),
              0.1
            );

            const shellVolumeMm3 =
              Math.PI *
              ((exitDiameterMm / 2) ** 2 -
                Math.max(exitDiameterMm / 2 - wallThicknessMm, 1) ** 2) *
              lengthMm *
              0.42;

            const estimatedMassKg = (shellVolumeMm3 / 1_000_000) * material.densityGcc;

            const performanceScore = clamp(
              100 -
                Math.abs(expansionRatio - propellant.preferredExpansionRatio) * 1.4 -
                Math.abs(mixtureRatio - propellant.nominalMixtureRatio) * 6,
              0,
              100
            );

            const compactnessScore = clamp(
              100 -
                Math.max(0, lengthMm - requirements.envelope.maxLengthMm) * 0.6 -
                Math.max(0, exitDiameterMm - requirements.envelope.maxExitDiameterMm) * 0.8,
              0,
              100
            );

            const thermalScore = clamp(
              100 -
                Math.max(0, thermalWallC - material.maxServiceTempC) * 0.08 -
                Math.max(0, requirements.performance.burnDurationSec - material.nominalBurnLimitSec) *
                  0.3,
              0,
              100
            );

            const targetMass = requirements.objectives.targetMassKg;

            const massScore = targetMass
              ? clamp(100 - Math.abs(estimatedMassKg - targetMass) * 45, 0, 100)
              : clamp(100 - estimatedMassKg * 10, 0, 100);

            const manufacturabilityScore = clamp(
              100 -
                (requirements.manufacturing.process === "additive" ? 0 : 8) -
                (requirements.manufacturing.supportAllowed ? 3 : 12) -
                Math.max(0, wallThicknessMm - requirements.manufacturing.minWallThicknessMm * 2.6) *
                  3,
              0,
              100
            );

            const supportBurdenScore = clamp(
              100 - (requirements.manufacturing.supportAllowed ? 8 : 20) - expansionRatio * 0.25,
              0,
              100
            );

            const totalScore =
              requirements.objectives.priority === "efficiency"
                ? weightedAverage([
                    [performanceScore, 0.46],
                    [thermalScore, 0.22],
                    [compactnessScore, 0.12],
                    [manufacturabilityScore, 0.12],
                    [massScore, 0.08]
                  ])
                : requirements.objectives.priority === "compactness"
                  ? weightedAverage([
                      [compactnessScore, 0.42],
                      [performanceScore, 0.22],
                      [manufacturabilityScore, 0.14],
                      [thermalScore, 0.12],
                      [massScore, 0.1]
                    ])
                  : requirements.objectives.priority === "thermal-margin"
                    ? weightedAverage([
                        [thermalScore, 0.44],
                        [performanceScore, 0.22],
                        [manufacturabilityScore, 0.14],
                        [compactnessScore, 0.1],
                        [massScore, 0.1]
                      ])
                    : weightedAverage([
                        [performanceScore, 0.3],
                        [thermalScore, 0.25],
                        [compactnessScore, 0.18],
                        [manufacturabilityScore, 0.15],
                        [massScore, 0.12]
                      ]);

            const rejectionReasons: string[] = [];

            if (exitDiameterMm > requirements.envelope.maxExitDiameterMm) {
              rejectionReasons.push("Exit diameter exceeds envelope.");
            }

            if (lengthMm > requirements.envelope.maxLengthMm) {
              rejectionReasons.push("Nozzle length exceeds envelope.");
            }

            if (thermalWallC > material.maxServiceTempC * 1.08) {
              rejectionReasons.push("Estimated thermal wall temperature exceeds material limit.");
            }

            if (wallThicknessMm < requirements.manufacturing.minWallThicknessMm) {
              rejectionReasons.push("Wall thickness below manufacturing minimum.");
            }

            if (targetMass && estimatedMassKg > targetMass * 1.8) {
              rejectionReasons.push("Mass exceeds target mass tolerance.");
            }

            candidates.push({
              id: `bell_nozzle_cand_${String(index).padStart(3, "0")}`,
              family: "bell-nozzle",
              material: material.name,
              widthMm: roundTo(exitDiameterMm, 0.1),
              heightMm: roundTo(exitDiameterMm, 0.1),
              depthMm: roundTo(exitDiameterMm, 0.1),
              lengthMm: roundTo(lengthMm, 0.1),
              wallThicknessMm,
              estimatedMassKg: roundTo(estimatedMassKg, 0.001),
              estimatedStressMpa: roundTo(chamberPressureBar * 2.1 * requirements.safetyFactor, 0.01),
              estimatedDisplacementMm: roundTo(
                (lengthMm / Math.max(material.elasticModulusMpa, 1)) * 12,
                0.0001
              ),
              safetyFactorEstimate: roundTo(material.maxServiceTempC / Math.max(thermalWallC, 1), 0.01),
              manufacturabilityScore: roundTo(manufacturabilityScore, 0.1),
              supportBurdenScore: roundTo(supportBurdenScore, 0.1),
              performanceScore: roundTo(performanceScore, 0.1),
              totalScore: roundTo(totalScore, 0.1),
              rejected: rejectionReasons.length > 0,
              rejectionReasons,
              derivedParameters: {
                throatDiameterMm: roundTo(throatDiameterMm, 0.1),
                exitDiameterMm: roundTo(exitDiameterMm, 0.1),
                expansionRatio,
                chamberPressureBar,
                mixtureRatio,
                estimatedWallTemperatureC: roundTo(thermalWallC, 0.1),
                estimatedIspSec: roundTo(propellant.nominalIspSec + Math.log(expansionRatio) * 4, 0.1),
                coolingMode: requirements.thermal.coolingMode,
                oxidizer: requirements.propellant.oxidizer,
                fuel: requirements.propellant.fuel
              }
            });
          }
        }
      }
    }
  }

  return candidates;
}

function createEmergencyNozzleCandidate(requirements: BellNozzleRequirements): CandidateGeometry {
  return {
    id: "emergency_nozzle_candidate",
    family: "bell-nozzle",
    material: "Inconel 718",
    widthMm: requirements.envelope.maxExitDiameterMm,
    heightMm: requirements.envelope.maxExitDiameterMm,
    depthMm: requirements.envelope.maxExitDiameterMm,
    lengthMm: requirements.envelope.maxLengthMm,
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
    rejectionReasons: ["Emergency fallback nozzle candidate created because no generated candidates were available."],
    derivedParameters: {
      expansionRatio: 0,
      chamberPressureBar: requirements.performance.chamberPressureBar ?? 0,
      mixtureRatio: requirements.propellant.mixtureRatio ?? 0
    }
  };
}

// ==============================
// VALIDATION BUILDERS
// ==============================

function buildStructuralValidations(
  requirements: StructuralBracketRequirements,
  selected: CandidateGeometry,
  acceptedCount: number,
  baselineComparison: BaselineComparison
): ValidationMessage[] {
  const messages: ValidationMessage[] = [];

  messages.push({
    severity: acceptedCount > 0 ? "success" : "warning",
    title: acceptedCount > 0 ? "Candidate Search Complete" : "Fallback Candidate Selected",
    text:
      acceptedCount > 0
        ? `${acceptedCount} candidates satisfied the first-pass load, envelope, manufacturability, and support-burden filters.`
        : "No candidates fully satisfied all filters. The best-scoring fallback candidate was selected for review."
  });

  messages.push({
    severity: selected.safetyFactorEstimate >= requirements.safetyFactor ? "success" : "warning",
    title: "Safety Factor Estimate",
    text: `Estimated safety factor ${selected.safetyFactorEstimate.toFixed(
      2
    )} against required ${requirements.safetyFactor.toFixed(2)}.`
  });

  messages.push({
    severity: selected.manufacturabilityScore >= 70 ? "success" : "warning",
    title: "Manufacturability Filter",
    text: `Manufacturability score ${selected.manufacturabilityScore.toFixed(
      1
    )}/100 using ${requirements.manufacturing.process} constraints.`
  });

  messages.push({
    severity: baselineComparison.avoidedSimulationRuns > 0 ? "success" : "warning",
    title: "Baseline Comparison",
    text: `Constraint-filtered generation avoided ${
      baselineComparison.avoidedSimulationRuns
    } estimated simulation runs compared with the unconstrained baseline, reducing simulation load by ${baselineComparison.reductionInSimulationLoadPercent.toFixed(
      1
    )}%.`
  });

  messages.push({
    severity: selected.supportBurdenScore >= 65 ? "success" : "warning",
    title: "Support Burden Review",
    text: `Support burden score ${selected.supportBurdenScore.toFixed(
      1
    )}/100. This is a first-pass additive manufacturing readiness estimate, not final print qualification.`
  });

  if (requirements.loadCase.vibrationHz) {
    messages.push({
      severity: "success",
      title: "Vibration Requirement Included",
      text: `${requirements.loadCase.vibrationHz} Hz vibration requirement was included in load amplification.`
    });
  }

  return messages;
}

function buildBellNozzleValidations(
  requirements: BellNozzleRequirements,
  selected: CandidateGeometry,
  acceptedCount: number
): ValidationMessage[] {
  const messages: ValidationMessage[] = [];

  messages.push({
    severity: acceptedCount > 0 ? "success" : "warning",
    title: acceptedCount > 0 ? "Nozzle Candidate Search Complete" : "Fallback Nozzle Selected",
    text:
      acceptedCount > 0
        ? `${acceptedCount} nozzle candidates satisfied thrust, envelope, thermal, and manufacturability filters.`
        : "No nozzle candidates fully satisfied all filters. The best-scoring fallback candidate was selected for review."
  });

  messages.push({
    severity:
      selected.lengthMm <= requirements.envelope.maxLengthMm &&
      selected.widthMm <= requirements.envelope.maxExitDiameterMm
        ? "success"
        : "warning",
    title: "Envelope Check",
    text: `Selected nozzle is ${selected.lengthMm.toFixed(1)} mm long with ${selected.widthMm.toFixed(
      1
    )} mm exit diameter.`
  });

  messages.push({
    severity: selected.safetyFactorEstimate >= 1 ? "success" : "warning",
    title: "Thermal Margin Estimate",
    text: `Thermal margin ratio estimated at ${selected.safetyFactorEstimate.toFixed(2)}.`
  });

  messages.push({
    severity: "success",
    title: "Propellant Model Applied",
    text: `${requirements.propellant.oxidizer}/${requirements.propellant.fuel} assumptions were used for first-pass nozzle sizing.`
  });

  return messages;
}

// ==============================
// MATERIAL / PHYSICS HELPERS
// ==============================

type StructuralMaterial = {
  name: string;
  densityGcc: number;
  allowableStressMpa: number;
  elasticModulusMpa: number;
};

type NozzleMaterial = {
  name: string;
  densityGcc: number;
  elasticModulusMpa: number;
  maxServiceTempC: number;
  thermalThicknessFactor: number;
  nominalBurnLimitSec: number;
};

function selectStructuralMaterialOptions(requirements: StructuralBracketRequirements): StructuralMaterial[] {
  const base: StructuralMaterial[] = [
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
    return [base[0], base[1], base[2]];
  }

  if (requirements.objectives.priority === "stiffness") {
    return [base[1], base[2], base[0]];
  }

  return base;
}

function selectNozzleMaterialOptions(requirements: BellNozzleRequirements): NozzleMaterial[] {
  const materials: NozzleMaterial[] = [
    {
      name: "Inconel 718",
      densityGcc: 8.19,
      elasticModulusMpa: 200_000,
      maxServiceTempC: 700,
      thermalThicknessFactor: 2.4,
      nominalBurnLimitSec: 45
    },
    {
      name: "GRCop-42",
      densityGcc: 8.85,
      elasticModulusMpa: 125_000,
      maxServiceTempC: 820,
      thermalThicknessFactor: 1.8,
      nominalBurnLimitSec: 120
    },
    {
      name: "C103 Niobium Alloy",
      densityGcc: 8.89,
      elasticModulusMpa: 105_000,
      maxServiceTempC: 1200,
      thermalThicknessFactor: 1.6,
      nominalBurnLimitSec: 240
    }
  ];

  if (requirements.thermal.coolingMode === "regenerative") {
    return [materials[1], materials[0], materials[2]];
  }

  if (requirements.thermal.coolingMode === "radiative") {
    return [materials[2], materials[0], materials[1]];
  }

  return materials;
}

function resolvePropellantModel(requirements: BellNozzleRequirements) {
  const key = `${requirements.propellant.oxidizer}/${requirements.propellant.fuel}`;

  const models: Record<
    string,
    {
      nominalIspSec: number;
      nominalFlameTemperatureC: number;
      nominalMixtureRatio: number;
      defaultMixtureRatios: number[];
      temperatureSlope: number;
      preferredExpansionRatio: number;
    }
  > = {
    "LOX/RP1": {
      nominalIspSec: 285,
      nominalFlameTemperatureC: 3350,
      nominalMixtureRatio: 2.6,
      defaultMixtureRatios: [2.3, 2.6, 2.8],
      temperatureSlope: 180,
      preferredExpansionRatio: 18
    },
    "LOX/CH4": {
      nominalIspSec: 315,
      nominalFlameTemperatureC: 3300,
      nominalMixtureRatio: 3.4,
      defaultMixtureRatios: [3.1, 3.4, 3.7],
      temperatureSlope: 140,
      preferredExpansionRatio: 24
    },
    "LOX/H2": {
      nominalIspSec: 390,
      nominalFlameTemperatureC: 3000,
      nominalMixtureRatio: 5.5,
      defaultMixtureRatios: [5.0, 5.5, 6.0],
      temperatureSlope: 90,
      preferredExpansionRatio: 32
    },
    "N2O/HTPB": {
      nominalIspSec: 235,
      nominalFlameTemperatureC: 2850,
      nominalMixtureRatio: 6.5,
      defaultMixtureRatios: [5.8, 6.5, 7.2],
      temperatureSlope: 75,
      preferredExpansionRatio: 12
    }
  };

  return (
    models[key] ?? {
      nominalIspSec: 245,
      nominalFlameTemperatureC: 2900,
      nominalMixtureRatio: 4.5,
      defaultMixtureRatios: [4.0, 4.5, 5.0],
      temperatureSlope: 100,
      preferredExpansionRatio: 12
    }
  );
}

function estimateThrustCoefficient(
  expansionRatio: number,
  ambientPressurePa: number,
  chamberPressurePa: number
) {
  const pressureRatio = chamberPressurePa / Math.max(ambientPressurePa, 1);
  const expansionBenefit = 1.18 + Math.log(expansionRatio) * 0.075;
  const ambientPenalty = clamp(ambientPressurePa / chamberPressurePa, 0, 0.18);
  const pressureBenefit = clamp(Math.log10(pressureRatio) * 0.08, 0, 0.16);

  return clamp(expansionBenefit + pressureBenefit - ambientPenalty, 1.05, 1.85);
}

function estimateComputeBurn(evaluated: number, accepted: number) {
  return Math.max(1, Math.ceil(evaluated / 35) + Math.max(0, 3 - accepted));
}

function weightedAverage(items: Array<[number, number]>) {
  const totalWeight = items.reduce((sum, [, weight]) => sum + weight, 0);

  if (totalWeight <= 0) {
    return 0;
  }

  return items.reduce((sum, [value, weight]) => sum + value * weight, 0) / totalWeight;
}

function clamp(value: number, min: number, max) {
  return Math.min(max, Math.max(min, value));
}

function roundTo(value: number, step: number) {
  return Math.round(value / step) * step;
}
