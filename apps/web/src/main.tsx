import React from "react";
import ReactDOM from "react-dom/client";
import {
  SimulationPanel,
  type SimulationPanelHandle
} from "./components/workspace/SimulationPanel";
import type { SimulationRecord } from "./lib/simulationClient";
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

const API_BASE = "https://helvarix-advanced-fabricator.helvarixsystems.workers.dev";

const MATERIAL_OPTIONS = [
  { label: "PEEK-CF", value: "PEEK-CF" },
  { label: "AlSi10Mg", value: "AlSi10Mg" },
  { label: "Ti-6Al-4V", value: "Ti-6Al-4V" },
  { label: "Inconel 718", value: "Inconel 718" }
];

const EXPORT_OPTIONS = [
  { label: "Complete Package", value: "package" },
  { label: "STL", value: "stl" },
  { label: "STEP", value: "step" },
  { label: "JSON", value: "json" }
] as const;

const VIEW_MODE_OPTIONS: Array<{ label: string; value: ViewerMode }> = [
  { label: "Concept", value: "concept" },
  { label: "Mesh", value: "mesh" },
  { label: "Simulation", value: "simulation" }
];

type ExportFormat = (typeof EXPORT_OPTIONS)[number]["value"];
type RightPanelTab = "summary" | "simulation" | "validation" | "export" | "history";

const RIGHT_PANEL_TABS: Array<{ label: string; value: RightPanelTab }> = [
  { label: "Summary", value: "summary" },
  { label: "Simulation", value: "simulation" },
  { label: "Validation", value: "validation" },
  { label: "Export", value: "export" },
  { label: "History", value: "history" }
];

