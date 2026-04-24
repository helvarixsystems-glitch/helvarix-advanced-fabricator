import {
  SimulationRequest,
  SimulationResult,
  SimulationArtifact,
} from "../types";

import { SimulationJob } from "../jobBuilder";

export interface RemoteSolverClientOptions {
  endpointUrl: string;
  apiKey?: string;
  timeoutMs?: number;
}

export interface RemoteSolverSubmitPayload {
  request: SimulationRequest;
  job: SimulationJob;
  artifacts: SimulationArtifact[];
}

export interface RemoteSolverResponse {
  status: "queued" | "running" | "completed" | "failed";

  remoteJobId?: string;
  result?: SimulationResult;
  artifacts?: SimulationArtifact[];

  warnings?: string[];
  errors?: string[];
}

export class RemoteSolverClient {
  private endpointUrl: string;
  private apiKey?: string;
  private timeoutMs: number;

  constructor(options: RemoteSolverClientOptions) {
    this.endpointUrl = options.endpointUrl.replace(/\/$/, "");
    this.apiKey = options.apiKey;
    this.timeoutMs = options.timeoutMs ?? 120_000;
  }

  async submitSimulation(
    payload: RemoteSolverSubmitPayload
  ): Promise<RemoteSolverResponse> {
    return this.postJson("/simulation/submit", payload);
  }

  async getSimulationStatus(
    remoteJobId: string
  ): Promise<RemoteSolverResponse> {
    return this.getJson(`/simulation/status/${encodeURIComponent(remoteJobId)}`);
  }

  async getSimulationResult(
    remoteJobId: string
  ): Promise<RemoteSolverResponse> {
    return this.getJson(`/simulation/result/${encodeURIComponent(remoteJobId)}`);
  }

  private async postJson<TBody>(
    path: string,
    body: TBody
  ): Promise<RemoteSolverResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(`${this.endpointUrl}${path}`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      return await this.parseResponse(response);
    } finally {
      clearTimeout(timer);
    }
  }

  private async getJson(path: string): Promise<RemoteSolverResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(`${this.endpointUrl}${path}`, {
        method: "GET",
        headers: this.headers(),
        signal: controller.signal,
      });

      return await this.parseResponse(response);
    } finally {
      clearTimeout(timer);
    }
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
    };

    if (this.apiKey) {
      headers.Authorization = `Bearer ${this.apiKey}`;
    }

    return headers;
  }

  private async parseResponse(response: Response): Promise<RemoteSolverResponse> {
    let json: unknown;

    try {
      json = await response.json();
    } catch {
      return {
        status: "failed",
        errors: [`Remote solver returned non-JSON response: ${response.status}`],
      };
    }

    if (!response.ok) {
      return {
        status: "failed",
        errors: [
          `Remote solver request failed with status ${response.status}.`,
          ...extractErrors(json),
        ],
      };
    }

    return normalizeRemoteSolverResponse(json);
  }
}

function normalizeRemoteSolverResponse(value: unknown): RemoteSolverResponse {
  if (!isRecord(value)) {
    return {
      status: "failed",
      errors: ["Remote solver response was not an object."],
    };
  }

  const status = value.status;

  if (
    status !== "queued" &&
    status !== "running" &&
    status !== "completed" &&
    status !== "failed"
  ) {
    return {
      status: "failed",
      errors: ["Remote solver response had an invalid status."],
    };
  }

  return {
    status,
    remoteJobId:
      typeof value.remoteJobId === "string" ? value.remoteJobId : undefined,
    result: isRecord(value.result)
      ? (value.result as unknown as SimulationResult)
      : undefined,
    artifacts: Array.isArray(value.artifacts)
      ? (value.artifacts as SimulationArtifact[])
      : undefined,
    warnings: Array.isArray(value.warnings)
      ? value.warnings.map(String)
      : undefined,
    errors: Array.isArray(value.errors) ? value.errors.map(String) : undefined,
  };
}

function extractErrors(value: unknown): string[] {
  if (!isRecord(value)) return [];

  if (Array.isArray(value.errors)) {
    return value.errors.map(String);
  }

  if (typeof value.error === "string") {
    return [value.error];
  }

  if (typeof value.message === "string") {
    return [value.message];
  }

  return [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
