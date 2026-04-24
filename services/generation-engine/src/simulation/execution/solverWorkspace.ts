import { SimulationArtifact } from "../types";

export interface SolverWorkspaceFile {
  fileName: string;
  text: string;
}

export interface SolverWorkspace {
  id: string;
  rootDirectory: string;
  files: SolverWorkspaceFile[];
  artifacts: SimulationArtifact[];
}

export interface SolverWorkspaceOptions {
  rootDirectory?: string;
}

/**
 * Builds a file package for the remote/container worker.
 *
 * This does not require local disk access.
 * It prepares the exact files a solver container should write before running:
 *
 * - Gmsh .geo
 * - CalculiX .inp
 * - metadata/report JSON
 */
export function buildSolverWorkspace(input: {
  workspaceId?: string;
  gmsh?: {
    geoFileName: string;
    geoText: string;
  };
  calculix?: {
    inputFileName: string;
    inputText: string;
  };
  metadata?: Record<string, unknown>;
  options?: SolverWorkspaceOptions;
}): SolverWorkspace {
  const id = input.workspaceId ?? `solver_workspace_${safeId()}`;
  const rootDirectory =
    input.options?.rootDirectory ?? `/tmp/helvarix-solver/${id}`;

  const files: SolverWorkspaceFile[] = [];

  if (input.gmsh) {
    files.push({
      fileName: input.gmsh.geoFileName,
      text: input.gmsh.geoText,
    });
  }

  if (input.calculix) {
    files.push({
      fileName: input.calculix.inputFileName,
      text: input.calculix.inputText,
    });
  }

  files.push({
    fileName: "workspace.metadata.json",
    text: JSON.stringify(
      {
        id,
        createdAtIso: new Date().toISOString(),
        ...input.metadata,
      },
      null,
      2
    ),
  });

  return {
    id,
    rootDirectory,
    files,
    artifacts: files.map((file) => ({
      id: `artifact_workspace_file_${safeId()}`,
      kind: file.fileName.endsWith(".geo")
        ? "mesh"
        : file.fileName.endsWith(".inp")
          ? "solver-input"
          : "json",
      label: file.fileName,
      inlineText: file.text,
      metadata: {
        workspaceId: id,
        rootDirectory,
        fileName: file.fileName,
      },
    })),
  };
}

/**
 * Optional disk writer for Node-based remote workers.
 * Safe no-op in browser/edge runtimes.
 */
export async function writeSolverWorkspaceToDisk(
  workspace: SolverWorkspace
): Promise<{
  written: boolean;
  rootDirectory: string;
  warnings: string[];
  errors: string[];
}> {
  if (!isNodeRuntime()) {
    return {
      written: false,
      rootDirectory: workspace.rootDirectory,
      warnings: [
        "Workspace was not written because this runtime does not support filesystem access.",
      ],
      errors: [],
    };
  }

  try {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");

    await fs.mkdir(workspace.rootDirectory, {
      recursive: true,
    });

    for (const file of workspace.files) {
      const filePath = path.join(workspace.rootDirectory, file.fileName);
      await fs.writeFile(filePath, file.text, "utf8");
    }

    return {
      written: true,
      rootDirectory: workspace.rootDirectory,
      warnings: [],
      errors: [],
    };
  } catch (err) {
    return {
      written: false,
      rootDirectory: workspace.rootDirectory,
      warnings: [],
      errors: [err instanceof Error ? err.message : String(err)],
    };
  }
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
