import http from "node:http";

import {
  submitRemoteSimulationMock,
  getRemoteSimulationStatusMock,
  getRemoteSimulationResultMock,
} from "../execution/remoteWorkerMock";

import { runHighFidelityPipeline } from "../execution/highFidelityPipeline";

import {
  RemoteSimulationSubmitRequest,
} from "../execution/remoteJobTypes";

/**
 * ⚠️ This is your FIRST real worker server.
 *
 * Responsibilities:
 * - Accept simulation jobs over HTTP
 * - Run high-fidelity pipeline (Gmsh + CalculiX)
 * - Return results
 *
 * Right now:
 * - Uses mock job system
 * - Can run real solvers if container supports it
 *
 * Later:
 * - Replace mock storage with Redis / DB
 * - Add auth, rate limiting, scaling
 */

const PORT = Number(process.env.PORT ?? 8787);

const ENABLE_NATIVE_SOLVERS =
  process.env.HELVARIX_ENABLE_NATIVE_SOLVERS === "true";

const WORKSPACE_ROOT =
  process.env.HELVARIX_SOLVER_WORKSPACE_ROOT ??
  "/tmp/helvarix-solver";

const GMSH_EXEC =
  process.env.HELVARIX_GMSH_EXECUTABLE ?? "gmsh";

const CCX_EXEC =
  process.env.HELVARIX_CALCULIX_EXECUTABLE ?? "ccx";

const server = http.createServer(async (req, res) => {
  try {
    if (!req.url) {
      return respond(res, 400, { error: "Missing URL" });
    }

    if (req.method === "POST" && req.url === "/simulation/submit") {
      const body = await readJsonBody<RemoteSimulationSubmitRequest>(req);

      /**
       * STEP 1 — register job (mock store)
       */
      const submitResponse = await submitRemoteSimulationMock(body);

      /**
       * STEP 2 — run high-fidelity in background (REAL ENGINE)
       */
      void runWorkerPipeline(body, submitResponse.remoteJobId);

      return respond(res, 200, submitResponse);
    }

    if (req.method === "GET" && req.url.startsWith("/simulation/status/")) {
      const id = req.url.split("/").pop()!;
      const status = await getRemoteSimulationStatusMock(id);
      return respond(res, 200, status);
    }

    if (req.method === "GET" && req.url.startsWith("/simulation/result/")) {
      const id = req.url.split("/").pop()!;
      const result = await getRemoteSimulationResultMock(id);
      return respond(res, 200, result);
    }

    return respond(res, 404, { error: "Not found" });
  } catch (err) {
    return respond(res, 500, {
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

server.listen(PORT, () => {
  console.log(`🚀 Helvarix Solver Worker running on port ${PORT}`);
  console.log(`⚙️ Native solvers: ${ENABLE_NATIVE_SOLVERS}`);
  console.log(`📁 Workspace: ${WORKSPACE_ROOT}`);
});

/**
 * 🔥 CORE WORKER PIPELINE
 */
async function runWorkerPipeline(
  payload: RemoteSimulationSubmitRequest,
  jobId: string
) {
  try {
    console.log(`🧠 Running high-fidelity pipeline for job ${jobId}`);

    const result = await runHighFidelityPipeline(payload.request, {
      enableDiskWrite: true,
      enableNativeExecution: ENABLE_NATIVE_SOLVERS,
      workspaceRootDirectory: `${WORKSPACE_ROOT}/${jobId}`,
      gmshExecutable: GMSH_EXEC,
      calculixExecutable: CCX_EXEC,
    });

    console.log(
      `✅ Job ${jobId} complete | score=${result.result.score.total}`
    );

    /**
     * NOTE:
     * Right now, results are not persisted back into the mock store.
     * The mock store already runs runSimulation() internally.
     *
     * Next upgrade:
     * - Replace mock system
     * - Persist high-fidelity results here
     */

  } catch (err) {
    console.error(`❌ Job ${jobId} failed`, err);
  }
}

/**
 * Utils
 */

function respond(res: http.ServerResponse, status: number, data: unknown) {
  res.writeHead(status, {
    "Content-Type": "application/json",
  });
  res.end(JSON.stringify(data));
}

async function readJsonBody<T>(req: http.IncomingMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    let data = "";

    req.on("data", (chunk) => {
      data += chunk;
    });

    req.on("end", () => {
      try {
        resolve(JSON.parse(data));
      } catch (err) {
        reject(err);
      }
    });

    req.on("error", reject);
  });
}
