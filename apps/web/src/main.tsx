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
  type BellNozzleRequirements,
  type CandidateGeometry,
  type ComponentFamily,
  type CreditBalance,
  type GenerationInput,
  type GenerationResult,
  type GenerationSummary,
  type ProjectSummary,
  type StructuralBracketRequirements
} from "@haf/shared";
import { componentRegistry } from "@haf/component-registry";
import "./styles.css";

const API_BASE = "https://helvarix-advanced-fabricator.helvarixsystems.workers.dev";

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
type RightPanelTab = "summary" | "simulation" | "validation" | "export" | "candidates";

const RIGHT_PANEL_TABS: Array<{ label: string; value: RightPanelTab }> = [
  { label: "Summary", value: "summary" },
  { label: "Simulation", value: "simulation" },
  { label: "Validation", value: "validation" },
  { label: "Export", value: "export" },
  { label: "Candidates", value: "candidates" }
];

const PRIMARY_BUTTON_STYLE: React.CSSProperties = {
  color: "#ffffff",
  fontWeight: 700
};

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
  const [generationStartedAt, setGenerationStartedAt] = React.useState<number | null>(null);
  const [generationElapsedMs, setGenerationElapsedMs] = React.useState(0);
  const [generationNoticeDismissed, setGenerationNoticeDismissed] = React.useState(false);

  const [selectedFamily, setSelectedFamily] = React.useState<ComponentFamily>(
    componentRegistry[0].key
  );
  const [exportFormat, setExportFormat] = React.useState<ExportFormat>("package");
  const [viewerMode, setViewerMode] = React.useState<ViewerMode>("concept");
  const [rightPanelTab, setRightPanelTab] = React.useState<RightPanelTab>("summary");

  const [form, setForm] = React.useState<GenerationInput>(componentRegistry[0].defaultInput);

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
  const result = displayGeneration?.result ?? null;
  const generationInProgress =
    submittingGeneration ||
    submittingIteration ||
    displayGeneration?.status === "queued" ||
    displayGeneration?.status === "running";
  const generationProgress = getGenerationProgress({
    status: displayGeneration?.status,
    submitting: submittingGeneration || submittingIteration,
    elapsedMs: generationElapsedMs,
    result
  });
  const showGenerationProgress = generationInProgress && !generationNoticeDismissed;

  React.useEffect(() => {
    void loadWorkspace();
  }, []);

  React.useEffect(() => {
    const registryItem = componentRegistry.find((item) => item.key === selectedFamily);
    if (!registryItem) return;
    setForm(registryItem.defaultInput);
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

  React.useEffect(() => {
    if (!generationInProgress) {
      setGenerationStartedAt(null);
      setGenerationElapsedMs(0);
      setGenerationNoticeDismissed(false);
      return;
    }

    setGenerationNoticeDismissed(false);
    setGenerationStartedAt((current) => current ?? Date.now());
  }, [generationInProgress]);

  React.useEffect(() => {
    if (!generationInProgress || generationStartedAt === null) return;

    const tick = () => setGenerationElapsedMs(Date.now() - generationStartedAt);
    tick();

    const timer = window.setInterval(tick, 500);
    return () => window.clearInterval(timer);
  }, [generationInProgress, generationStartedAt]);

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
      // Keep starter values.
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
      // Keep starter state.
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
      // Keep current state.
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
    setGenerationStartedAt(Date.now());
    setGenerationElapsedMs(0);
    setGenerationNoticeDismissed(false);
    setViewerMode("concept");
    setRightPanelTab("candidates");

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
    setGenerationStartedAt(Date.now());
    setGenerationElapsedMs(0);
    setGenerationNoticeDismissed(false);
    setViewerMode("concept");
    setRightPanelTab("candidates");

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
    setViewerMode("simulation");
    setRightPanelTab("simulation");
    await simulationPanelRef.current?.run();
  }

  function handleViewerModeClick(mode: ViewerMode) {
    setViewerMode(mode);

    if (mode === "simulation") {
      setRightPanelTab("simulation");
    }
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
        downloadBlob(`${packageName}.stl`, "model/stl", buildPreviewStl(displayGeneration));
      } else {
        downloadBlob(`${packageName}.step`, "text/plain", buildPlaceholderStep(displayGeneration));
      }
    } finally {
      setSubmittingExport(false);
    }
  }

  function getRightPanelFooter() {
    if (rightPanelTab === "simulation") {
      return (
        <BlackButton subdued style={PRIMARY_BUTTON_STYLE} onClick={handleRunSimulationFromFooter}>
          Run Simulation
        </BlackButton>
      );
    }

    if (rightPanelTab === "export") {
      return (
        <BlackButton
          subdued
          style={PRIMARY_BUTTON_STYLE}
          onClick={handleExportPackage}
          disabled={!displayGeneration || displayGeneration.status !== "completed" || submittingExport}
        >
          {submittingExport ? "Exporting..." : "Export"}
        </BlackButton>
      );
    }

    return null;
  }

  function updateStructuralRequirements(
    updater: (requirements: StructuralBracketRequirements) => StructuralBracketRequirements
  ) {
    setForm((current) => {
      if (current.componentFamily === "bell-nozzle") return current;

      return {
        ...current,
        requirements: updater(current.requirements)
      };
    });
  }

  function updateBellRequirements(
    updater: (requirements: BellNozzleRequirements) => BellNozzleRequirements
  ) {
    setForm((current) => {
      if (current.componentFamily !== "bell-nozzle") return current;

      return {
        ...current,
        requirements: updater(current.requirements)
      };
    });
  }

  function statusTone(status?: string) {
    if (status === "completed") return "success";
    if (status === "failed") return "warning";
    return "neutral";
  }

  const componentName = getInputComponentName(form);

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
            title="Requirements"
            subtitle="Tell the system what the object must do. The engine derives geometry."
            footer={
              <BlackButton
                style={PRIMARY_BUTTON_STYLE}
                onClick={handleGenerateConcept}
                disabled={submittingGeneration || loadingWorkspace}
              >
                {submittingGeneration ? "Generating..." : "Generate Design"}
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
                          label: "Requirements-First Demo · Fabrication Bay 01",
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
              <MetricRow label="Design Mode" value="Requirements → Candidate Search" />
            </SidebarSection>

            <SidebarSection title="Component">
              <SelectField
                label="Component Family"
                defaultValue={selectedFamily}
                options={componentRegistry.map((item) => ({
                  label: item.label,
                  value: item.key
                }))}
                onChange={(value) => setSelectedFamily(value as ComponentFamily)}
              />
              <InputField
                label="Component Name"
                value={componentName}
                onChange={(value) => {
                  if (form.componentFamily === "bell-nozzle") {
                    updateBellRequirements((requirements) => ({
                      ...requirements,
                      componentName: value
                    }));
                  } else {
                    updateStructuralRequirements((requirements) => ({
                      ...requirements,
                      componentName: value
                    }));
                  }
                }}
              />
            </SidebarSection>

            {form.componentFamily === "bell-nozzle" ? (
              <>
                <SidebarSection title="Performance Requirement">
                  <InputField
                    label="Target Thrust (N)"
                    type="number"
                    value={form.requirements.performance.targetThrustN}
                    onChange={(value) =>
                      updateBellRequirements((requirements) => ({
                        ...requirements,
                        performance: {
                          ...requirements.performance,
                          targetThrustN: Number(value)
                        }
                      }))
                    }
                  />
                  <InputField
                    label="Burn Duration (sec)"
                    type="number"
                    value={form.requirements.performance.burnDurationSec}
                    onChange={(value) =>
                      updateBellRequirements((requirements) => ({
                        ...requirements,
                        performance: {
                          ...requirements.performance,
                          burnDurationSec: Number(value)
                        }
                      }))
                    }
                  />
                  <InputField
                    label="Chamber Pressure (bar)"
                    type="number"
                    value={form.requirements.performance.chamberPressureBar ?? 20}
                    onChange={(value) =>
                      updateBellRequirements((requirements) => ({
                        ...requirements,
                        performance: {
                          ...requirements.performance,
                          chamberPressureBar: Number(value)
                        }
                      }))
                    }
                  />
                  <InputField
                    label="Ambient Pressure (Pa)"
                    type="number"
                    value={form.requirements.performance.ambientPressurePa}
                    onChange={(value) =>
                      updateBellRequirements((requirements) => ({
                        ...requirements,
                        performance: {
                          ...requirements.performance,
                          ambientPressurePa: Number(value)
                        }
                      }))
                    }
                  />
                </SidebarSection>

                <SidebarSection title="Propellant / Thermal">
                  <SelectField
                    label="Oxidizer"
                    defaultValue={form.requirements.propellant.oxidizer}
                    options={[
                      { label: "LOX", value: "LOX" },
                      { label: "N2O", value: "N2O" },
                      { label: "H2O2", value: "H2O2" }
                    ]}
                    onChange={(value) =>
                      updateBellRequirements((requirements) => ({
                        ...requirements,
                        propellant: {
                          ...requirements.propellant,
                          oxidizer: value as BellNozzleRequirements["propellant"]["oxidizer"]
                        }
                      }))
                    }
                  />
                  <SelectField
                    label="Fuel"
                    defaultValue={form.requirements.propellant.fuel}
                    options={[
                      { label: "RP-1", value: "RP1" },
                      { label: "Methane", value: "CH4" },
                      { label: "Hydrogen", value: "H2" },
                      { label: "HTPB", value: "HTPB" }
                    ]}
                    onChange={(value) =>
                      updateBellRequirements((requirements) => ({
                        ...requirements,
                        propellant: {
                          ...requirements.propellant,
                          fuel: value as BellNozzleRequirements["propellant"]["fuel"]
                        }
                      }))
                    }
                  />
                  <InputField
                    label="Mixture Ratio"
                    type="number"
                    value={form.requirements.propellant.mixtureRatio ?? 2.6}
                    onChange={(value) =>
                      updateBellRequirements((requirements) => ({
                        ...requirements,
                        propellant: {
                          ...requirements.propellant,
                          mixtureRatio: Number(value)
                        }
                      }))
                    }
                  />
                  <SelectField
                    label="Cooling Mode"
                    defaultValue={form.requirements.thermal.coolingMode}
                    options={[
                      { label: "Ablative", value: "ablative" },
                      { label: "Regenerative", value: "regenerative" },
                      { label: "Radiative", value: "radiative" }
                    ]}
                    onChange={(value) =>
                      updateBellRequirements((requirements) => ({
                        ...requirements,
                        thermal: {
                          ...requirements.thermal,
                          coolingMode: value as BellNozzleRequirements["thermal"]["coolingMode"]
                        }
                      }))
                    }
                  />
                </SidebarSection>

                <SidebarSection title="Envelope / Manufacturing">
                  <InputField
                    label="Max Length (mm)"
                    type="number"
                    value={form.requirements.envelope.maxLengthMm}
                    onChange={(value) =>
                      updateBellRequirements((requirements) => ({
                        ...requirements,
                        envelope: {
                          ...requirements.envelope,
                          maxLengthMm: Number(value)
                        }
                      }))
                    }
                  />
                  <InputField
                    label="Max Exit Diameter (mm)"
                    type="number"
                    value={form.requirements.envelope.maxExitDiameterMm}
                    onChange={(value) =>
                      updateBellRequirements((requirements) => ({
                        ...requirements,
                        envelope: {
                          ...requirements.envelope,
                          maxExitDiameterMm: Number(value)
                        }
                      }))
                    }
                  />
                  <InputField
                    label="Minimum Wall (mm)"
                    type="number"
                    value={form.requirements.manufacturing.minWallThicknessMm}
                    onChange={(value) =>
                      updateBellRequirements((requirements) => ({
                        ...requirements,
                        manufacturing: {
                          ...requirements.manufacturing,
                          minWallThicknessMm: Number(value)
                        }
                      }))
                    }
                  />
                  <InputField
                    label="Safety Factor"
                    type="number"
                    value={form.requirements.safetyFactor}
                    onChange={(value) =>
                      updateBellRequirements((requirements) => ({
                        ...requirements,
                        safetyFactor: Number(value)
                      }))
                    }
                  />
                </SidebarSection>

                <SidebarSection title="Optimization">
                  <SelectField
                    label="Priority"
                    defaultValue={form.requirements.objectives.priority}
                    options={[
                      { label: "Balanced", value: "balanced" },
                      { label: "Efficiency", value: "efficiency" },
                      { label: "Compactness", value: "compactness" },
                      { label: "Thermal Margin", value: "thermal-margin" }
                    ]}
                    onChange={(value) =>
                      updateBellRequirements((requirements) => ({
                        ...requirements,
                        objectives: {
                          ...requirements.objectives,
                          priority: value as BellNozzleRequirements["objectives"]["priority"],
                          skeletonization: "sealed-required"
                        }
                      }))
                    }
                  />
                  <InputField
                    label="Target Mass (kg)"
                    type="number"
                    value={form.requirements.objectives.targetMassKg ?? 3.5}
                    onChange={(value) =>
                      updateBellRequirements((requirements) => ({
                        ...requirements,
                        objectives: {
                          ...requirements.objectives,
                          targetMassKg: Number(value),
                          skeletonization: "sealed-required"
                        }
                      }))
                    }
                  />
                </SidebarSection>
              </>
            ) : (
              <>
                <SidebarSection title="Load Requirement">
                  <InputField
                    label="Required Load (N)"
                    type="number"
                    value={form.requirements.loadCase.forceN}
                    onChange={(value) =>
                      updateStructuralRequirements((requirements) => ({
                        ...requirements,
                        loadCase: {
                          ...requirements.loadCase,
                          forceN: Number(value)
                        }
                      }))
                    }
                  />
                  <SelectField
                    label="Load Direction"
                    defaultValue={form.requirements.loadCase.direction}
                    options={[
                      { label: "Vertical", value: "vertical" },
                      { label: "Lateral", value: "lateral" },
                      { label: "Multi-Axis", value: "multi-axis" }
                    ]}
                    onChange={(value) =>
                      updateStructuralRequirements((requirements) => ({
                        ...requirements,
                        loadCase: {
                          ...requirements.loadCase,
                          direction: value as StructuralBracketRequirements["loadCase"]["direction"]
                        }
                      }))
                    }
                  />
                  <InputField
                    label="Vibration (Hz)"
                    type="number"
                    value={form.requirements.loadCase.vibrationHz ?? 0}
                    onChange={(value) =>
                      updateStructuralRequirements((requirements) => ({
                        ...requirements,
                        loadCase: {
                          ...requirements.loadCase,
                          vibrationHz: Number(value)
                        }
                      }))
                    }
                  />
                  <InputField
                    label="Safety Factor"
                    type="number"
                    value={form.requirements.safetyFactor}
                    onChange={(value) =>
                      updateStructuralRequirements((requirements) => ({
                        ...requirements,
                        safetyFactor: Number(value)
                      }))
                    }
                  />
                </SidebarSection>

                <SidebarSection title="Mounting Interface">
                  <InputField
                    label="Bolt Count"
                    type="number"
                    value={form.requirements.mounting.boltCount}
                    onChange={(value) =>
                      updateStructuralRequirements((requirements) => ({
                        ...requirements,
                        mounting: {
                          ...requirements.mounting,
                          boltCount: Number(value)
                        }
                      }))
                    }
                  />
                  <InputField
                    label="Bolt Diameter (mm)"
                    type="number"
                    value={form.requirements.mounting.boltDiameterMm}
                    onChange={(value) =>
                      updateStructuralRequirements((requirements) => ({
                        ...requirements,
                        mounting: {
                          ...requirements.mounting,
                          boltDiameterMm: Number(value)
                        }
                      }))
                    }
                  />
                  <InputField
                    label="Bolt Spacing (mm)"
                    type="number"
                    value={form.requirements.mounting.spacingMm}
                    onChange={(value) =>
                      updateStructuralRequirements((requirements) => ({
                        ...requirements,
                        mounting: {
                          ...requirements.mounting,
                          spacingMm: Number(value)
                        }
                      }))
                    }
                  />
                </SidebarSection>

                <SidebarSection title="Envelope">
                  <InputField
                    label="Max Width / X (mm)"
                    type="number"
                    value={form.requirements.envelope.maxWidthMm}
                    onChange={(value) =>
                      updateStructuralRequirements((requirements) => ({
                        ...requirements,
                        envelope: {
                          ...requirements.envelope,
                          maxWidthMm: Number(value)
                        }
                      }))
                    }
                  />
                  <InputField
                    label="Max Height / Y (mm)"
                    type="number"
                    value={form.requirements.envelope.maxHeightMm}
                    onChange={(value) =>
                      updateStructuralRequirements((requirements) => ({
                        ...requirements,
                        envelope: {
                          ...requirements.envelope,
                          maxHeightMm: Number(value)
                        }
                      }))
                    }
                  />
                  <InputField
                    label="Max Depth / Z (mm)"
                    type="number"
                    value={form.requirements.envelope.maxDepthMm}
                    onChange={(value) =>
                      updateStructuralRequirements((requirements) => ({
                        ...requirements,
                        envelope: {
                          ...requirements.envelope,
                          maxDepthMm: Number(value)
                        }
                      }))
                    }
                  />
                </SidebarSection>

                <SidebarSection title="Manufacturing / Optimization">
                  <InputField
                    label="Minimum Wall (mm)"
                    type="number"
                    value={form.requirements.manufacturing.minWallThicknessMm}
                    onChange={(value) =>
                      updateStructuralRequirements((requirements) => ({
                        ...requirements,
                        manufacturing: {
                          ...requirements.manufacturing,
                          minWallThicknessMm: Number(value)
                        }
                      }))
                    }
                  />
                  <InputField
                    label="Max Overhang (deg)"
                    type="number"
                    value={form.requirements.manufacturing.maxOverhangDeg}
                    onChange={(value) =>
                      updateStructuralRequirements((requirements) => ({
                        ...requirements,
                        manufacturing: {
                          ...requirements.manufacturing,
                          maxOverhangDeg: Number(value)
                        }
                      }))
                    }
                  />
                  <SelectField
                    label="Priority"
                    defaultValue={form.requirements.objectives.priority}
                    options={[
                      { label: "Balanced", value: "balanced" },
                      { label: "Lightweight", value: "lightweight" },
                      { label: "Stiffness", value: "stiffness" }
                    ]}
                    onChange={(value) =>
                      updateStructuralRequirements((requirements) => ({
                        ...requirements,
                        objectives: {
                          ...requirements.objectives,
                          priority: value as StructuralBracketRequirements["objectives"]["priority"]
                        }
                      }))
                    }
                  />
                  <SelectField
                    label="Skeletonization"
                    defaultValue={form.requirements.objectives.skeletonization ?? "auto"}
                    options={[
                      { label: "Auto", value: "auto" },
                      { label: "Aggressive", value: "aggressive" },
                      { label: "None", value: "none" },
                      { label: "Sealed Required", value: "sealed-required" }
                    ]}
                    onChange={(value) =>
                      updateStructuralRequirements((requirements) => ({
                        ...requirements,
                        objectives: {
                          ...requirements.objectives,
                          skeletonization:
                            value as StructuralBracketRequirements["objectives"]["skeletonization"]
                        }
                      }))
                    }
                  />
                  <InputField
                    label="Target Open Area (%)"
                    type="number"
                    value={form.requirements.objectives.targetOpenAreaPercent ?? 32}
                    onChange={(value) =>
                      updateStructuralRequirements((requirements) => ({
                        ...requirements,
                        objectives: {
                          ...requirements.objectives,
                          targetOpenAreaPercent: Number(value)
                        }
                      }))
                    }
                  />
                  <InputField
                    label="Target Mass (kg)"
                    type="number"
                    value={form.requirements.objectives.targetMassKg ?? 0}
                    onChange={(value) =>
                      updateStructuralRequirements((requirements) => ({
                        ...requirements,
                        objectives: {
                          ...requirements.objectives,
                          targetMassKg: Number(value)
                        }
                      }))
                    }
                  />
                </SidebarSection>
              </>
            )}

            <SidebarSection title="Resolver Profile">
              <MetricRow label="Profile" value={selectedMeta.label} />
              <MetricRow label="Mode" value="Generate → Test → Score → Select" />
              <MetricRow
                label="Printable State"
                value={
                  displayGeneration?.status === "completed"
                    ? "Best Candidate Ready"
                    : "Awaiting Generation"
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
                  onClick={() => handleViewerModeClick(option.value)}
                >
                  {option.label}
                </button>
              ))}
            </div>

            <GraphPaperRoom
              title={displayGeneration?.componentName ?? componentName}
              geometry={buildViewerGeometry(displayGeneration)}
              mode={viewerMode}
              status={
                viewerMode === "simulation"
                  ? latestSimulation?.status ?? displayGeneration?.status ?? "idle"
                  : displayGeneration?.status ?? "idle"
              }
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
            subtitle="Candidate search, validation, simulation, and export status."
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
                  onClick={() => {
                    setRightPanelTab(tab.value);
                    if (tab.value === "simulation") {
                      setViewerMode("simulation");
                    }
                  }}
                >
                  {tab.label}
                </button>
              ))}
            </div>

            <div className="right-panel-body">
              {rightPanelTab === "summary" ? (
                <>
                  <SidebarSection title="Selected Run">
                    <MetricRow label="Revision" value={result?.revision ?? "—"} />
                    <MetricRow label="Status" value={displayGeneration?.status ?? "—"} />
                    <MetricRow label="Candidates" value={formatCandidateAcceptance(result)} />
                    <MetricRow label="Material" value={getResultMaterial(result)} />
                    <MetricRow label="Estimated Mass" value={formatEstimatedMass(result)} />
                    <MetricRow label="Token Cost" value={displayGeneration ? String(displayGeneration.tokenCost) : "—"} />
                  </SidebarSection>

                  <SidebarSection title="Derived Geometry">
                    <MetricRow label="X Width" value={formatDerivedDimension(result, "widthMm")} />
                    <MetricRow label="Y Height" value={formatDerivedDimension(result, "heightMm")} />
                    <MetricRow label="Z Depth" value={formatDerivedDimension(result, "depthMm")} />
                    <MetricRow label="Length" value={formatDerivedDimension(result, "lengthMm")} />
                    <MetricRow label="Wall" value={formatDerivedDimension(result, "wallThicknessMm")} />
                  </SidebarSection>

                  <SidebarSection title="Skeletonization">
                    <MetricRow
                      label="Status"
                      value={result?.selectedCandidate?.skeletonized ? "Active" : "Solid / Sealed"}
                    />
                    <MetricRow
                      label="Open Area"
                      value={formatPercent(result?.selectedCandidate?.openAreaPercent)}
                    />
                    <MetricRow
                      label="Load Path"
                      value={formatScore(result?.selectedCandidate?.loadPathContinuityScore)}
                    />
                    <MetricRow
                      label="Lattice Cells"
                      value={formatNumber(result?.selectedCandidate?.latticeCellCount)}
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
                        Requirements generate a design population. The engine filters invalid
                        candidates, scores survivors, selects the best option, and prepares it for
                        simulation/export.
                      </div>
                    </div>
                  </SidebarSection>
                </>
              ) : null}

              {rightPanelTab === "simulation" ? (
                <>
                  <SidebarSection title="Simulation View">
                    <MetricRow label="Viewer Mode" value="Simulation" />
                    <MetricRow label="Meshing Tool" value="Gmsh-ready workflow" />
                    <MetricRow label="Structural Solver" value="CalculiX-ready workflow" />
                    <MetricRow label="Latest Run" value={latestSimulation?.status ?? "Not Run"} />
                    <div className="message">
                      <div className="message-title">Simulation Display Behavior</div>
                      <div className="message-body">
                        Run Simulation switches the viewer into simulation mode and displays the
                        backend simulation workflow state, including mesh preparation, structural
                        solving, and result readiness.
                      </div>
                    </div>
                  </SidebarSection>

                  <SimulationPanel
                    ref={simulationPanelRef}
                    apiBase={API_BASE}
                    input={form}
                    onSimulationChange={(simulation) => {
                      setLatestSimulation(simulation);
                      setViewerMode("simulation");
                    }}
                  />
                </>
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
                        Submit a requirements-first generation run to derive geometry and validation
                        output.
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
                      style={PRIMARY_BUTTON_STYLE}
                      onClick={handleCreateIteration}
                      disabled={!displayGeneration || submittingIteration}
                    >
                      {submittingIteration ? "Creating Iteration..." : "Create Iteration"}
                    </BlackButton>
                  </SidebarSection>
                </>
              ) : null}

              {rightPanelTab === "candidates" ? (
                <>
                  <CandidateSearchPanel result={result} />

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
                </>
              ) : null}
            </div>
          </WorkspacePanel>
        </main>

        {showGenerationProgress ? (
          <GenerationProgressOverlay
            percent={generationProgress.percent}
            title={generationProgress.title}
            detail={generationProgress.detail}
            elapsedMs={generationElapsedMs}
            status={displayGeneration?.status ?? (submittingGeneration || submittingIteration ? "submitted" : "idle")}
            onDismiss={() => setGenerationNoticeDismissed(true)}
          />
        ) : null}
      </div>
    </AppShell>
  );
}

