// Core execution entry (local / hybrid)
export {
  executeSimulation,
  type SimulationExecutionOptions,
  type SimulationExecutionResult,
} from "./simulationExecutor";

// Remote execution (production path)
export {
  executeRemoteSimulation,
  pollRemoteSimulationResult,
  type RemoteExecutionOptions,
  type RemoteExecutionResult,
} from "./remoteExecutionProvider";

// Remote client (HTTP bridge)
export {
  RemoteSolverClient,
  type RemoteSolverClientOptions,
} from "./remoteSolverClient";

// Remote job contracts (shared types)
export * from "./remoteJobTypes";

// Mock worker (dev / testing)
export {
  submitRemoteSimulationMock,
  getRemoteSimulationStatusMock,
  getRemoteSimulationResultMock,
} from "./remoteWorkerMock";
