import {
  BoundaryCondition,
  ManufacturabilitySettings,
  MeshSettings,
  SimulationLoad,
  SimulationRequest,
  StructuralSimulationSettings,
  ThermalSimulationSettings,
  CfdSimulationSettings,
  SimulationGeometryInput,
} from "./types";
import { getMaterial } from "./materials";

export function createDefaultBracketSimulationRequest(
  overrides?: Partial<SimulationRequest>
): SimulationRequest {
  const geometry: SimulationGeometryInput = {
    id: "demo_bracket_geometry",
    name: "Representative Aerospace Bracket",
    primitive: "bracket",

    boundingBoxMm: {
      x: 120,
      y: 80,
      z: 35,
    },

    volumeMm3: 120 * 80 * 35 * 0.32,
  };

  const mesh: MeshSettings = {
    targetElementSizeMm: 4,
    refinementLevel: 2,
    minElementSizeMm: 1.5,
    maxElementSizeMm: 8,
    boundaryLayer: false,
    qualityTarget: 0.72,
  };

  const loads: SimulationLoad[] = [
    {
      id: "tip_load_downward",
      kind: "force",
      label: "Downward payload load",
      magnitude: 850,
      unit: "N",
      direction: {
        x: 0,
        y: -1,
        z: 0,
      },
      targetRegion: "outer-mounting-face",
    },
    {
      id: "gravity_load",
      kind: "gravity",
      label: "Gravity",
      magnitude: 9.81,
      unit: "m/s^2",
      direction: {
        x: 0,
        y: -1,
        z: 0,
      },
    },
  ];

  const boundaryConditions: BoundaryCondition[] = [
    {
      id: "fixed_base",
      label: "Fixed base mounting face",
      kind: "fixed",
      targetRegion: "base-mounting-face",
      lockedAxes: ["x", "y", "z"],
    },
  ];

  const structural: StructuralSimulationSettings = {
    enabled: true,
    solver: "internal-fast-estimate",
    safetyFactorTarget: 2.0,
    maxAllowableDisplacementMm: 2.5,
    mesh,
    loads,
    boundaryConditions,
  };

  const thermal: ThermalSimulationSettings = {
    enabled: true,
    solver: "internal-fast-estimate",
    ambientTemperatureC: 22,
    buildPlateTemperatureC: 80,
    peakProcessTemperatureC: 420,
    coolingRateCPerSec: 35,
    distortionSensitivity: 0.3,
  };

  const manufacturability: ManufacturabilitySettings = {
    enabled: true,
    process: "slm",
    maxOverhangDeg: 45,
    minWallThicknessMm: 1.2,
    minFeatureSizeMm: 0.8,
    preferredBuildAxis: "z",
    allowSupports: true,
    supportPenaltyWeight: 0.18,
    maxBuildVolumeMm: {
      x: 250,
      y: 250,
      z: 300,
    },
  };

  const cfd: CfdSimulationSettings = {
    enabled: false,
    solver: "internal-fast-estimate",
    fluid: "air",
    velocityMS: 40,
    angleOfAttackDeg: 0,
  };

  return {
    id: `sim_request_${Math.random().toString(36).slice(2, 10)}`,
    createdAtIso: new Date().toISOString(),

    domain: "combined",

    geometry,
    material: getMaterial("titanium_ti6al4v"),

    structural,
    thermal,
    manufacturability,
    cfd,

    tags: ["demo", "aerospace-bracket", "phase-i"],
    metadata: {
      source: "default-bracket-template",
      description:
        "Default simulation request for a single representative aerospace bracket.",
    },

    ...overrides,
  };
}

export function createLightweightAluminumBracketRequest(): SimulationRequest {
  return createDefaultBracketSimulationRequest({
    id: `sim_request_aluminum_${Math.random().toString(36).slice(2, 10)}`,
    material: getMaterial("aluminum_6061_t6"),
    metadata: {
      source: "default-aluminum-bracket-template",
      description:
        "Lightweight aluminum bracket simulation preset for fast comparison.",
    },
  });
}

export function createHighStrengthInconelBracketRequest(): SimulationRequest {
  return createDefaultBracketSimulationRequest({
    id: `sim_request_inconel_${Math.random().toString(36).slice(2, 10)}`,
    material: getMaterial("inconel_718"),
    metadata: {
      source: "default-inconel-bracket-template",
      description:
        "High-strength Inconel bracket simulation preset for harsh environments.",
    },
  });
}