function App() {
  const simulationPanelRef = React.useRef<SimulationPanelHandle | null>(null);

  const [credits, setCredits] = React.useState<CreditBalance>({
    available: 184,
    reserved: 0
  });

  const [projects, setProjects] = React.useState<ProjectSummary[]>([]);
  const [activeProjectId, setActiveProjectId] = React.useState<string>("proj_0001");

  const [generations, setGenerations] = React.useState<GenerationSummary[]>([]);
  const [selectedGenerationId, setSelectedGenerationId] = React.useState<string | null>(null);
  const [latestSimulation, setLatestSimulation] = React.useState<SimulationRecord | null>(null);

  const [loadingWorkspace, setLoadingWorkspace] = React.useState(true);
  const [submittingGeneration, setSubmittingGeneration] = React.useState(false);
  const [submittingIteration, setSubmittingIteration] = React.useState(false);
  const [submittingExport, setSubmittingExport] = React.useState(false);

  const [selectedFamily, setSelectedFamily] = React.useState("nosecone");
  const [exportFormat, setExportFormat] = React.useState<ExportFormat>("package");
  const [viewerMode, setViewerMode] = React.useState<ViewerMode>("concept");
  const [rightPanelTab, setRightPanelTab] = React.useState<RightPanelTab>("summary");

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
      if (data.credits) setCredits(data.credits);
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
        setActiveProjectId((current) =>
          data.projects.some((project: ProjectSummary) => project.id === current)
            ? current
            : data.projects[0].id
        );
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
        headers: { "content-type": "application/json" },
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
        headers: { "content-type": "application/json" },
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

  async function handleRunSimulationFromFooter() {
    setRightPanelTab("simulation");
    await simulationPanelRef.current?.run();
  }

  async function handleExportPackage() {
    if (!displayGeneration) {
      alert("Select a completed generation before exporting.");
      return;
    }

    if (displayGeneration.status !== "completed") {
      alert("Exports can only be created for completed generations.");
      return;
    }

    setSubmittingExport(true);

    try {
      let queuedExport: unknown = null;

      const serverFormat = exportFormat === "package" ? "stl" : exportFormat;

      try {
        const response = await fetch(`${API_BASE}/exports`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            generationId: displayGeneration.id,
            format: serverFormat
          })
        });

        const data = await response.json();

        if (!response.ok) {
          alert(typeof data.error === "string" ? data.error : "Export request failed.");
          return;
        }

        queuedExport = data.export ?? null;
        await loadGenerations(activeProjectId);
      } catch {
        queuedExport = {
          mode: "local-package-only",
          note: "API export queue unavailable; local package was still generated."
        };
      }

      const packageName = `${safeFileName(displayGeneration.componentName)}-${displayGeneration.id}`;

      if (exportFormat === "package") {
        await downloadCompletePackage({
          packageName,
          generation: displayGeneration,
          project: activeProject,
          simulation: latestSimulation,
          queuedExport
        });
      } else if (exportFormat === "json") {
        downloadBlob(
          `${packageName}.json`,
          "application/json",
          JSON.stringify(
            {
              project: activeProject,
              generation: displayGeneration,
              simulation: latestSimulation,
              export: queuedExport
            },
            null,
            2
          )
        );
      } else if (exportFormat === "stl") {
        downloadBlob(
          `${packageName}.stl`,
          "model/stl",
          buildPreviewStl(displayGeneration)
        );
      } else {
        downloadBlob(
          `${packageName}.step`,
          "text/plain",
          buildPlaceholderStep(displayGeneration)
        );
      }
    } finally {
      setSubmittingExport(false);
    }
  }

  function getRightPanelFooter() {
    if (rightPanelTab === "simulation") {
      return (
        <BlackButton subdued onClick={handleRunSimulationFromFooter}>
          Run Simulation
        </BlackButton>
      );
    }

    if (rightPanelTab === "export") {
      return (
        <BlackButton
          subdued
          onClick={handleExportPackage}
          disabled={!displayGeneration || displayGeneration.status !== "completed" || submittingExport}
        >
          {submittingExport ? "Exporting..." : "Export"}
        </BlackButton>
      );
    }

    return null;
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
            subtitle="Tabbed validation, lineage, simulation, and export status."
            footer={getRightPanelFooter()}
          >
            <div className="right-panel-tabs" role="tablist" aria-label="Results panel tabs">
              {RIGHT_PANEL_TABS.map((tab) => (
                <button
                  key={tab.value}
                  type="button"
                  className={`right-panel-tab ${
                    rightPanelTab === tab.value ? "right-panel-tab-active" : ""
                  }`}
                  onClick={() => setRightPanelTab(tab.value)}
                >
                  {tab.label}
                </button>
              ))}
            </div>

            <div className="right-panel-body">
              {rightPanelTab === "summary" ? (
                <>
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

                  <SidebarSection title="Readiness">
                    <div className="compact-score-card">
                      <span>Current Viewer</span>
                      <strong>{viewerMode.toUpperCase()}</strong>
                    </div>
                    <div className="message message-success">
                      <div className="message-title">Workflow Alignment</div>
                      <div className="message-body">
                        Generate constraint-filtered geometry, validate manufacturability, run
                        simulation, then export the complete artifact package.
                      </div>
                    </div>
                  </SidebarSection>
                </>
              ) : null}

              {rightPanelTab === "simulation" ? (
                <SimulationPanel
                  ref={simulationPanelRef}
                  apiBase={API_BASE}
                  input={form}
                  onSimulationChange={setLatestSimulation}
                />
              ) : null}

              {rightPanelTab === "validation" ? (
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
              ) : null}

              {rightPanelTab === "export" ? (
                <>
                  <SidebarSection title="Export Package">
                    <SelectField
                      label="Export Type"
                      defaultValue={exportFormat}
                      options={EXPORT_OPTIONS.map((item) => ({
                        label: item.label,
                        value: item.value
                      }))}
                      onChange={(value) => setExportFormat(value as ExportFormat)}
                    />
                    <MetricRow
                      label="Export Readiness"
                      value={
                        displayGeneration?.status === "completed"
                          ? "Ready To Export"
                          : "Generation Required"
                      }
                    />
                    <MetricRow
                      label="Package Contents"
                      value={
                        exportFormat === "package"
                          ? "STL, report, geometry JSON, simulation JSON"
                          : exportFormat.toUpperCase()
                      }
                    />
                  </SidebarSection>

                  <SidebarSection title="Iteration">
                    <BlackButton
                      subdued
                      onClick={handleCreateIteration}
                      disabled={!displayGeneration || submittingIteration}
                    >
                      {submittingIteration ? "Creating Iteration..." : "Create Iteration"}
                    </BlackButton>
                  </SidebarSection>
                </>
              ) : null}

              {rightPanelTab === "history" ? (
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
                              <span className="history-item-name">{generation.componentName}</span>
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
              ) : null}
            </div>
          </WorkspacePanel>
        </main>
      </div>
    </AppShell>
  );
}

