// ==============================
// SHARED CORE TYPES
// ==============================

export type ComponentFamily =
  | "structural-bracket"
  | "nosecone"
  | "shell"
  | "rover-arm"
  | "grid-fin";

// ==============================
// REQUIREMENTS-FIRST INPUT MODEL
// ==============================

export type StructuralBracketRequirements = {
  // What the part must do
  loadCase: {
    forceN: number;              // required load support
    direction: "vertical" | "lateral" | "multi-axis";
    vibrationHz?: number;        // optional vibration requirement
  };

  // How safe it must be
  safetyFactor: number;

  // Mounting constraints
  mounting: {
    boltCount: number;
    boltDiameterMm: number;
    spacingMm: number;
  };

  // Envelope constraints
  envelope: {
    maxWidthMm: number;
    maxHeightMm: number;
    maxDepthMm: number;
  };

  // Manufacturing constraints
  manufacturing: {
    process: "additive" | "machined";
    minWallThicknessMm: number;
    maxOverhangDeg: number;
    supportAllowed: boolean;
  };

  // Optimization targets
  objectives: {
    targetMassKg?: number;
    priority: "lightweight" | "stiffness" | "balanced";
  };
};

// ==============================
// GENERATION INPUT
// ==============================

export type GenerationInput = {
  componentFamily: ComponentFamily;
  requirements: StructuralBracketRequirements;
};

// ==============================
// DERIVED OUTPUT
// ==============================

export type DerivedGeometry = {
  widthMm: number;
  heightMm: number;
  depthMm: number;
  wallThicknessMm: number;
  material: string;
  estimatedMassKg: number;
};

// ==============================
// GENERATION RESULT
// ==============================

export type GenerationResult = {
  geometryId: string;
  derived: DerivedGeometry;
  candidatesEvaluated: number;
  rejected: number;
};

// ==============================
// VIEWER PREVIEW TYPE
// ==============================

export type GeometryPreview = {
  silhouette?: ComponentFamily;
  material: string;
  lengthMm: number;
  wallThicknessMm: number;
  notes?: string[];
};
