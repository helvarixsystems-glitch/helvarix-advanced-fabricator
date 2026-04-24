import React from "react";
import { BlackButton, MetricRow, SidebarSection } from "@haf/ui";
import {
  getSimulation,
  runSimulation,
  type SimulationRecord
} from "../../lib/simulationClient";

type SimulationPanelProps = {
  apiBase: string;
  input: unknown;
};

export function SimulationPanel({ apiBase, input }: SimulationPanelProps) {
  const [simulationId, setSimulationId] = React.useState<string | null>(null);
  const [simulation, setSimulation] = React.useState<SimulationRecord | null>(null);
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const isRunning =
    simulation?.status === "queued" || simulation?.status === "running";

  React.useEffect(() => {
    if (!simulationId) return;

    const timer = window.setInterval(async () => {
      try {
        const next = await getSimulation(apiBase, simulationId);
        setSimulation(next);

        if (next?.status === "completed" || next?.status === "failed") {
          window.clearInterval(timer);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Unable to fetch simulation.");
      }
    }, 2000);

    return () => window.clearInterval(timer);
  }, [apiBase, simulationId]);

  async function handleRunSimulation() {
    setSubmitting(true);
    setError(null);

    try {
      const response = await runSimulation(apiBase, input);
      setSimulationId(response.id);

      const firstResult = await getSimulation(apiBase, response.id);
      setSimulation(firstResult);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Simulation failed.");
    } finally {
      setSubmitting(false);
    }
  }

  const result = simulation?.result;

  return (
    <SidebarSection title="Simulation Engine">
      <div className="simulation-card">
        <div className="simulation-card-header">
          <div>
            <div className="message-title">Validation Pipeline</div>
            <div className="simulation-subtitle">
              Structural, thermal, manufacturability, CFD, and mass scoring.
            </div>
          </div>

          <span className={`history-chip history-chip-${statusTone(simulation?.status)}`}>
            {simulation?.status ?? "idle"}
          </span>
        </div>

        <BlackButton
          subdued
          onClick={handleRunSimulation}
          disabled={submitting || isRunning}
        >
          {submitting || isRunning ? "Running Simulation..." : "Run Simulation"}
        </BlackButton>

        {simulation ? (
          <div className="simulation-metrics">
            <MetricRow label="Simulation ID" value={simulation.id} />
            <MetricRow
              label="Remote Job"
              value={simulation.remoteJobId ?? "Internal / Pending Render"}
            />
            <MetricRow
              label="Updated"
              value={new Date(simulation.updatedAt).toLocaleString()}
            />
          </div>
        ) : (
          <div className="message">
            <div className="message-title">Ready</div>
            <div className="message-body">
              Generate a concept, then run simulation validation on the selected design.
            </div>
          </div>
        )}

        {result ? (
          <>
            <div className="simulation-score">
              <span>Total Score</span>
              <strong>{result.score.total}/100</strong>
            </div>

            <div className="simulation-score-grid">
              <MetricRow label="Structural" value={`${result.score.structural}/100`} />
              <MetricRow label="Thermal" value={`${result.score.thermal}/100`} />
              <MetricRow
                label="Manufacturing"
                value={`${result.score.manufacturability}/100`}
              />
              <MetricRow label="CFD" value={`${result.score.cfd}/100`} />
              <MetricRow label="Mass" value={`${result.score.mass}/100`} />
            </div>

            <div className="message message-success">
              <div className="message-title">Simulation Summary</div>
              <div className="message-body">{result.summary}</div>
            </div>

            {result.structural ? (
              <div className="simulation-metrics">
                <MetricRow
                  label="Safety Factor"
                  value={formatNumber(result.structural.estimatedSafetyFactor)}
                />
                <MetricRow
                  label="Max Stress"
                  value={`${formatScientific(result.structural.maxVonMisesStressPa)} Pa`}
                />
                <MetricRow
                  label="Displacement"
                  value={`${result.structural.maxDisplacementMm.toFixed(4)} mm`}
                />
                <MetricRow label="Solver" value={result.structural.solver} />
              </div>
            ) : null}

            {result.thermal ? (
              <div className="simulation-metrics">
                <MetricRow
                  label="Thermal Distortion"
                  value={`${result.thermal.estimatedDistortionMm.toFixed(4)} mm`}
                />
                <MetricRow label="Thermal Solver" value={result.thermal.solver} />
              </div>
            ) : null}

            {result.manufacturability ? (
              <div className="simulation-metrics">
                <MetricRow
                  label="Manufacturability"
                  value={`${result.manufacturability.manufacturabilityScore.toFixed(2)}/100`}
                />
                <MetricRow
                  label="Support Required"
                  value={result.manufacturability.supportRequired ? "Yes" : "No"}
                />
              </div>
            ) : null}

            {result.cfd ? (
              <div className="simulation-metrics">
                <MetricRow
                  label="Estimated Drag"
                  value={`${result.cfd.estimatedDragN.toFixed(3)} N`}
                />
                <MetricRow
                  label="Estimated Lift"
                  value={`${result.cfd.estimatedLiftN.toFixed(3)} N`}
                />
                <MetricRow label="CFD Solver" value={result.cfd.solver} />
              </div>
            ) : null}

            {result.warnings.length ? (
              <div className="message message-warning">
                <div className="message-title">Warnings</div>
                <div className="message-body">
                  {result.warnings.slice(0, 3).join(" ")}
                </div>
              </div>
            ) : null}

            {result.errors.length ? (
              <div className="message message-error">
                <div className="message-title">Errors</div>
                <div className="message-body">
                  {result.errors.slice(0, 3).join(" ")}
                </div>
              </div>
            ) : null}
          </>
        ) : null}

        {error ? (
          <div className="message message-error">
            <div className="message-title">Simulation Error</div>
            <div className="message-body">{error}</div>
          </div>
        ) : null}
      </div>
    </SidebarSection>
  );
}

function statusTone(status?: string) {
  if (status === "completed") return "success";
  if (status === "failed") return "warning";
  return "neutral";
}

function formatNumber(value: number) {
  if (!Number.isFinite(value)) return "∞";
  return value.toFixed(2);
}

function formatScientific(value: number) {
  if (!Number.isFinite(value)) return "∞";
  return value.toExponential(3);
}
