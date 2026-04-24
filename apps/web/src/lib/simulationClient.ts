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

  const data = await readJsonSafely(response);

  if (!response.ok) {
    throw new Error(getErrorMessage(data, "Simulation request failed."));
  }

  if (!data || typeof data.id !== "string") {
    throw new Error("Simulation API did not return a simulation id.");
  }

  return data as { id: string };
}

export async function getSimulation(
  apiBase: string,
  id: string
): Promise<SimulationRecord | null> {
  const response = await fetch(
    `${apiBase}/simulations/result/${encodeURIComponent(id)}`
  );

  const data = await readJsonSafely(response);

  if (!response.ok) {
    throw new Error(getErrorMessage(data, "Simulation result request failed."));
  }

  return data as SimulationRecord | null;
}

async function readJsonSafely(response: Response): Promise<any> {
  const text = await response.text();

  if (!text.trim()) {
    throw new Error(
      `API returned an empty response. Status: ${response.status} ${response.statusText}`
    );
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new Error(
      `API returned non-JSON response. Status: ${response.status} ${response.statusText}. Body: ${text.slice(
        0,
        240
      )}`
    );
  }
}

function getErrorMessage(data: unknown, fallback: string): string {
  if (
    typeof data === "object" &&
    data !== null &&
    "error" in data &&
    typeof (data as { error?: unknown }).error === "string"
  ) {
    return (data as { error: string }).error;
  }

  return fallback;
}
