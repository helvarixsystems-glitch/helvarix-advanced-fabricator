import http from "node:http";

import { runFenicsTopology } from "../../../../../solver-fenics/index";

import {
  submitRemoteSimulationMock,
  getRemoteSimulationStatusMock,
  getRemoteSimulationResultMock,
  persistHighFidelitySimulationResult,
  persistRemoteSimulationFailure,
} from "../execution/remoteWorkerMock";

import { runHighFidelityPipeline } from "../execution/highFidelityPipeline";

import { RemoteSimulationSubmitRequest } from "../execution/remoteJobTypes";

const PORT = Number(process.env.PORT ?? 8787);

const ENABLE_NATIVE_SOLVERS =
  process.env.HELVARIX_ENABLE_NATIVE_SOLVERS === "true";

const WORKSPACE_ROOT =
  process.env.HELVARIX_SOLVER_WORKSPACE_ROOT ?? "/tmp/helvarix-solver";

const GMSH_EXEC = process.env.HELVARIX_GMSH_EXECUTABLE ?? "gmsh";
const CCX_EXEC = process.env.HELVARIX_CALCULIX_EXECUTABLE ?? "ccx";

const server = http.createServer(async (req, res) => {
  try {
    setCors(res);

    if (req.method === "OPTIONS") {
      return respond(res, 204, {});
    }

    if (!req.url) {
      return respond(res, 400, { error: "Missing URL" });
    }

    if (req.method === "GET" && req.url === "/health") {
      return respond(res, 200, {
        ok: true,
        service: "helvarix-solver-worker",
        nativeSolversEnabled: ENABLE_NATIVE_SOLVERS,
        timestamp: new Date().toISOString(),
      });
    }
if (req.method === "POST" && req.url === "/fenics-test") {
  const body = await readJsonBody<Record<string, unknown>>(req);

  const result = await runFenicsTopology({
    nx: body.nx ?? 20,
    ny: body.ny ?? 20,
    nz: body.nz ?? 10,
    loadDirection: body.loadDirection ?? "vertical"
  });

  return respond(res, 200, result);
}
    if (req.method === "POST" && req.url === "/simulation/submit") {
      const body = await readJsonBody<RemoteSimulationSubmitRequest>(req);

      const submitResponse = await submitRemoteSimulationMock(body);

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

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Helvarix Solver Worker running on port ${PORT}`);
  console.log(`Native solvers enabled: ${ENABLE_NATIVE_SOLVERS}`);
  console.log(`Workspace root: ${WORKSPACE_ROOT}`);
});

async function runWorkerPipeline(
  payload: RemoteSimulationSubmitRequest,
  jobId: string
) {
  try {
    console.log(`Running high-fidelity pipeline for job ${jobId}`);

    const pipeline = await runHighFidelityPipeline(payload.request, {
      enableDiskWrite: true,
      enableNativeExecution: ENABLE_NATIVE_SOLVERS,
      workspaceRootDirectory: `${WORKSPACE_ROOT}/${jobId}`,
      gmshExecutable: GMSH_EXEC,
      calculixExecutable: CCX_EXEC,
    });

    persistHighFidelitySimulationResult({
      remoteJobId: jobId,
      result: pipeline.result,
      artifacts: pipeline.artifacts,
      warnings: pipeline.warnings,
      errors: pipeline.errors,
    });

    console.log(`Job ${jobId} complete | score=${pipeline.result.score.total}`);
  } catch (err) {
    persistRemoteSimulationFailure({
      remoteJobId: jobId,
      error: err,
    });

    console.error(`Job ${jobId} failed`, err);
  }
}

function setCors(res: http.ServerResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

function respond(res: http.ServerResponse, status: number, data: unknown) {
  res.writeHead(status, {
    "Content-Type": "application/json",
  });

  if (status === 204) {
    res.end();
    return;
  }

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
