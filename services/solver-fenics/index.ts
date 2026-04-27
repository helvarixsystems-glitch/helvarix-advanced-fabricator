import { spawn } from "child_process";

export async function runFenicsTopology(input: Record<string, unknown>) {
  return new Promise((resolve, reject) => {
    const process = spawn("python3", ["services/solver-fenics/topology.py"]);

    let stdout = "";
    let stderr = "";

    process.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    process.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    process.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(stderr || `FEniCS topology process exited with code ${code}`));
        return;
      }

      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new Error(`Invalid JSON from FEniCS topology process: ${stdout}`));
      }
    });

    process.stdin.write(JSON.stringify(input));
    process.stdin.end();
  });
}
