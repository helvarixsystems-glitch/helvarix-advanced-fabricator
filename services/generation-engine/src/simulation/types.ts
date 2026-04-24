export type SimulationDomain =
  | "structural"
  | "thermal"
  | "manufacturability"
  | "cfd"
  | "combined";

export type SimulationStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "skipped";

export type SolverMode =
  | "internal-fast-estimate"
  | "calculix"
  | "fenics"
  | "openfoam"
  | "su2"
  | "external";

export type LoadKind =
  | "force"
  | "pressure"
  | "gravity"
  | "torque"
  | "thermal-gradient"
  | "fixed-support";

export type Axis = "x" | "y" | "z";

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface MaterialSpec {
  id: string;
  name: string;

  densityKgM3: number;
  youngsModulusPa: number;
  poissonRatio: number;
  yieldStrengthPa: number;
  ultimateStrengthPa?: number;

  thermalConductivityWMK?: number;
  thermalExpansion1K?: number;
  specificHeatJkgK?: number;

  printable?: boolean;
  notes?: string;
}

export interface SimulationGeometryInput {
  id: string;
  name: string;

  /**
   * Geometry can start simple.
   * Later this can point to generated STL/STEP/OBJ files.
   */
  primitive?: "bracket" | "beam" | "plate" | "shell" | "custom";

  boundingBoxMm: Vec3;
  volumeMm3?: number;
  surfaceAreaMm2?: number;
  massKg?: number;

  meshFileUrl?: string;
  stlFileUrl?: string;
  stepFileUrl?: string;

  metadata?: Record<string, unknown>;
}

export interface SimulationLoad {
  id: string;
  kind: LoadKind;
  label: string;

  magnitude: number;
  unit: "N" | "Pa" | "Nm" | "m/s^2" | "C" | "K" | "none";

  direction?: Vec3;
  location?: Vec3;

  /**
   * Used for simple region tagging until real mesh groups exist.
   * Examples: "mounting-face", "tip", "top-surface"
   */
  targetRegion?: string;
}

export interface BoundaryCondition {
  id: string;
  label: string;
  kind: "fixed" | "pinned" | "roller" | "symmetry" | "custom";
  targetRegion: string;
  lockedAxes?: Axis[];
}

export interface MeshSettings {
  targetElementSizeMm: number;
  refinementLevel: 0 | 1 | 2 | 3 | 4 | 5;
  minElementSizeMm?: number;
  maxElementSizeMm?: number;
  boundaryLayer?: boolean;
  qualityTarget?: number;
}

export interface StructuralSimulationSettings {
  enabled: boolean;
  solver: SolverMode;
  safetyFactorTarget: number;
  maxAllowableDisplacementMm?: number;
  mesh: MeshSettings;
  loads: SimulationLoad[];
  boundaryConditions: BoundaryCondition[];
}

export interface ThermalSimulationSettings {
  enabled: boolean;
  solver: SolverMode;

  ambientTemperatureC: number;
  buildPlateTemperatureC?: number;
  peakProcessTemperatureC?: number;
  coolingRateCPerSec?: number;

  /**
   * Fast approximation setting for additive manufacturing distortion.
   */
  distortionSensitivity?: number;
}

export interface ManufacturabilitySettings {
  enabled: boolean;

  process:
    | "fdm"
    | "sla"
    | "sls"
    | "slm"
    | "dmls"
    | "ebm"
    | "cnc"
    | "unknown";

  maxOverhangDeg: number;
  minWallThicknessMm: number;
  minFeatureSizeMm: number;

  preferredBuildAxis: Axis;
  allowSupports: boolean;
  supportPenaltyWeight: number;

  maxBuildVolumeMm?: Vec3;
}

export interface CfdSimulationSettings {
  enabled: boolean;
  solver: SolverMode;

  fluid: "air" | "water" | "methane" | "oxygen" | "custom";
  velocityMS: number;
  densityKgM3?: number;
  dynamicViscosityPaS?: number;

  angleOfAttackDeg?: number;
  referenceAreaM2?: number;
}

export interface SimulationRequest {
  id: string;
  createdAtIso: string;

  domain: SimulationDomain;

  geometry: SimulationGeometryInput;
  material: MaterialSpec;

  structural?: StructuralSimulationSettings;
  thermal?: ThermalSimulationSettings;
  manufacturability?: ManufacturabilitySettings;
  cfd?: CfdSimulationSettings;

  tags?: string[];
  metadata?: Record<string, unknown>;
}

export interface StructuralResult {
  status: SimulationStatus;

  maxVonMisesStressPa: number;
  maxDisplacementMm: number;
  estimatedSafetyFactor: number;

  pass: boolean;
  warnings: string[];

  solver: SolverMode;
}

export interface ThermalResult {
  status: SimulationStatus;

  estimatedMaxTemperatureC: number;
  estimatedThermalExpansionMm: number;
  estimatedDistortionMm: number;

  pass: boolean;
  warnings: string[];

  solver: SolverMode;
}

export interface ManufacturabilityResult {
  status: SimulationStatus;

  overhangPass: boolean;
  wallThicknessPass: boolean;
  buildVolumePass: boolean;
  supportRequired: boolean;

  estimatedSupportVolumeMm3: number;
  manufacturabilityScore: number;

  pass: boolean;
  warnings: string[];
}

export interface CfdResult {
  status: SimulationStatus;

  estimatedDragN: number;
  estimatedLiftN: number;
  estimatedPressurePa: number;
  reynoldsNumber?: number;

  pass: boolean;
  warnings: string[];

  solver: SolverMode;
}

export interface SimulationScoreBreakdown {
  structural: number;
  thermal: number;
  manufacturability: number;
  cfd: number;
  mass: number;
  total: number;
}

export interface SimulationResult {
  id: string;
  requestId: string;
  completedAtIso: string;

  status: SimulationStatus;

  structural?: StructuralResult;
  thermal?: ThermalResult;
  manufacturability?: ManufacturabilityResult;
  cfd?: CfdResult;

  score: SimulationScoreBreakdown;

  summary: string;
  warnings: string[];
  errors: string[];

  artifacts: SimulationArtifact[];
}

export interface SimulationArtifact {
  id: string;
  kind:
    | "mesh"
    | "solver-input"
    | "solver-output"
    | "stress-map"
    | "displacement-map"
    | "thermal-map"
    | "cfd-field"
    | "report"
    | "json";

  label: string;
  url?: string;
  inlineText?: string;
  metadata?: Record<string, unknown>;
}
