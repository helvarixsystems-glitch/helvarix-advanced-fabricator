// packages/schemas/src/index.ts

export type ComponentFamily =
  | "structural-bracket"
  | "bell-nozzle"
  | "pressure-vessel"
  | "rover-arm"
  | "grid-fin";

/**
 * =========================
 * REQUIREMENTS
 * =========================
 */

export interface BaseRequirements {
  componentName: string;
  safetyFactor: number;
  targetMassKg?: number;
  optimizationPriority: "mass" | "strength" | "balanced";
}

/**
 * Structural Bracket
 */
export interface StructuralBracketRequirements extends BaseRequirements {
  family: "structural-bracket";

  requiredLoadN: number;
  loadDirection: "x" | "y" | "z";
  vibrationHz: number;

  boltCount: number;
  boltDiameterMm: number;
  boltSpacingMm: number;

  maxWidthMm: number;
  maxHeightMm: number;
  maxDepthMm: number;

  minWallThicknessMm: number;
  maxOverhangDeg: number;
}

/**
 * Bell Nozzle
 */
export interface BellNozzleRequirements extends BaseRequirements {
  family: "bell-nozzle";

  targetThrustN: number;
  burnDurationSec: number;

  chamberPressureBar: number;
  ambientPressurePa: number;

  oxidizer: string;
  fuel: string;
  mixtureRatio: number;

  coolingMode: "ablative" | "regenerative" | "film";

  maxLengthMm: number;
  maxExitDiameterMm: number;

  minWallThicknessMm: number;
}

/**
 * TEMP fallback for unfinished families
 */
export type GenericStructuralRequirements =
  StructuralBracketRequirements;

/**
 * =========================
 * INPUT
 * =========================
 */

export type GenerationInput =
  | StructuralBracketRequirements
  | BellNozzleRequirements
  | GenericStructuralRequirements;

/**
 * =========================
 * CANDIDATE GEOMETRY
 * =========================
 */

export interface CandidateGeometry {
  id: string;
  family: ComponentFamily;

  material: string;

  widthMm?: number;
  heightMm?: number;
  depthMm?: number;
  lengthMm?: number;

  wallThicknessMm: number;

  estimatedMassKg: number;
  estimatedStressMpa?: number;
  estimatedDisplacementMm?: number;

  safetyFactorEstimate: number;

  manufacturabilityScore: number;
  supportBurdenScore: number;
  performanceScore: number;
  totalScore: number;

  rejected: boolean;
  rejectionReasons: string[];

  derivedParameters: Record<string, any>;
}

/**
 * =========================
 * RESULT
 * =========================
 */

export interface GenerationResult {
  revision: string;

  estimatedMassKg: number;

  estimatedBurn?: {
    burnDurationSec: number;
    estimatedIspSec: number;
  };

  geometryPreview: {
    family: ComponentFamily;
    dimensions: Record<string, number>;
  };

  derivedGeometry: Record<string, any>;

  validations: string[];

  candidatesEvaluated: number;
  candidatesAccepted: number;
  candidatesRejected: number;

  selectedCandidate: CandidateGeometry | null;
  rejectedCandidates: CandidateGeometry[];

  exportState: {
    canExport: boolean;
    formats: string[];
  };
}
