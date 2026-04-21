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

export type CreditBalance = {
  available: number;
  reserved: number;
};

export type GenerationStatus = "queued" | "running" | "completed" | "failed";

export type GenerationSummary = {
  id: string;
  projectId: string;
  componentName: string;
  status: GenerationStatus;
  tokenCost: number;
  updatedAt: string;
};

export type ProjectSummary = {
  id: string;
  name: string;
  partFamily: string;
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