function CandidateSearchPanel({ result }: { result: GenerationResult | null }) {
  const selected = result?.selectedCandidate;
  const rejected = result?.rejectedCandidates ?? [];
  const baseline = result?.baselineComparison;

  const generated = result?.candidatesEvaluated ?? result?.geometry?.candidates?.evaluated ?? 0;
  const rejectedCount = result?.candidatesRejected ?? result?.geometry?.candidates?.rejected ?? 0;
  const simulated = result?.candidatesAccepted ?? result?.geometry?.candidates?.accepted ?? 0;

  const candidates = [
    ...(selected ? [{ ...selected, tableStatus: "selected" as const }] : []),
    ...rejected.slice(0, 8).map((candidate) => ({
      ...candidate,
      tableStatus: "rejected" as const
    }))
  ];

  return (
    <>
      <SidebarSection title="Candidate Search">
        <MetricRow label="Generated" value={generated ? String(generated) : "—"} />
        <MetricRow label="Rejected Before Simulation" value={rejectedCount ? String(rejectedCount) : "—"} />
        <MetricRow label="Simulation-Ready" value={simulated ? String(simulated) : "—"} />
        <MetricRow label="Selected" value={selected?.id ?? "—"} />

        <div style={candidateBars}>
          <CandidateBar label="Generated" value={generated} max={Math.max(generated, 1)} />
          <CandidateBar label="Rejected" value={rejectedCount} max={Math.max(generated, 1)} />
          <CandidateBar label="Simulated" value={simulated} max={Math.max(generated, 1)} />
          <CandidateBar label="Selected" value={selected ? 1 : 0} max={Math.max(generated, 1)} />
        </div>
      </SidebarSection>

      <SidebarSection title="Best Candidate">
        <MetricRow label="Score" value={formatScore(selected?.totalScore)} />
        <MetricRow label="Mass" value={formatKg(selected?.estimatedMassKg)} />
        <MetricRow label="Stress" value={formatMpa(selected?.estimatedStressMpa)} />
        <MetricRow label="Displacement" value={formatMm(selected?.estimatedDisplacementMm)} />
        <MetricRow label="Safety Factor" value={formatNumber(selected?.safetyFactorEstimate)} />
        <MetricRow label="Open Area" value={formatPercent(selected?.openAreaPercent)} />
        <MetricRow label="Load Path" value={formatScore(selected?.loadPathContinuityScore)} />
      </SidebarSection>

      <SidebarSection title="Baseline Comparison">
        <MetricRow
          label="Baseline Simulations"
          value={baseline ? String(baseline.baselineCandidatesSimulated) : "—"}
        />
        <MetricRow
          label="Filtered Simulations"
          value={baseline ? String(baseline.filteredCandidatesSimulated) : "—"}
        />
        <MetricRow
          label="Avoided Runs"
          value={baseline ? String(baseline.avoidedSimulationRuns) : "—"}
        />
        <MetricRow
          label="Reduction"
          value={
            baseline
              ? `${baseline.reductionInSimulationLoadPercent.toFixed(1)}%`
              : "—"
          }
        />
      </SidebarSection>

      <SidebarSection title="Candidate Comparison">
        {candidates.length ? (
          <div style={candidateTableWrap}>
            <div style={candidateTableHeader}>
              <span>Candidate</span>
              <span>Mass</span>
              <span>SF</span>
              <span>Score</span>
              <span>Status</span>
            </div>

            {candidates.map((candidate) => (
              <div key={candidate.id} style={candidateTableRow}>
                <span title={candidate.id}>{shortCandidateId(candidate.id)}</span>
                <span>{formatKg(candidate.estimatedMassKg)}</span>
                <span>{formatNumber(candidate.safetyFactorEstimate)}</span>
                <span>{formatNumber(candidate.totalScore)}</span>
                <span>{candidate.tableStatus === "selected" ? "Selected" : "Rejected"}</span>
              </div>
            ))}
          </div>
        ) : (
          <div className="message">
            <div className="message-title">Awaiting Candidate Search</div>
            <div className="message-body">
              Generate a design to see generated, rejected, simulated, and selected candidates.
            </div>
          </div>
        )}
      </SidebarSection>
    </>
  );
}

