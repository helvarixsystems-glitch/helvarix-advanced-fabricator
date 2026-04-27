import { spawn } from "child_process";
import path from "path";

export async function runFenicsTopology(input: Record<string, unknown>) {
  return new Promise((resolve, reject) => {
    const solverPath = path.join(process.cwd(), "services", "solver-fenics", "topology.py");

    const child = spawn("python3", [solverPath], {
      cwd: process.cwd(),
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    child.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    child.on("error", (error) => {
      reject(new Error(`Failed to start topology solver at ${solverPath}: ${error.message}`));
    });

    child.on("close", (code) => {
      if (code !== 0) {
        reject(
          new Error(
            `Topology solver failed with code ${code}. Path: ${solverPath}. stderr: ${stderr || "<empty>"}. stdout: ${stdout || "<empty>"}`
          )
        );
        return;
      }

      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(
          new Error(
            `Invalid JSON from topology solver. Path: ${solverPath}. stderr: ${stderr || "<empty>"}. stdout: ${stdout || "<empty>"}`
          )
        );
      }
    });

    child.stdin.write(JSON.stringify(input));
    child.stdin.end();
  });
}
