/**
 * Simulation Module Entry Point
 *
 * This file is what the rest of your app will import.
 * Keep this clean and stable.
 */

// Core engine
export { runSimulation } from "./simulationEngine";

// Types
export * from "./types";

// Materials + utilities
export {
  MATERIAL_LIBRARY,
  getMaterial,
  estimateMassFromVolume,
  materialStrengthFactor,
  estimateThermalExpansion,
} from "./materials";

// Default requests (for testing, demos, pipelines)
export {
  createDefaultBracketSimulationRequest,
  createLightweightAluminumBracketRequest,
  createHighStrengthInconelBracketRequest,
} from "./defaultRequests";

/**
 * Future Expansion Hooks
 * (you will plug real solvers into these later)
 */

export type ExternalSolverAdapter = {
  name: string;

  runStructural?: (input: unknown) => Promise<unknown>;
  runThermal?: (input: unknown) => Promise<unknown>;
  runCfd?: (input: unknown) => Promise<unknown>;
};

let registeredSolvers: ExternalSolverAdapter[] = [];

export function registerSolver(adapter: ExternalSolverAdapter) {
  registeredSolvers.push(adapter);
}

export function getRegisteredSolvers(): ExternalSolverAdapter[] {
  return registeredSolvers;
}
