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
  loadCase: {
    forceN: number;
    direction: "vertical" | "lateral" | "multi-axis";
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
    process: "additive" | "machined";
    minWallThicknessMm: number;
    maxOverhangDeg: number;
    supportAllowed: boolean;
  };

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

// ==============================
// SHARED UI THEME (FIXES BUILD)
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