function CandidateBar({ label, value, max }: { label: string; value: number; max: number }) {
  const width = Math.max(2, Math.min(100, (value / max) * 100));

  return (
    <div style={candidateBarRow}>
      <div style={candidateBarMeta}>
        <span>{label}</span>
        <strong>{value}</strong>
      </div>
      <div style={candidateBarTrack}>
        <div style={{ ...candidateBarFill, width: `${width}%` }} />
      </div>
    </div>
  );
}

function GenerationProgressOverlay(props: {
  percent: number;
  title: string;
  detail: string;
  elapsedMs: number;
  status: string;
  onDismiss: () => void;
}) {
  return (
    <div className="generation-progress-backdrop" role="status" aria-live="polite">
      <div className="generation-progress-card">
        <div className="generation-progress-topline">
          <span className="generation-progress-eyebrow">Solver pipeline active</span>
          <button
            type="button"
            className="generation-progress-dismiss"
            onClick={props.onDismiss}
            aria-label="Hide generation progress overlay"
          >
            Hide
          </button>
        </div>

        <h2>{props.title}</h2>
        <p>{props.detail}</p>

        <div className="generation-progress-meter" aria-label={`Generation progress ${props.percent}%`}>
          <div
            className="generation-progress-meter-fill"
            style={{ width: `${props.percent}%` }}
          />
        </div>

        <div className="generation-progress-meta">
          <span>{props.percent}%</span>
          <span>Status: {props.status.toUpperCase()}</span>
          <span>Elapsed: {formatElapsedMs(props.elapsedMs)}</span>
        </div>

        <div className="generation-progress-steps">
          <ProgressStep label="Submit requirements" active={props.percent >= 8} complete={props.percent > 18} />
          <ProgressStep label="Run topology solver" active={props.percent >= 18} complete={props.percent > 62} />
          <ProgressStep label="Extract render mesh" active={props.percent >= 62} complete={props.percent > 82} />
          <ProgressStep label="Validate response" active={props.percent >= 82} complete={props.percent >= 96} />
        </div>

        <p className="generation-progress-note">
          Fake preview geometry is disabled. If the solver fails, the viewer will keep showing
          NO GEOMETRY PRODUCED instead of inventing a bracket.
        </p>
      </div>
    </div>
  );
}

