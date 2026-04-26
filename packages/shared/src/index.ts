// ==============================
// SHARED CORE TYPES
// ==============================

export type ComponentFamily =
  | "structural-bracket"
  | "bell-nozzle"
  | "pressure-vessel"
  | "rover-arm"
  | "grid-fin";

export type ValidationSeverity = "success" | "warning" | "error";

export type ValidationMessage = {
  severity: ValidationSeverity;
  title: string;
  text: string;
};

// ==============================
// APP METADATA
// ==============================

export const appName = "Helvarix Advanced Fabricator";

export function formatTimestamp(value: string | number | Date) {
  try {
    return new Date(value).toLocaleString();
  } catch {
    return "—";
  }
}

// ==============================
// PROJECT / CREDIT / EXPORT TYPES
// ==============================

export type CreditBalance = {
  available: number;
  reserved: number;
};

export type ProjectSummary = {
  id: string;
  name: string;
  componentFamily: ComponentFamily;
  workspaceLabel: string;
  createdAt: string;
  updatedAt: string;
};

export type ExportRecord = {
  id: string;
  generationId: string;
  status: "queued" | "processing" | "ready" | "failed";
  format: "stl" | "step" | "json" | "package";
  filename: string;
  createdAt: string;
  updatedAt: string;
};

// ==============================
// REQUIREMENTS-FIRST INPUT MODEL
// ==============================

export type LoadDirection = "vertical" | "lateral" | "multi-axis";
export type ManufacturingProcess = "additive" | "machined";
export type OptimizationPriority = "lightweight" | "stiffness" | "balanced";

export type StructuralBracketRequirements = {
  componentName: string;

  loadCase: {
    forceN: number;
    direction: LoadDirection;
    vibrationHz?: number;
  };

  safetyFactor: number;

  mounting: {
    boltCount: number;
    boltDiameterMm: number;
    spacingMm: number;
  };

  envelope: {
    maxWidthMm: number;
    maxHeightMm: number;
    maxDepthMm: number;
  };

  manufacturing: {
    process: ManufacturingProcess;
    minWallThicknessMm: number;
    maxOverhangDeg: number;
    supportAllowed: boolean;
  };

  objectives: {
    targetMassKg?: number;
    priority: OptimizationPriority;
  };
};

export type BellNozzleRequirements = {
  componentName: string;

  performance: {
    targetThrustN: number;
    burnDurationSec: number;
    chamberPressureBar?: number;
    ambientPressurePa: number;
  };

  propellant: {
    oxidizer: "LOX" | "N2O" | "H2O2";
    fuel: "RP1" | "CH4" | "H2" | "HTPB";
    mixtureRatio?: number;
  };

  envelope: {
    maxLengthMm: number;
    maxExitDiameterMm: number;
  };

  thermal: {
    coolingMode: "ablative" | "regenerative" | "radiative";
    maxWallTemperatureC?: number;
  };

  manufacturing: {
    process: ManufacturingProcess;
    minWallThicknessMm: number;
    supportAllowed: boolean;
  };

  objectives: {
    priority: "efficiency" | "compactness" | "thermal-margin" | "balanced";
    targetMassKg?: number;
  };

  safetyFactor: number;
};

export type GenerationInput =
  | {
      componentFamily: "structural-bracket";
      requirements: StructuralBracketRequirements;
    }
  | {
      componentFamily: "bell-nozzle";
      requirements: BellNozzleRequirements;
    }
  | {
      componentFamily: "pressure-vessel" | "rover-arm" | "grid-fin";
      requirements: StructuralBracketRequirements;
    };

// ==============================
// GENERATED CANDIDATE MODEL
// ==============================

export type CandidateGeometry = {
  id: string;

  family: ComponentFamily;
  material: string;

  widthMm: number;
  heightMm: number;
  depthMm: number;
  lengthMm: number;
  wallThicknessMm: number;

  estimatedMassKg: number;
  estimatedStressMpa: number;
  estimatedDisplacementMm: number;
  safetyFactorEstimate: number;

  manufacturabilityScore: number;
  supportBurdenScore: number;
  performanceScore: number;
  totalScore: number;

  rejected: boolean;
  rejectionReasons: string[];

  derivedParameters: Record<string, number | string | boolean>;
};

export type BaselineComparison = {
  baselineCandidatesGenerated: number;
  baselineCandidatesSimulated: number;
  baselineCandidatesRejectedAfterReview: number;

  filteredCandidatesGenerated: number;
  filteredCandidatesRejectedBeforeSimulation: number;
  filteredCandidatesSimulated: number;

  avoidedSimulationRuns: number;
  reductionInSimulationLoadPercent: number;

  selectedBaselineCandidateId?: string;
  selectedFilteredCandidateId?: string;
  selectedBaselineCandidateWasRejected?: boolean;
};

export type FabricationReview = {
  vendor?: string;
  process?: string;
  material?: string;
  printOrientation?: string;
  supportsRequired?: boolean;
  supportRemovalDifficulty?: "unknown" | "low" | "moderate" | "high";
  dimensionalObservations?: string;
  visibleDefects?: string;
  predictedManufacturabilityMatchedObserved?: boolean;
  notes?: string;
};

export type DerivedGeometry = {
  widthMm: number;
  heightMm: number;
  depthMm: number;
  lengthMm: number;
  wallThicknessMm: number;
  material: string;
  estimatedMassKg: number;
  selectedCandidateId: string;
  derivedParameters: Record<string, number | string | boolean>;
};

export type GeometryPreview = {
  silhouette?: ComponentFamily;
  material: string;
  lengthMm: number;
  widthMm?: number;
  heightMm?: number;
  depthMm?: number;
  wallThicknessMm: number;
  notes?: string[];
  derived?: DerivedGeometry;
  candidates?: {
    evaluated: number;
    accepted: number;
    rejected: number;
    bestCandidateId?: string;
  };
};

// ==============================
// GENERATION RESULT
// ==============================

export type GenerationResult = {
  revision: string;
  exportState: "idle" | "queued" | "processing" | "ready" | "failed";
  estimatedMassKg: number;
  estimatedBurn: number;

  geometry: GeometryPreview;
  validations: ValidationMessage[];

  derived: DerivedGeometry;

  candidatesEvaluated: number;
  candidatesAccepted: number;
  candidatesRejected: number;

  selectedCandidate: CandidateGeometry;
  rejectedCandidates: CandidateGeometry[];

  baselineComparison?: BaselineComparison;
  fabricationReview?: FabricationReview;
};

export type GenerationSummary = {
  id: string;
  projectId: string;
  parentGenerationId: string | null;
  componentName: string;
  status: "queued" | "running" | "completed" | "failed";
  tokenCost: number;
  createdAt: string;
  updatedAt: string;
  input: GenerationInput;
  result?: GenerationResult;
};

// ==============================
// SHARED UI THEME
// ==============================

export const theme = {
  text: "#111111",
  muted: "#667085",
  border: "rgba(0, 0, 0, 0.12)",
  borderStrong: "rgba(0, 0, 0, 0.28)",
  panel: "rgba(255, 255, 255, 0.86)",
  panelSolid: "#ffffff",
  grid: "rgba(0, 0, 0, 0.055)",
  gridFine: "rgba(0, 0, 0, 0.035)",
  black: "#101010"
};
