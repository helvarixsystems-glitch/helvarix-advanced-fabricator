import { runSimulation } from "../simulationEngine";
import {
  RemoteSimulationJobRecord,
  RemoteSimulationSubmitRequest,
  RemoteSimulationSubmitResponse,
  RemoteSimulationStatusResponse,
  RemoteSimulationResultResponse,
} from "./remoteJobTypes";

const jobs = new Map<string, RemoteSimulationJobRecord>();

/**
 * In-memory mock worker.
 *
 * Purpose:
 * - Lets your hosted app submit simulation jobs now.
 * - Lets you test the exact API contract before real containers exist.
 * - Can later be replaced by a real worker backed by Redis, Supabase, S3/R2,
 *   Docker, Kubernetes, RunPod, Modal, AWS Batch, etc.
 */
export async function submitRemoteSimulationMock(
  payload: RemoteSimulationSubmitRequest
): Promise<RemoteSimulationSubmitResponse> {
  const id = `remote_job_${safeId()}`;
  const now = new Date().toISOString();

  const record: RemoteSimulationJobRecord = {
    id,
    requestId: payload.request.id,
    userId: payload.userId,

    status: "queued",

    createdAtIso: now,
    updatedAtIso: now,

    request: payload.request,
    job: payload.job,

    artifacts: payload.artifacts ?? [],

    warnings: [],
    errors: [],

    metadata: {
      ...payload.metadata,
      worker: "remoteWorkerMock",
    },
  };

  jobs.set(id, record);

  void runMockJob(id);

  return {
    status: "queued",
    remoteJobId: id,
    warnings: [],
    errors: [],
  };
}

export async function getRemoteSimulationStatusMock(
  remoteJobId: string
): Promise<RemoteSimulationStatusResponse> {
  const record = jobs.get(remoteJobId);

  if (!record) {
    return {
      status: "failed",
      remoteJobId,
      progress: {
        stage: "failed",
        percent: 100,
        message: "Remote simulation job not found.",
      },
      warnings: [],
      errors: ["Remote simulation job not found."],
    };
  }

  return {
    status: record.status,
    remoteJobId,

    progress: statusToProgress(record.status),

    warnings: record.warnings,
    errors: record.errors,
  };
}

export async function getRemoteSimulationResultMock(
  remoteJobId: string
): Promise<RemoteSimulationResultResponse> {
  const record = jobs.get(remoteJobId);

  if (!record) {
    return {
      status: "failed",
      remoteJobId,
      artifacts: [],
      warnings: [],
      errors: ["Remote simulation job not found."],
    };
  }

  return {
    status: record.status,
    remoteJobId,

    result: record.highFidelityResult ?? record.fastEstimate,
    artifacts: record.artifacts,

    warnings: record.warnings,
    errors: record.errors,
  };
}

async function runMockJob(remoteJobId: string): Promise<void> {
  const record = jobs.get(remoteJobId);
  if (!record) return;

  try {
    updateJob(remoteJobId, {
      status: "running",
      startedAtIso: new Date().toISOString(),
      warnings: [
        ...record.warnings,
        "Mock worker is running internal simulation only. Real solver container not connected yet.",
      ],
    });

    const result = await runSimulation(record.request);

    const latest = jobs.get(remoteJobId);
    if (!latest) return;

    updateJob(remoteJobId, {
      status: result.status === "completed" ? "completed" : "failed",
      completedAtIso: new Date().toISOString(),
      fastEstimate: result,
      highFidelityResult: result,
      artifacts: [...latest.artifacts, ...result.artifacts],
      warnings: [...latest.warnings, ...result.warnings],
      errors: [...latest.errors, ...result.errors],
    });
  } catch (err) {
    const latest = jobs.get(remoteJobId);
    if (!latest) return;

    updateJob(remoteJobId, {
      status: "failed",
      completedAtIso: new Date().toISOString(),
      errors: [
        ...latest.errors,
        err instanceof Error ? err.message : String(err),
      ],
    });
  }
}

function updateJob(
  remoteJobId: string,
  patch: Partial<RemoteSimulationJobRecord>
): void {
  const existing = jobs.get(remoteJobId);
  if (!existing) return;

  jobs.set(remoteJobId, {
    ...existing,
    ...patch,
    updatedAtIso: new Date().toISOString(),
  });
}

function statusToProgress(status: RemoteSimulationJobRecord["status"]) {
  switch (status) {
    case "queued":
      return {
        stage: "queued" as const,
        percent: 5,
        message: "Simulation job is queued.",
      };

    case "running":
      return {
        stage: "solving" as const,
        percent: 55,
        message: "Simulation job is running.",
      };

    case "completed":
      return {
        stage: "completed" as const,
        percent: 100,
        message: "Simulation job completed.",
      };

    case "failed":
      return {
        stage: "failed" as const,
        percent: 100,
        message: "Simulation job failed.",
      };

    case "cancelled":
      return {
        stage: "failed" as const,
        percent: 100,
        message: "Simulation job was cancelled.",
      };
  }
}

function safeId(): string {
  return Math.random().toString(36).slice(2, 10);
}