function ProgressStep(props: { label: string; active: boolean; complete: boolean }) {
  return (
    <div
      className={`generation-progress-step ${props.active ? "generation-progress-step-active" : ""} ${
        props.complete ? "generation-progress-step-complete" : ""
      }`}
    >
      <span className="generation-progress-step-dot" />
      <span>{props.label}</span>
    </div>
  );
}

function getGenerationProgress(args: {
  status?: string;
  submitting: boolean;
  elapsedMs: number;
  result: GenerationResult | null;
}) {
  if (args.status === "completed" && args.result?.selectedCandidate?.renderMesh) {
    return {
      percent: 100,
      title: "Solver mesh produced",
      detail: "A real renderMesh was returned and selected."
    };
  }

  if (args.status === "failed") {
    return {
      percent: 100,
      title: "Generation failed",
      detail: "The solver returned a failure. Check the Render logs and API response details."
    };
  }

  if (args.status === "queued") {
    return {
      percent: 18,
      title: "Generation queued",
      detail: "The API accepted the request and is waiting for the solver worker."
    };
  }

  if (args.status === "running") {
    const runningPercent = Math.min(92, 28 + Math.floor(args.elapsedMs / 1200));

    return {
      percent: runningPercent,
      title: "Running solver pipeline",
      detail:
        runningPercent < 62
          ? "FEniCS/SIMP topology optimization is running. This can take a while on Render."
          : runningPercent < 82
            ? "The solver should be returning density data and the mesh extractor is preparing geometry."
            : "Finalizing the renderMesh and waiting for the API to mark the generation complete."
    };
  }

  if (args.submitting) {
    return {
      percent: 8,
      title: "Submitting generation request",
      detail: "Sending requirements to the generation API."
    };
  }

  return {
    percent: 0,
    title: "Generation idle",
    detail: "No active generation request."
  };
}