function safeFileName(value: string) {
  return value.replace(/[^a-z0-9-_]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase();
}

function downloadBlob(filename: string, mimeType: string, content: string | Blob) {
  const blob = content instanceof Blob ? content : new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");

  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();

  window.setTimeout(() => URL.revokeObjectURL(url), 250);
}

async function downloadCompletePackage(args: {
  packageName: string;
  generation: GenerationSummary;
  project: ProjectSummary | null;
  simulation: SimulationRecord | null;
  queuedExport: unknown;
}) {
  const { packageName, generation, project, simulation, queuedExport } = args;

  const report = buildReportText(generation, project, simulation);
  const stl = buildPreviewStl(generation);

  const files = [
    {
      name: "geometry/part-preview.stl",
      content: stl
    },
    {
      name: "reports/validation-report.txt",
      content: report
    },
    {
      name: "reports/generation.json",
      content: JSON.stringify(generation, null, 2)
    },
    {
      name: "reports/project.json",
      content: JSON.stringify(project, null, 2)
    },
    {
      name: "simulation/simulation.json",
      content: JSON.stringify(simulation ?? { status: "not-run" }, null, 2)
    },
    {
      name: "export/export-record.json",
      content: JSON.stringify(queuedExport, null, 2)
    },
    {
      name: "manifest.json",
      content: JSON.stringify(
        {
          packageName,
          generatedAt: new Date().toISOString(),
          generationId: generation.id,
          componentName: generation.componentName,
          contents: [
            "geometry/part-preview.stl",
            "reports/validation-report.txt",
            "reports/generation.json",
            "reports/project.json",
            "simulation/simulation.json",
            "export/export-record.json"
          ]
        },
        null,
        2
      )
    }
  ];

  const zip = createZip(files);
  downloadBlob(`${packageName}-complete-package.zip`, "application/zip", zip);
}

function buildReportText(
  generation: GenerationSummary,
  project: ProjectSummary | null,
  simulation: SimulationRecord | null
) {
  const validations = generation.result?.validations ?? [];

  return [
    "HELVARIX ADVANCED FABRICATOR",
    "VALIDATION AND EXPORT REPORT",
    "",
    `Project: ${project?.name ?? "Unknown"}`,
    `Workspace: ${project?.workspaceLabel ?? "Unknown"}`,
    `Generation ID: ${generation.id}`,
    `Component: ${generation.componentName}`,
    `Status: ${generation.status}`,
    `Revision: ${generation.result?.revision ?? "n/a"}`,
    `Estimated Mass: ${generation.result?.estimatedMassKg ?? "n/a"} kg`,
    `Export State: ${generation.result?.exportState ?? "n/a"}`,
    "",
    "INPUT",
    JSON.stringify(generation.input, null, 2),
    "",
    "VALIDATION",
    validations.length
      ? validations.map((item) => `[${item.severity.toUpperCase()}] ${item.title}: ${item.text}`).join("\n")
      : "No validation messages available.",
    "",
    "SIMULATION",
    simulation ? JSON.stringify(simulation, null, 2) : "No simulation record available."
  ].join("\n");
}

function buildPreviewStl(generation: GenerationSummary) {
  const radius = Math.max(1, generation.input.baseDiameterMm / 2);
  const height = Math.max(1, generation.input.lengthMm);
  const name = safeFileName(generation.componentName || "haf-part");

  return [
    `solid ${name}`,
    `  facet normal 0 0 1`,
    `    outer loop`,
    `      vertex 0 0 ${height}`,
    `      vertex ${radius} 0 0`,
    `      vertex 0 ${radius} 0`,
    `    endloop`,
    `  endfacet`,
    `  facet normal 0 0 1`,
    `    outer loop`,
    `      vertex 0 0 ${height}`,
    `      vertex 0 ${radius} 0`,
    `      vertex ${-radius} 0 0`,
    `    endloop`,
    `  endfacet`,
    `  facet normal 0 0 1`,
    `    outer loop`,
    `      vertex 0 0 ${height}`,
    `      vertex ${-radius} 0 0`,
    `      vertex 0 ${-radius} 0`,
    `    endloop`,
    `  endfacet`,
    `  facet normal 0 0 1`,
    `    outer loop`,
    `      vertex 0 0 ${height}`,
    `      vertex 0 ${-radius} 0`,
    `      vertex ${radius} 0 0`,
    `    endloop`,
    `  endfacet`,
    `endsolid ${name}`
  ].join("\n");
}

function buildPlaceholderStep(generation: GenerationSummary) {
  return [
    "ISO-10303-21;",
    "HEADER;",
    `FILE_DESCRIPTION(('Helvarix preview STEP placeholder for ${generation.componentName}'),'2;1');`,
    `FILE_NAME('${generation.componentName}.step','${new Date().toISOString()}',('Helvarix Systems'),('Helvarix Advanced Fabricator'),'HAF','HAF','');`,
    "FILE_SCHEMA(('CONFIG_CONTROL_DESIGN'));",
    "ENDSEC;",
    "DATA;",
    "/* Full STEP generation should be produced by the production geometry/export backend. */",
    `/* Generation ID: ${generation.id} */`,
    "ENDSEC;",
    "END-ISO-10303-21;"
  ].join("\n");
}

function createZip(files: Array<{ name: string; content: string }>) {
  const encoder = new TextEncoder();
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;

  for (const file of files) {
    const nameBytes = encoder.encode(file.name);
    const data = encoder.encode(file.content);
    const crc = crc32(data);

    const localHeader = new Uint8Array(30 + nameBytes.length);
    const local = new DataView(localHeader.buffer);

    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0, true);
    local.setUint16(8, 0, true);
    local.setUint16(10, 0, true);
    local.setUint16(12, 0, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, data.length, true);
    local.setUint16(26, nameBytes.length, true);
    local.setUint16(28, 0, true);
    localHeader.set(nameBytes, 30);

    localParts.push(localHeader, data);

    const centralHeader = new Uint8Array(46 + nameBytes.length);
    const central = new DataView(centralHeader.buffer);

    central.setUint32(0, 0x02014b50, true);
    central.setUint16(4, 20, true);
    central.setUint16(6, 20, true);
    central.setUint16(8, 0, true);
    central.setUint16(10, 0, true);
    central.setUint16(12, 0, true);
    central.setUint16(14, 0, true);
    central.setUint32(16, crc, true);
    central.setUint32(20, data.length, true);
    central.setUint32(24, data.length, true);
    central.setUint16(28, nameBytes.length, true);
    central.setUint16(30, 0, true);
    central.setUint16(32, 0, true);
    central.setUint16(34, 0, true);
    central.setUint16(36, 0, true);
    central.setUint32(38, 0, true);
    central.setUint32(42, offset, true);
    centralHeader.set(nameBytes, 46);

    centralParts.push(centralHeader);
    offset += localHeader.length + data.length;
  }

  const centralOffset = offset;
  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);

  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);

  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, files.length, true);
  endView.setUint16(10, files.length, true);
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, centralOffset, true);
  endView.setUint16(20, 0, true);

  return new Blob([...localParts, ...centralParts, end], { type: "application/zip" });
}

function crc32(data: Uint8Array) {
  let crc = 0xffffffff;

  for (const byte of data) {
    crc ^= byte;

    for (let index = 0; index < 8; index += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }

  return (crc ^ 0xffffffff) >>> 0;
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
