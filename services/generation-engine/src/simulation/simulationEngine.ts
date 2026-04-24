import {
  SimulationRequest,
  SimulationResult,
  StructuralResult,
  ThermalResult,
  ManufacturabilityResult,
  CfdResult,
  SimulationScoreBreakdown,
} from "./types";
import {
  estimateMassFromVolume,
  estimateThermalExpansion,
} from "./materials";

const clamp = (value: number, min: number, max: number): number => {
  return Math.max(min, Math.min(max, value));
};

const nowIso = (): string => new Date().toISOString();

export async function runSimulation(
  request: SimulationRequest
): Promise<SimulationResult> {
  const warnings: string[] = [];
  const errors: string[] = [];

  let structural: StructuralResult | undefined;
  let thermal: ThermalResult | undefined;
  let manufacturability: ManufacturabilityResult | undefined;
  let cfd: CfdResult | undefined;

  try {
    if (request.structural?.enabled) {
      structural = runFastStructuralEstimate(request);
      warnings.push(...structural.warnings);
    }

    if (request.thermal?.enabled) {
      thermal = runFastThermalEstimate(request);
      warnings.push(...thermal.warnings);
    }

    if (request.manufacturability?.enabled) {
      manufacturability = runManufacturabilityEstimate(request);
      warnings.push(...manufacturability.warnings);
    }

    if (request.cfd?.enabled) {
      cfd = runFastCfdEstimate(request);
      warnings.push(...cfd.warnings);
    }
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err));
  }

  const score = calculateSimulationScore({
    request,
    structural,
    thermal,
    manufacturability,
    cfd,
  });

  const failed =
    errors.length > 0 ||
    structural?.pass === false ||
    thermal?.pass === false ||
    manufacturability?.pass === false ||
    cfd?.pass === false;

  return {
    id: `sim_result_${cryptoSafeId()}`,
    requestId: request.id,
    completedAtIso: nowIso(),

    status: failed ? "failed" : "completed",

    structural,
    thermal,
    manufacturability,
    cfd,

    score,

    summary: buildSimulationSummary({
      structural,
      thermal,
      manufacturability,
      cfd,
      score,
      errors,
    }),

    warnings,
    errors,

    artifacts: [
      {
        id: `artifact_${cryptoSafeId()}`,
        kind: "json",
        label: "Simulation Result JSON",
        inlineText: JSON.stringify(
          {
            requestId: request.id,
            score,
            structural,
            thermal,
            manufacturability,
            cfd,
            warnings,
            errors,
          },
          null,
          2
        ),
      },
    ],
  };
}

function runFastStructuralEstimate(
  request: SimulationRequest
): StructuralResult {
  const structural = request.structural;

  if (!structural) {
    throw new Error("Structural settings missing.");
  }

  const material = request.material;
  const geometry = request.geometry;

  const bbox = geometry.boundingBoxMm;
  const lengthMm = Math.max(bbox.x, bbox.y, bbox.z);
  const thicknessProxyMm = Math.max(1, Math.min(bbox.x, bbox.y, bbox.z) * 0.18);

  const totalForceN = structural.loads
    .filter((load) => load.kind === "force" || load.kind === "gravity")
    .reduce((sum, load) => sum + Math.abs(load.magnitude), 0);

  const effectiveAreaMm2 = Math.max(1, bbox.x * thicknessProxyMm);
  const effectiveAreaM2 = effectiveAreaMm2 / 1e6;

  const stressPa =
    effectiveAreaM2 > 0 ? totalForceN / effectiveAreaM2 : Number.POSITIVE_INFINITY;

  const stiffnessNPerM =
    (material.youngsModulusPa * effectiveAreaM2) / Math.max(lengthMm / 1000, 0.001);

  const displacementM = stiffnessNPerM > 0 ? totalForceN / stiffnessNPerM : 0;
  const displacementMm = displacementM * 1000;

  const safetyFactor =
    stressPa > 0 ? material.yieldStrengthPa / stressPa : Number.POSITIVE_INFINITY;

  const warnings: string[] = [];

  if (structural.solver !== "internal-fast-estimate") {
    warnings.push(
      `Solver "${structural.solver}" requested, but internal fast estimate was used. External solver adapter will be added in a later file.`
    );
  }

  if (structural.boundaryConditions.length === 0) {
    warnings.push("No boundary conditions were provided.");
  }

  if (structural.loads.length === 0) {
    warnings.push("No structural loads were provided.");
  }

  if (safetyFactor < structural.safetyFactorTarget) {
    warnings.push(
      `Safety factor ${safetyFactor.toFixed(
        2
      )} is below target ${structural.safetyFactorTarget.toFixed(2)}.`
    );
  }

  if (
    structural.maxAllowableDisplacementMm !== undefined &&
    displacementMm > structural.maxAllowableDisplacementMm
  ) {
    warnings.push(
      `Estimated displacement ${displacementMm.toFixed(
        3
      )} mm exceeds allowable ${structural.maxAllowableDisplacementMm.toFixed(3)} mm.`
    );
  }

  return {
    status: "completed",

    maxVonMisesStressPa: stressPa,
    maxDisplacementMm: displacementMm,
    estimatedSafetyFactor: safetyFactor,

    pass:
      safetyFactor >= structural.safetyFactorTarget &&
      (structural.maxAllowableDisplacementMm === undefined ||
        displacementMm <= structural.maxAllowableDisplacementMm),

    warnings,
    solver: "internal-fast-estimate",
  };
}