function formatElapsedMs(ms: number) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  if (minutes <= 0) return `${seconds}s`;
  return `${minutes}m ${seconds.toString().padStart(2, "0")}s`;
}

function buildViewerGeometry(generation: GenerationSummary | null) {
  if (!generation?.result) return undefined;

  const result = generation.result;
  const selected = result.selectedCandidate;

  const renderMesh =
  result.derived?.renderMesh ??
  result.geometry?.renderMesh ??
  result.geometry?.derived?.renderMesh ??
  selected?.renderMesh;

  return {
    family: result.geometry?.silhouette ?? generation.input.componentFamily,
    silhouette: result.geometry?.silhouette ?? generation.input.componentFamily,
    material: result.derived?.material ?? result.geometry?.material ?? selected?.material,

    lengthMm: result.derived?.lengthMm ?? result.geometry?.lengthMm ?? selected?.lengthMm,
    widthMm: result.derived?.widthMm ?? result.geometry?.widthMm ?? selected?.widthMm,
    heightMm: result.derived?.heightMm ?? result.geometry?.heightMm ?? selected?.heightMm,
    depthMm: result.derived?.depthMm ?? result.geometry?.depthMm ?? selected?.depthMm,

    wallThicknessMm:
      result.derived?.wallThicknessMm ??
      result.geometry?.wallThicknessMm ??
      selected?.wallThicknessMm,

    skeletonized:
      result.derived?.skeletonized ??
      result.geometry?.skeletonized ??
      selected?.skeletonized,

    skeletonizationPolicy:
      result.derived?.skeletonizationPolicy ??
      result.geometry?.skeletonizationPolicy ??
      selected?.skeletonizationPolicy,

    openAreaPercent:
      result.derived?.openAreaPercent ??
      result.geometry?.openAreaPercent ??
      selected?.openAreaPercent,

    latticeCellCount:
      result.derived?.latticeCellCount ??
      result.geometry?.latticeCellCount ??
      selected?.latticeCellCount,

    loadPathContinuityScore:
      result.derived?.loadPathContinuityScore ??
      result.geometry?.loadPathContinuityScore ??
      selected?.loadPathContinuityScore,

    renderMesh,

    geometry: {
      ...result.geometry,
      renderMesh
    },

    selectedCandidate: {
      ...selected,
      renderMesh
    },

    derived: {
      ...result.derived,
      renderMesh
    },

    derivedParameters: result.derived?.derivedParameters ?? selected?.derivedParameters,

   notes: [
  renderMesh
    ? `ENGINE MESH ACTIVE: ${renderMesh.vertices.length} vertices, ${renderMesh.faces.length} faces.`
    : "NO GEOMETRY PRODUCED: solver/generation engine did not return a renderMesh.",
  ...(result.geometry?.notes ?? [])
]
  };
}

