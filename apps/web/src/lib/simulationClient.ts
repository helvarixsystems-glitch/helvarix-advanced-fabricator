export type SimulationStatus = "queued" | "running" | "completed" | "failed";

export type SimulationRecord = {
  id: string;
  status: SimulationStatus;
  remoteJobId?: string;

  result?: {
    summary: string;

    score: {
      structural: number;
      thermal: number;
      manufacturability: number;
      cfd: number;
      mass: number;
      total: number;
    };

    structural?: {
      maxVonMisesStressPa: number;
      maxDisplacementMm: number;
      estimatedSafetyFactor: number;
      pass: boolean;
      solver: string;
    };

    thermal?: {
      estimatedDistortionMm: number;
      pass: boolean;
      solver: string;
    };

    manufacturability?: {
      manufacturabilityScore: number;
      supportRequired: boolean;
      pass: boolean;
    };

    cfd?: {
      estimatedDragN: number;
      estimatedLiftN: number;
      pass: boolean;
      solver: string;
    };

    warnings: string[];
    errors: string[];
  };

  reportMarkdown?: string;

  warnings: string[];
  errors: string[];

  createdAt: string;
  updatedAt: string;
};

export async function runSimulation(
  apiBase: string,
  input: unknown
): Promise<{ id: string }> {
  const response = await fetch(`${apiBase}/simulations/run`, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({ input })
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(
      typeof data.error === "string"
        ? data.error
        : "Simulation request failed."
    );
  }

  return data;
}

export async function getSimulation(
  apiBase: string,
  id: string
): Promise<SimulationRecord | null> {
  const response = await fetch(
    `${apiBase}/simulations/result/${encodeURIComponent(id)}`
  );

  const data = await response.json();

  if (!response.ok) {
    throw new Error(
      typeof data.error === "string"
        ? data.error
        : "Simulation result request failed."
    );
  }

  return data;
}