function runFastThermalEstimate(request: SimulationRequest): ThermalResult {
  const thermal = request.thermal;

  if (!thermal) {
    throw new Error("Thermal settings missing.");
  }

  const material = request.material;
  const geometry = request.geometry;

  const bbox = geometry.boundingBoxMm;
  const longestDimensionMm = Math.max(bbox.x, bbox.y, bbox.z);

  const ambient = thermal.ambientTemperatureC;
  const peak = thermal.peakProcessTemperatureC ?? ambient;
  const deltaTempC = Math.max(0, peak - ambient);

  const expansionMm = estimateThermalExpansion(
    longestDimensionMm,
    deltaTempC,
    material
  );

  const sensitivity = thermal.distortionSensitivity ?? 0.35;
  const coolingPenalty =
    thermal.coolingRateCPerSec !== undefined
      ? clamp(thermal.coolingRateCPerSec / 100, 0, 2)
      : 1;

  const distortionMm = expansionMm * sensitivity * coolingPenalty;

  const warnings: string[] = [];

  if (thermal.solver !== "internal-fast-estimate") {
    warnings.push(
      `Solver "${thermal.solver}" requested, but internal fast thermal estimate was used.`
    );
  }

  if (!material.thermalExpansion1K) {
    warnings.push("Material has no thermal expansion coefficient.");
  }

  return {
    status: "completed",

    estimatedMaxTemperatureC: peak,
    estimatedThermalExpansionMm: expansionMm,
    estimatedDistortionMm: distortionMm,

    pass: distortionMm < longestDimensionMm * 0.03,

    warnings,
    solver: "internal-fast-estimate",
  };
}

function runManufacturabilityEstimate(
  request: SimulationRequest
): ManufacturabilityResult {
  const settings = request.manufacturability;

  if (!settings) {
    throw new Error("Manufacturability settings missing.");
  }

  const geometry = request.geometry;
  const bbox = geometry.boundingBoxMm;

  const volume = geometry.volumeMm3 ?? bbox.x * bbox.y * bbox.z * 0.25;

  const minDimension = Math.min(bbox.x, bbox.y, bbox.z);
  const maxDimension = Math.max(bbox.x, bbox.y, bbox.z);

  const wallThicknessPass = minDimension >= settings.minWallThicknessMm;
  const buildVolumePass = settings.maxBuildVolumeMm
    ? bbox.x <= settings.maxBuildVolumeMm.x &&
      bbox.y <= settings.maxBuildVolumeMm.y &&
      bbox.z <= settings.maxBuildVolumeMm.z
    : true;

  /**
   * Placeholder overhang proxy:
   * High slenderness tends to increase unsupported feature risk.
   */
  const slenderness = maxDimension / Math.max(minDimension, 1);
  const overhangRisk = clamp((slenderness - 2) / 8, 0, 1);
  const overhangPass = overhangRisk < settings.maxOverhangDeg / 90;

  const supportRequired = !overhangPass || slenderness > 4;
  const estimatedSupportVolumeMm3 = supportRequired
    ? volume * clamp(settings.supportPenaltyWeight, 0.05, 0.75)
    : 0;

  const rawScore =
    100 -
    overhangRisk * 35 -
    (!wallThicknessPass ? 25 : 0) -
    (!buildVolumePass ? 40 : 0) -
    (supportRequired ? 15 : 0);

  const manufacturabilityScore = clamp(rawScore, 0, 100);

  const warnings: string[] = [];

  if (!overhangPass) {
    warnings.push("Estimated overhang risk exceeds configured threshold.");
  }

  if (!wallThicknessPass) {
    warnings.push("Minimum bounding dimension is below minimum wall thickness.");
  }

  if (!buildVolumePass) {
    warnings.push("Part exceeds configured build volume.");
  }

  if (supportRequired && !settings.allowSupports) {
    warnings.push("Supports appear required, but supports are disabled.");
  }

  return {
    status: "completed",

    overhangPass,
    wallThicknessPass,
    buildVolumePass,
    supportRequired,

    estimatedSupportVolumeMm3,
    manufacturabilityScore,

    pass:
      overhangPass &&
      wallThicknessPass &&
      buildVolumePass &&
      (!supportRequired || settings.allowSupports),

    warnings,
  };
}