function getInputComponentName(input: GenerationInput) {
  return input.requirements.componentName;
}

function formatCandidateAcceptance(result: GenerationSummary["result"]) {
  if (!result) return "—";

  const accepted =
    result.candidatesAccepted ??
    result.geometry?.candidates?.accepted ??
    (result.selectedCandidate ? 1 : 0);

  const evaluated =
    result.candidatesEvaluated ??
    result.geometry?.candidates?.evaluated ??
    Math.max(accepted, result.selectedCandidate ? 1 : 0);

  return `${accepted}/${evaluated} accepted`;
}

function getResultMaterial(result: GenerationSummary["result"]) {
  return (
    result?.derived?.material ??
    result?.geometry?.material ??
    result?.selectedCandidate?.material ??
    "—"
  );
}

function formatEstimatedMass(result: GenerationSummary["result"]) {
  const value =
    result?.estimatedMassKg ??
    result?.derived?.estimatedMassKg ??
    result?.selectedCandidate?.estimatedMassKg;

  return formatKg(value);
}

type DerivedDimensionKey = "lengthMm" | "widthMm" | "heightMm" | "depthMm" | "wallThicknessMm";

function formatDerivedDimension(result: GenerationSummary["result"], key: DerivedDimensionKey) {
  const value =
    result?.derived?.[key] ??
    result?.geometry?.derived?.[key] ??
    result?.geometry?.[key] ??
    result?.selectedCandidate?.[key];

  return formatMm(value);
}

