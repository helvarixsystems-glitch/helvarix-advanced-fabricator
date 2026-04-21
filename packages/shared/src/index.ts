export const appName = "Helvarix Advanced Fabricator";

export const theme = {
  bg: "#e9e9e7",
  panel: "rgba(249,249,247,0.9)",
  border: "rgba(0,0,0,0.12)",
  text: "#111111",
  muted: "rgba(0,0,0,0.58)",
  black: "#111111",
  white: "#ffffff",
  grid: "rgba(0,0,0,0.08)",
  gridFine: "rgba(0,0,0,0.04)"
};

export type ComponentFamily = "nosecone" | "shell" | "rover-arm" | "grid-fin";
export type GenerationStatus = "queued" | "running" | "completed" | "failed";
export type ExportStatus = "idle" | "queued" | "processing" | "ready" | "failed";
export type ValidationSeverity = "success" | "warning" | "error";

export type CreditBalance = {
  available: number;
  reserved: number;
};

export type ValidationMessage = {
  severity: ValidationSeverity;
  title: string;
  text: string;
};

export type GeometryPreview = {
  silhouette: ComponentFamily;
  lengthMm: number;
  widthMm: number;
  wallThicknessMm: number;
  material: string;
  notes?: string[];
};

export type GenerationInput = {
  componentFamily: ComponentFamily;
  componentName: string;
  lengthMm: number;
  baseDiameterMm: number;
  wallThicknessMm: number;
  material: string;
  targetMassKg: number;
};

export type GenerationResult = {
  revision: string;
  exportState: ExportStatus;
  estimatedMassKg: number;
  estimatedBurn: number;
  geometry: GeometryPreview;
  validations: ValidationMessage[];
};

export type ProjectSummary = {
  id: string;
  name: string;
  componentFamily: ComponentFamily;
  workspaceLabel: string;
  createdAt: string;
  updatedAt: string;
};

export type GenerationSummary = {
  id: string;
  projectId: string;
  parentGenerationId?: string | null;
  componentName: string;
  status: GenerationStatus;
  tokenCost: number;
  updatedAt: string;
  createdAt: string;
  input: GenerationInput;
  result?: GenerationResult;
};

export type ExportRecord = {
  id: string;
  generationId: string;
  status: ExportStatus;
  format: "stl" | "step" | "json";
  filename: string;
  createdAt: string;
  updatedAt: string;
};

export function formatTimestamp(value: string): string {
  const date = new Date(value);
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "2-digit",
    hour: "numeric",
    minute: "2-digit"
  }).format(date);
}
