import {
  SimulationRequest,
  SimulationResult,
  SimulationArtifact,
} from "../types";

import { SimulationJob } from "../jobBuilder";

export type RemoteJobStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export interface RemoteSimulationJobRecord {
  id: string;

  requestId: string;
  userId?: string;

  status: RemoteJobStatus;

  createdAtIso: string;
  updatedAtIso: string;
  startedAtIso?: string;
  completedAtIso?: string;

  request: SimulationRequest;
  job: SimulationJob;

  fastEstimate?: SimulationResult;
  highFidelityResult?: SimulationResult;

  artifacts: SimulationArtifact[];

  warnings: string[];
  errors: string[];

  metadata?: Record<string, unknown>;
}

export interface RemoteSimulationSubmitRequest {
  request: SimulationRequest;
  job: SimulationJob;
  artifacts?: SimulationArtifact[];
  userId?: string;
  metadata?: Record<string, unknown>;
}

export interface RemoteSimulationSubmitResponse {
  status: RemoteJobStatus;
  remoteJobId: string;
  warnings: string[];
  errors: string[];
}

export interface RemoteSimulationStatusResponse {
  status: RemoteJobStatus;
  remoteJobId: string;

  progress?: {
    stage:
      | "queued"
      | "meshing"
      | "solving"
      | "parsing"
      | "scoring"
      | "completed"
      | "failed";

    percent: number;
    message: string;
  };

  warnings: string[];
  errors: string[];
}

export interface RemoteSimulationResultResponse {
  status: RemoteJobStatus;
  remoteJobId: string;

  result?: SimulationResult;
  artifacts: SimulationArtifact[];

  warnings: string[];
  errors: string[];
}
