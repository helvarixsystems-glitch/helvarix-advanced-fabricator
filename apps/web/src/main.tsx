import React from "react";
import ReactDOM from "react-dom/client";
import { SimulationPanel } from "./components/workspace/SimulationPanel";
import {
  AppShell,
  BlackButton,
  InputField,
  MetricRow,
  SelectField,
  SidebarSection,
  WorkspacePanel
} from "@haf/ui";
import { GraphPaperRoom, type ViewerMode } from "@haf/viewer";
import {
  appName,
  formatTimestamp,
  type CreditBalance,
  type GenerationInput,
  type GenerationSummary,
  type ProjectSummary
} from "@haf/shared";
import { componentRegistry } from "@haf/component-registry";
import "./styles.css";

const API_BASE =
  (globalThis as { __HAF_API__?: string }).__HAF_API__ ??
  "helvarix-advanced-fabricator.helvarixsystems.workers.dev";

const MATERIAL_OPTIONS = [
  { label: "PEEK-CF", value: "PEEK-CF" },
  { label: "AlSi10Mg", value: "AlSi10Mg" },
  { label: "Ti-6Al-4V", value: "Ti-6Al-4V" },
  { label: "Inconel 718", value: "Inconel 718" }
];

const EXPORT_OPTIONS = [
  { label: "STL", value: "stl" },
  { label: "STEP", value: "step" },
  { label: "JSON", value: "json" }
] as const;

const VIEW_MODE_OPTIONS: Array<{ label: string; value: ViewerMode }> = [
  { label: "Concept", value: "concept" },
  { label: "Mesh", value: "mesh" },
  { label: "Simulation", value: "simulation" }
];