function formatMetricNumber(value: number) {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function formatNumber(value?: number) {
  if (typeof value !== "number" || Number.isNaN(value)) return "—";
  return formatMetricNumber(value);
}

function formatMm(value?: number) {
  if (typeof value !== "number" || Number.isNaN(value)) return "—";
  return `${formatMetricNumber(value)} mm`;
}

function formatKg(value?: number) {
  if (typeof value !== "number" || Number.isNaN(value)) return "—";
  return `${value.toFixed(3)} kg`;
}

function formatMpa(value?: number) {
  if (typeof value !== "number" || Number.isNaN(value)) return "—";
  return `${value.toFixed(1)} MPa`;
}

function formatPercent(value?: number) {
  if (typeof value !== "number" || Number.isNaN(value)) return "—";
  return `${value.toFixed(1)}%`;
}

function formatScore(value?: number) {
  if (typeof value !== "number" || Number.isNaN(value)) return "—";
  return `${value.toFixed(1)}/100`;
}

function shortCandidateId(value: string) {
  return value.replace("filtered_", "").replace("baseline_", "").replace("structural-bracket_", "");
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
    { name: "geometry/part-preview.stl", content: stl },
    { name: "reports/validation-report.txt", content: report },
    { name: "reports/generation.json", content: JSON.stringify(generation, null, 2) },
    { name: "reports/project.json", content: JSON.stringify(project, null, 2) },
    {
      name: "simulation/simulation.json",
      content: JSON.stringify(simulation ?? { status: "not-run" }, null, 2)
    },
    { name: "export/export-record.json", content: JSON.stringify(queuedExport, null, 2) },
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
  const derived = generation.result?.derived;

  return [
    "HELVARIX ADVANCED FABRICATOR",
    "REQUIREMENTS-FIRST VALIDATION AND EXPORT REPORT",
    "",
    `Project: ${project?.name ?? "Unknown"}`,
    `Workspace: ${project?.workspaceLabel ?? "Unknown"}`,
    `Generation ID: ${generation.id}`,
    `Component: ${generation.componentName}`,
    `Family: ${generation.input.componentFamily}`,
    `Status: ${generation.status}`,
    `Revision: ${generation.result?.revision ?? "n/a"}`,
    `Estimated Mass: ${generation.result?.estimatedMassKg ?? "n/a"} kg`,
    "",
    "CANDIDATE SEARCH",
    JSON.stringify(
      {
        candidatesEvaluated: generation.result?.candidatesEvaluated,
        candidatesAccepted: generation.result?.candidatesAccepted,
        candidatesRejected: generation.result?.candidatesRejected,
        selectedCandidate: generation.result?.selectedCandidate,
        baselineComparison: generation.result?.baselineComparison
      },
      null,
      2
    ),
    "",
    "DERIVED GEOMETRY",
    derived ? JSON.stringify(derived, null, 2) : "No derived geometry available.",
    "",
    "INPUT REQUIREMENTS",
    JSON.stringify(generation.input, null, 2),
    "",
    "VALIDATION",
    validations.length
      ? validations
          .map((item) => `[${item.severity.toUpperCase()}] ${item.title}: ${item.text}`)
          .join("\n")
      : "No validation messages available.",
    "",
    "SIMULATION",
    simulation ? JSON.stringify(simulation, null, 2) : "No simulation record available."
  ].join("\n");
}

function buildPreviewStl(generation: GenerationSummary) {
  const derived = generation.result?.derived;
  const name = safeFileName(generation.componentName || "haf-part");

  const width = Math.max(1, derived?.widthMm ?? 100);
  const height = Math.max(1, derived?.heightMm ?? 100);
  const depth = Math.max(1, derived?.depthMm ?? derived?.lengthMm ?? 100);

  const x = width / 2;
  const y = height / 2;
  const z = depth / 2;

  return [
    `solid ${name}`,
    facet([[-x, -y, -z], [x, -y, -z], [x, y, -z]]),
    facet([[-x, -y, -z], [x, y, -z], [-x, y, -z]]),
    facet([[-x, -y, z], [x, y, z], [x, -y, z]]),
    facet([[-x, -y, z], [-x, y, z], [x, y, z]]),
    facet([[-x, -y, -z], [-x, -y, z], [x, -y, z]]),
    facet([[-x, -y, -z], [x, -y, z], [x, -y, -z]]),
    facet([[x, -y, -z], [x, -y, z], [x, y, z]]),
    facet([[x, -y, -z], [x, y, z], [x, y, -z]]),
    facet([[x, y, -z], [x, y, z], [-x, y, z]]),
    facet([[x, y, -z], [-x, y, z], [-x, y, -z]]),
    facet([[-x, y, -z], [-x, y, z], [-x, -y, z]]),
    facet([[-x, y, -z], [-x, -y, z], [-x, -y, -z]]),
    `endsolid ${name}`
  ].join("\n");
}

function facet(vertices: number[][]) {
  return [
    "  facet normal 0 0 1",
    "    outer loop",
    `      vertex ${vertices[0][0]} ${vertices[0][1]} ${vertices[0][2]}`,
    `      vertex ${vertices[1][0]} ${vertices[1][1]} ${vertices[1][2]}`,
    `      vertex ${vertices[2][0]} ${vertices[2][1]} ${vertices[2][2]}`,
    "    endloop",
    "  endfacet"
  ].join("\n");
}

function buildPlaceholderStep(generation: GenerationSummary) {
  return [
    "ISO-10303-21;",
    "HEADER;",
    `FILE_DESCRIPTION(('Helvarix derived STEP placeholder for ${generation.componentName}'),'2;1');`,
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

const candidateBars: React.CSSProperties = {
  display: "grid",
  gap: 10,
  marginTop: 12
};

const candidateBarRow: React.CSSProperties = {
  display: "grid",
  gap: 5
};

const candidateBarMeta: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  fontSize: 11,
  textTransform: "uppercase",
  letterSpacing: "0.08em",
  color: "#667085"
};

const candidateBarTrack: React.CSSProperties = {
  height: 8,
  border: "1px solid rgba(0,0,0,0.16)",
  background: "rgba(0,0,0,0.04)",
  overflow: "hidden"
};

const candidateBarFill: React.CSSProperties = {
  height: "100%",
  background: "#111111"
};

const candidateTableWrap: React.CSSProperties = {
  display: "grid",
  gap: 6,
  overflowX: "auto"
};

const candidateTableHeader: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "1.4fr 0.8fr 0.7fr 0.8fr 0.9fr",
  gap: 8,
  fontSize: 10,
  textTransform: "uppercase",
  letterSpacing: "0.08em",
  color: "#667085",
  borderBottom: "1px solid rgba(0,0,0,0.14)",
  paddingBottom: 6
};

const candidateTableRow: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "1.4fr 0.8fr 0.7fr 0.8fr 0.9fr",
  gap: 8,
  fontSize: 11,
  color: "#111111",
  padding: "6px 0",
  borderBottom: "1px solid rgba(0,0,0,0.08)"
};

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
