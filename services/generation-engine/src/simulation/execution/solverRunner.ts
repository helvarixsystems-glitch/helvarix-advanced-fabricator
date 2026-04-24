import { SimulationArtifact } from "../types";

export type SolverCommandKind = "gmsh" | "calculix" | "custom";

export interface SolverCommand {
  kind: SolverCommandKind;
  executable: string;
  args: string[];
  cwd: string;
  timeoutMs?: number;
}

export interface SolverRunResult {
  command: SolverCommand;
  status: "completed" | "failed" | "skipped";

  exitCode?: number;
  stdout: string;
  stderr: string;

  startedAtIso: string;
  completedAtIso: string;

  artifacts: SimulationArtifact[];
  warnings: string[];
  errors: string[];
}

/**
 * Web-hosted product rule:
 * Do NOT execute native solvers inside your front-end or Cloudflare Pages app.
 *
 * This runner is designed for the REMOTE WORKER / container service.
 * In browser/edge environments, it safely returns "skipped".
 */
export async function runSolverCommand(
  command: SolverCommand
): Promise<SolverRunResult> {
  const startedAtIso = new Date().toISOString();

  if (!isNodeRuntime()) {
    return {
      command,
      status: "skipped",
      stdout: "",
      stderr: "",
      startedAtIso,
      completedAtIso: new Date().toISOString(),
      artifacts: [],
      warnings: [
        "Solver execution skipped because this runtime does not support native process execution.",
      ],
      errors: [],
    };
  }

  try {
    const childProcess = await import("node:child_process");

    return await new Promise<SolverRunResult>((resolve) => {
      const child = childProcess.spawn(command.executable, command.args, {
        cwd: command.cwd,
        shell: false,
      });

      let stdout = "";
      let stderr = "";
      let settled = false;

      const timeout = setTimeout(() => {
        if (settled) return;

        settled = true;
        child.kill("SIGTERM");

        resolve({
          command,
          status: "failed",
          stdout,
          stderr,
          startedAtIso,
          completedAtIso: new Date().toISOString(),
          artifacts: [],
          warnings: [],
          errors: [
            `Solver command timed out after ${
              command.timeoutMs ?? 120_000
            } ms.`,
          ],
        });
      }, command.timeoutMs ?? 120_000);

      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
      });

      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });

      child.on("error", (err) => {
        if (settled) return;

        settled = true;
        clearTimeout(timeout);

        resolve({
          command,
          status: "failed",
          stdout,
          stderr,
          startedAtIso,
          completedAtIso: new Date().toISOString(),
          artifacts: [],
          warnings: [],
          errors: [err.message],
        });
      });

      child.on("close", (exitCode) => {
        if (settled) return;

        settled = true;
        clearTimeout(timeout);

        resolve({
          command,
          status: exitCode === 0 ? "completed" : "failed",
          exitCode: exitCode ?? undefined,
          stdout,
          stderr,
          startedAtIso,
          completedAtIso: new Date().toISOString(),
          artifacts: [
            {
              id: `artifact_solver_stdout_${safeId()}`,
              kind: "solver-output",
              label: `${command.kind} stdout`,
              inlineText: stdout,
              metadata: {
                executable: command.executable,
                args: command.args,
                cwd: command.cwd,
              },
            },
            {
              id: `artifact_solver_stderr_${safeId()}`,
              kind: "solver-output",
              label: `${command.kind} stderr`,
              inlineText: stderr,
              metadata: {
                executable: command.executable,
                args: command.args,
                cwd: command.cwd,
              },
            },
          ],
          warnings: [],
          errors:
            exitCode === 0
              ? []
              : [`Solver command exited with code ${exitCode}.`],
        });
      });
    });
  } catch (err) {
    return {
      command,
      status: "failed",
      stdout: "",
      stderr: "",
      startedAtIso,
      completedAtIso: new Date().toISOString(),
      artifacts: [],
      warnings: [],
      errors: [err instanceof Error ? err.message : String(err)],
    };
  }
}

export function buildGmshCommand(input: {
  executable?: string;
  cwd: string;
  geoFileName: string;
  outputMeshFileName: string;
  timeoutMs?: number;
}): SolverCommand {
  return {
    kind: "gmsh",
    executable: input.executable ?? "gmsh",
    cwd: input.cwd,
    timeoutMs: input.timeoutMs ?? 120_000,
    args: [
      input.geoFileName,
      "-3",
      "-format",
      "inp",
      "-o",
      input.outputMeshFileName,
    ],
  };
}

export function buildCalculixCommand(input: {
  executable?: string;
  cwd: string;
  jobName: string;
  timeoutMs?: number;
}): SolverCommand {
  return {
    kind: "calculix",
    executable: input.executable ?? "ccx",
    cwd: input.cwd,
    timeoutMs: input.timeoutMs ?? 180_000,
    args: [input.jobName],
  };
}

function isNodeRuntime(): boolean {
  return (
    typeof process !== "undefined" &&
    Boolean(process.versions?.node) &&
    typeof window === "undefined"
  );
}

function safeId(): string {
  return Math.random().toString(36).slice(2, 10);
}