function App() {
  const [credits, setCredits] = React.useState<CreditBalance>({
    available: 184,
    reserved: 0
  });

  const [projects, setProjects] = React.useState<ProjectSummary[]>([]);
  const [activeProjectId, setActiveProjectId] = React.useState<string>("proj_0001");

  const [generations, setGenerations] = React.useState<GenerationSummary[]>([]);
  const [selectedGenerationId, setSelectedGenerationId] = React.useState<string | null>(null);

  const [loadingWorkspace, setLoadingWorkspace] = React.useState(true);
  const [submittingGeneration, setSubmittingGeneration] = React.useState(false);
  const [submittingIteration, setSubmittingIteration] = React.useState(false);
  const [submittingExport, setSubmittingExport] = React.useState(false);

  const [selectedFamily, setSelectedFamily] = React.useState("nosecone");
  const [exportFormat, setExportFormat] =
    React.useState<(typeof EXPORT_OPTIONS)[number]["value"]>("stl");
  const [viewerMode, setViewerMode] = React.useState<ViewerMode>("concept");

  const [form, setForm] = React.useState<GenerationInput>({
    componentFamily: "nosecone",
    componentName: "HAF-NC-01",
    lengthMm: 1200,
    baseDiameterMm: 320,
    wallThicknessMm: 3.4,
    material: "PEEK-CF",
    targetMassKg: 8.6
  });

  const activeProject = React.useMemo(
    () => projects.find((project) => project.id === activeProjectId) ?? null,
    [projects, activeProjectId]
  );

  const selectedGeneration = React.useMemo(
    () => generations.find((generation) => generation.id === selectedGenerationId) ?? null,
    [generations, selectedGenerationId]
  );

  const latestGeneration = generations[0] ?? null;
  const displayGeneration = selectedGeneration ?? latestGeneration;

  const selectedMeta =
    componentRegistry.find((item) => item.key === selectedFamily) ?? componentRegistry[0];

  const validationMessages = displayGeneration?.result?.validations ?? [];

  React.useEffect(() => {
    void loadWorkspace();
  }, []);

  React.useEffect(() => {
    const registryItem = componentRegistry.find((item) => item.key === selectedFamily);
    if (!registryItem) return;

    setForm((prev) => ({
      ...registryItem.defaultInput,
      componentName:
        prev.componentFamily === registryItem.defaultInput.componentFamily
          ? prev.componentName
          : registryItem.defaultInput.componentName
    }));
  }, [selectedFamily]);

  React.useEffect(() => {
    if (!activeProjectId) return;
    void loadGenerations(activeProjectId);
  }, [activeProjectId]);

  React.useEffect(() => {
    const runningGeneration = generations.find(
      (generation) => generation.status === "queued" || generation.status === "running"
    );

    if (!runningGeneration) return;

    const timer = window.setInterval(() => {
      void loadCredits();
      void loadGenerations(activeProjectId);
    }, 1500);

    return () => window.clearInterval(timer);
  }, [generations, activeProjectId]);

  async function loadWorkspace() {
    setLoadingWorkspace(true);

    try {
      await Promise.all([loadCredits(), loadProjects()]);
    } finally {
      setLoadingWorkspace(false);
    }
  }

  async function loadCredits() {
    try {
      const response = await fetch(`${API_BASE}/credits/balance`);
      const data = await response.json();

      if (data.credits) {
        setCredits(data.credits);
      }
    } catch {
      // keep starter values
    }
  }

  async function loadProjects() {
    try {
      const response = await fetch(`${API_BASE}/projects`);
      const data = await response.json();

      if (Array.isArray(data.projects) && data.projects.length > 0) {
        setProjects(data.projects);

        setActiveProjectId((current) => {
          const stillExists = data.projects.some(
            (project: ProjectSummary) => project.id === current
          );
          return stillExists ? current : data.projects[0].id;
        });
      }
    } catch {
      // keep starter state
    }
  }

  async function loadGenerations(projectId: string) {
    try {
      const response = await fetch(
        `${API_BASE}/generations?projectId=${encodeURIComponent(projectId)}`
      );
      const data = await response.json();

      if (Array.isArray(data.generations)) {
        setGenerations(data.generations);

        setSelectedGenerationId((current) => {
          if (
            current &&
            data.generations.some((generation: GenerationSummary) => generation.id === current)
          ) {
            return current;
          }
          return data.generations[0]?.id ?? null;
        });
      }
    } catch {
      // keep current state
    }
  }

  function syncFormFromGeneration(generation: GenerationSummary) {
    setForm(generation.input);
    setSelectedFamily(generation.input.componentFamily);
  }

  async function handleGenerateConcept() {
    if (!activeProjectId) {
      alert("No active project is loaded.");
      return;
    }

    setSubmittingGeneration(true);

    try {
      const response = await fetch(`${API_BASE}/generations`, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          projectId: activeProjectId,
          input: form
        })
      });

      const data = await response.json();

      if (!response.ok) {
        alert(typeof data.error === "string" ? data.error : "Generation request failed.");
        return;
      }

      await Promise.all([loadCredits(), loadGenerations(activeProjectId)]);

      if (data.generation?.id) {
        setSelectedGenerationId(data.generation.id);
      }
    } catch {
      alert("Could not reach the API.");
    } finally {
      setSubmittingGeneration(false);
    }
  }

  async function handleCreateIteration() {
    if (!activeProjectId) {
      alert("No active project is loaded.");
      return;
    }

    if (!displayGeneration) {
      alert("Select a generation before creating an iteration.");
      return;
    }

    setSubmittingIteration(true);

    try {
      const response = await fetch(`${API_BASE}/iterations`, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          projectId: activeProjectId,
          parentGenerationId: displayGeneration.id,
          input: form
        })
      });

      const data = await response.json();

      if (!response.ok) {
        alert(typeof data.error === "string" ? data.error : "Iteration request failed.");
        return;
      }

      await Promise.all([loadCredits(), loadGenerations(activeProjectId)]);

      if (data.generation?.id) {
        setSelectedGenerationId(data.generation.id);
      }
    } catch {
      alert("Could not reach the API.");
    } finally {
      setSubmittingIteration(false);
    }
  }

  async function handleQueueExport() {
    if (!displayGeneration) {
      alert("Select a completed generation before queueing export.");
      return;
    }

    if (displayGeneration.status !== "completed") {
      alert("Exports can only be queued for completed generations.");
      return;
    }

    setSubmittingExport(true);

    try {
      const response = await fetch(`${API_BASE}/exports`, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          generationId: displayGeneration.id,
          format: exportFormat
        })
      });

      const data = await response.json();

      if (!response.ok) {
        alert(typeof data.error === "string" ? data.error : "Export queue request failed.");
        return;
      }

      await loadGenerations(activeProjectId);
      alert(`Export queued: ${data.export?.filename ?? "artifact"}`);
    } catch {
      alert("Could not reach the API.");
    } finally {
      setSubmittingExport(false);
    }
  }

  function statusTone(status?: string) {
    if (status === "completed") return "success";
    if (status === "failed") return "warning";
    return "neutral";
  }

  return (
    <AppShell>
      <div className="workspace-page">
        <header className="topbar">
          <div className="topbar-title-group">
            <div className="eyebrow">Helvarix Systems</div>
            <h1>{appName}</h1>
          </div>

          <div className="topbar-meta">
            <span>Workspace: {activeProject?.workspaceLabel ?? "Fabrication Bay 01"}</span>
            <span>Project: {activeProject?.name ?? "—"}</span>
            <span>Credits: {credits.available}</span>
            <span>Reserved: {credits.reserved}</span>
          </div>
        </header>

        <main className="workspace-grid">
          <WorkspacePanel
            title="Parameters"
            subtitle="Define printable geometry constraints for additive manufacturing."
            footer={
              <BlackButton
                onClick={handleGenerateConcept}
                disabled={submittingGeneration || loadingWorkspace}
              >
                {submittingGeneration ? "Submitting..." : "Generate Concept"}
              </BlackButton>
            }
          >
            <SidebarSection title="Workspace">
              <SelectField
                label="Active Project"
                defaultValue={activeProjectId}
                options={
                  projects.length
                    ? projects.map((project) => ({
                        label: `${project.name} · ${project.workspaceLabel}`,
                        value: project.id
                      }))
                    : [
                        {
                          label: "Lunar Nosecone Study · Fabrication Bay 01",
                          value: "proj_0001"
                        }
                      ]
                }
                onChange={(value) => setActiveProjectId(value)}
              />
              <MetricRow
                label="Project Family"
                value={activeProject?.componentFamily ?? form.componentFamily}
              />
              <MetricRow label="Manufacturing Mode" value="Additive / 3D Printing" />
            </SidebarSection>

            <SidebarSection title="Component">
              <SelectField
                label="Component Family"
                defaultValue={selectedFamily}
                options={componentRegistry.map((item) => ({
                  label: item.label,
                  value: item.key
                }))}
                onChange={(value) => setSelectedFamily(value)}
              />
              <InputField
                label="Component Name"
                value={form.componentName}
                onChange={(value) =>
                  setForm((prev) => ({
                    ...prev,
                    componentName: value
                  }))
                }
              />
            </SidebarSection>

            <SidebarSection title="Dimensions">
              <InputField
                label="Length (mm)"
                type="number"
                value={form.lengthMm}
                onChange={(value) =>
                  setForm((prev) => ({
                    ...prev,
                    lengthMm: Number(value)
                  }))
                }
              />
              <InputField
                label="Base Diameter (mm)"
                type="number"
                value={form.baseDiameterMm}
                onChange={(value) =>
                  setForm((prev) => ({
                    ...prev,
                    baseDiameterMm: Number(value)
                  }))
                }
              />
              <InputField
                label="Wall Thickness (mm)"
                type="number"
                value={form.wallThicknessMm}
                onChange={(value) =>
                  setForm((prev) => ({
                    ...prev,
                    wallThicknessMm: Number(value)
                  }))
                }
              />
            </SidebarSection>

            <SidebarSection title="Material">
              <SelectField
                label="Build Material"
                defaultValue={form.material}
                options={MATERIAL_OPTIONS}
                onChange={(value) =>
                  setForm((prev) => ({
                    ...prev,
                    material: value
                  }))
                }
              />
              <InputField
                label="Target Mass (kg)"
                type="number"
                value={form.targetMassKg}
                onChange={(value) =>
                  setForm((prev) => ({
                    ...prev,
                    targetMassKg: Number(value)
                  }))
                }
              />
            </SidebarSection>

            <SidebarSection title="Fabrication Profile">
              <MetricRow label="Profile" value={selectedMeta.label} />
              <MetricRow label="Mode" value="Concept Geometry" />
              <MetricRow
                label="Printable State"
                value={
                  displayGeneration?.status === "completed"
                    ? "Validated Concept"
                    : "Pending Generation"
                }
              />
            </SidebarSection>
          </WorkspacePanel>

          <section className="center-column">
            <div className="center-toolbar">
              <span>Fabricator Workspace / Geometry Preview</span>
              <span>Run Mode: {displayGeneration?.status ?? "idle"}</span>
            </div>

            <div className="viewer-mode-row">
              {VIEW_MODE_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  className={`viewer-mode-button ${
                    viewerMode === option.value ? "viewer-mode-button-active" : ""
                  }`}
                  onClick={() => setViewerMode(option.value)}
                >
                  {option.label}
                </button>
              ))}
            </div>

            <GraphPaperRoom
              title={displayGeneration?.componentName ?? form.componentName}
              geometry={displayGeneration?.result?.geometry}
              mode={viewerMode}
              status={displayGeneration?.status ?? "idle"}
            />

            <div className="statusbar">
              <span>Status: {(displayGeneration?.status ?? "idle").toUpperCase()}</span>
              <span>Generation: {displayGeneration?.id ?? "—"}</span>
              <span>
                Updated: {displayGeneration ? formatTimestamp(displayGeneration.updatedAt) : "—"}
              </span>
            </div>
          </section>

          <WorkspacePanel
            title="Results"
            subtitle="Validation, lineage, and additive export status."
          >
            <SidebarSection title="Selected Run">
              <MetricRow label="Revision" value={displayGeneration?.result?.revision ?? "—"} />
              <MetricRow label="Status" value={displayGeneration?.status ?? "—"} />
              <MetricRow
                label="Export State"
                value={displayGeneration?.result?.exportState ?? "—"}
              />
              <MetricRow
                label="Token Cost"
                value={displayGeneration ? String(displayGeneration.tokenCost) : "—"}
              />
              <MetricRow
                label="Estimated Mass"
                value={
                  displayGeneration?.result?.estimatedMassKg !== undefined
                    ? `${displayGeneration.result.estimatedMassKg} kg`
                    : "—"
                }
              />
              <MetricRow
                label="Parent Run"
                value={displayGeneration?.parentGenerationId ?? "Root Concept"}
              />
            </SidebarSection>

            <SimulationPanel apiBase={API_BASE} input={form} />

            <SidebarSection title="Validation">
              {validationMessages.length ? (
                validationMessages.map((message, index) => (
                  <div key={index} className={`message message-${message.severity}`}>
                    <div className="message-title">{message.title}</div>
                    <div className="message-body">{message.text}</div>
                  </div>
                ))
              ) : (
                <div className="message">
                  <div className="message-title">Awaiting Generation</div>
                  <div className="message-body">
                    Submit a concept run to generate printable geometry and validation output.
                  </div>
                </div>
              )}
            </SidebarSection>

            <SidebarSection title="Export">
              <SelectField
                label="Export Format"
                defaultValue={exportFormat}
                options={EXPORT_OPTIONS.map((item) => ({
                  label: item.label,
                  value: item.value
                }))}
                onChange={(value) => setExportFormat(value as "stl" | "step" | "json")}
              />
              <MetricRow
                label="Export Readiness"
                value={displayGeneration?.status === "completed" ? "Ready To Queue" : "Generation Required"}
              />
            </SidebarSection>

            <SidebarSection title="Generation History">
              {generations.length ? (
                <div className="history-list">
                  {generations.map((generation) => {
                    const isActive = generation.id === displayGeneration?.id;

                    return (
                      <button
                        key={generation.id}
                        type="button"
                        className={`history-item ${isActive ? "history-item-active" : ""}`}
                        onClick={() => {
                          setSelectedGenerationId(generation.id);
                          syncFormFromGeneration(generation);
                        }}
                      >
                        <div className="history-item-top">
                          <span className="history-item-name">
                            {generation.componentName}
                          </span>
                          <span
                            className={`history-chip history-chip-${statusTone(
                              generation.status
                            )}`}
                          >
                            {generation.status}
                          </span>
                        </div>

                        <div className="history-item-meta">
                          <span>{generation.id}</span>
                          <span>{formatTimestamp(generation.updatedAt)}</span>
                        </div>

                        <div className="history-item-meta">
                          <span>{generation.input.componentFamily}</span>
                          <span>{generation.tokenCost} credits</span>
                        </div>
                      </button>
                    );
                  })}
                </div>
              ) : (
                <div className="message">
                  <div className="message-title">No Runs</div>
                  <div className="message-body">
                    This project does not have any generation history yet.
                  </div>
                </div>
              )}
            </SidebarSection>

            <SidebarSection title="Actions">
              <div className="actions">
                <BlackButton
                  subdued
                  onClick={handleQueueExport}
                  disabled={
                    !displayGeneration ||
                    displayGeneration.status !== "completed" ||
                    submittingExport
                  }
                >
                  {submittingExport ? "Queueing Export..." : "Queue Export"}
                </BlackButton>

                <BlackButton
                  subdued
                  onClick={handleCreateIteration}
                  disabled={!displayGeneration || submittingIteration}
                >
                  {submittingIteration ? "Creating Iteration..." : "Create Iteration"}
                </BlackButton>
              </div>
            </SidebarSection>
          </WorkspacePanel>
        </main>
      </div>
    </AppShell>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