function runFastCfdEstimate(request: SimulationRequest): CfdResult {
  const cfd = request.cfd;

  if (!cfd) {
    throw new Error("CFD settings missing.");
  }

  const geometry = request.geometry;
  const bbox = geometry.boundingBoxMm;

  const velocity = cfd.velocityMS;
  const density = cfd.densityKgM3 ?? defaultFluidDensity(cfd.fluid);
  const viscosity = cfd.dynamicViscosityPaS ?? defaultFluidViscosity(cfd.fluid);

  const referenceAreaM2 =
    cfd.referenceAreaM2 ?? Math.max(0.000001, (bbox.x * bbox.z) / 1e6);

  const characteristicLengthM = Math.max(bbox.x, bbox.y, bbox.z) / 1000;

  const angle = Math.abs(cfd.angleOfAttackDeg ?? 0);
  const dragCoefficient = clamp(0.5 + angle / 90, 0.3, 2.0);
  const liftCoefficient = clamp(angle / 20, 0, 1.5);

  const dynamicPressure = 0.5 * density * velocity * velocity;
  const drag = dynamicPressure * referenceAreaM2 * dragCoefficient;
  const lift = dynamicPressure * referenceAreaM2 * liftCoefficient;

  const reynoldsNumber =
    viscosity > 0 ? (density * velocity * characteristicLengthM) / viscosity : undefined;

  const warnings: string[] = [];

  if (cfd.solver !== "internal-fast-estimate") {
    warnings.push(
      `Solver "${cfd.solver}" requested, but internal fast CFD estimate was used.`
    );
  }

  return {
    status: "completed",

    estimatedDragN: drag,
    estimatedLiftN: lift,
    estimatedPressurePa: dynamicPressure,
    reynoldsNumber,

    pass: Number.isFinite(drag) && Number.isFinite(lift),

    warnings,
    solver: "internal-fast-estimate",
  };
}

function calculateSimulationScore(input: {
  request: SimulationRequest;
  structural?: StructuralResult;
  thermal?: ThermalResult;
  manufacturability?: ManufacturabilityResult;
  cfd?: CfdResult;
}): SimulationScoreBreakdown {
  const { request, structural, thermal, manufacturability, cfd } = input;

  const structuralScore = structural
    ? clamp((structural.estimatedSafetyFactor / 3) * 100, 0, 100)
    : 100;

  const thermalScore = thermal
    ? clamp(100 - thermal.estimatedDistortionMm * 10, 0, 100)
    : 100;

  const manufacturabilityScore = manufacturability
    ? manufacturability.manufacturabilityScore
    : 100;

  const cfdScore = cfd ? clamp(100 - cfd.estimatedDragN * 0.5, 0, 100) : 100;

  const massKg =
    request.geometry.massKg ??
    (request.geometry.volumeMm3
      ? estimateMassFromVolume(request.geometry.volumeMm3, request.material)
      : 0);

  const massScore = massKg > 0 ? clamp(100 - massKg * 8, 0, 100) : 75;

  const total =
    structuralScore * 0.35 +
    thermalScore * 0.15 +
    manufacturabilityScore * 0.25 +
    cfdScore * 0.1 +
    massScore * 0.15;

  return {
    structural: round(structuralScore),
    thermal: round(thermalScore),
    manufacturability: round(manufacturabilityScore),
    cfd: round(cfdScore),
    mass: round(massScore),
    total: round(total),
  };
}

function buildSimulationSummary(input: {
  structural?: StructuralResult;
  thermal?: ThermalResult;
  manufacturability?: ManufacturabilityResult;
  cfd?: CfdResult;
  score: SimulationScoreBreakdown;
  errors: string[];
}): string {
  if (input.errors.length > 0) {
    return `Simulation completed with errors. Total score: ${input.score.total}/100.`;
  }

  const parts: string[] = [`Simulation completed. Total score: ${input.score.total}/100.`];

  if (input.structural) {
    parts.push(
      `Structural SF=${safeFixed(input.structural.estimatedSafetyFactor, 2)}, displacement=${safeFixed(
        input.structural.maxDisplacementMm,
        3
      )} mm.`
    );
  }

  if (input.thermal) {
    parts.push(
      `Thermal distortion=${safeFixed(
        input.thermal.estimatedDistortionMm,
        3
      )} mm.`
    );
  }

  if (input.manufacturability) {
    parts.push(
      `Manufacturability=${safeFixed(
        input.manufacturability.manufacturabilityScore,
        1
      )}/100.`
    );
  }

  if (input.cfd) {
    parts.push(`Estimated drag=${safeFixed(input.cfd.estimatedDragN, 2)} N.`);
  }

  return parts.join(" ");
}

function defaultFluidDensity(fluid: string): number {
  switch (fluid) {
    case "water":
      return 997;
    case "methane":
      return 0.657;
    case "oxygen":
      return 1.429;
    case "air":
    default:
      return 1.225;
  }
}

function defaultFluidViscosity(fluid: string): number {
  switch (fluid) {
    case "water":
      return 0.001;
    case "methane":
      return 1.1e-5;
    case "oxygen":
      return 2.05e-5;
    case "air":
    default:
      return 1.81e-5;
  }
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function safeFixed(value: number, digits: number): string {
  if (!Number.isFinite(value)) return "∞";
  return value.toFixed(digits);
}

function cryptoSafeId(): string {
  return Math.random().toString(36).slice(2, 10);
}
