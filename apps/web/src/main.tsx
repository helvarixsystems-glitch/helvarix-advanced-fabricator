import React from "react";
import ReactDOM from "react-dom/client";
import {
  AppShell,
  BlackButton,
  InputField,
  MetricRow,
  SelectField,
  SidebarSection,
  WorkspacePanel
} from "@haf/ui";
import { GraphPaperRoom } from "@haf/viewer";
import {
  appName,
  formatTimestamp,
  type CreditBalance,
  type GenerationInput,
  type GenerationSummary
} from "@haf/shared";
import { componentRegistry } from "@haf/component-registry";
import { estimateGenerationTokens } from "@haf/pricing";
import "./styles.css";

const API_BASE =
  (globalThis as { __HAF_API__?: string }).__HAF_API__ ?? "https://haf-api.YOUR-SUBDOMAIN.workers.dev";

function App() {
  const [credits, setCredits] = React.useState<CreditBalance>({ available: 184, reserved: 0 });
  const [generation, setGeneration] = React.useState<GenerationSummary | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [selectedFamily, setSelectedFamily] = React.useState("nosecone");
  const [form, setForm] = React.useState<GenerationInput>({
    componentFamily: "nosecone",
    componentName: "HAF-NC-01",
    lengthMm: 1200,
    baseDiameterMm: 320,
    wallThicknessMm: 3.4,
    material: "PEEK-CF",
    targetMassKg: 8.6
  });

  React.useEffect(() => {
    void loadInitial();
  }, []);

  React.useEffect(() => {
    const registryItem = componentRegistry.find((item) => item.key === selectedFamily);
    if (!registryItem) return;
    setForm(registryItem.defaultInput);
  }, [selectedFamily]);

  React.useEffect(() => {
    if (!generation || generation.status === "completed" || generation.status === "failed") return;

    const timer = window.setInterval(() => {
      void loadGeneration(generation.id);
      void loadCredits();
    }, 1200);

    return () => window.clearInterval(timer);
  }, [generation]);

  async function loadInitial() {
    await Promise.all([loadCredits(), loadLatestGeneration()]);
  }

  async function loadCredits() {
    try {
      const response = await fetch(`${API_BASE}/credits/balance`);
      const data = await response.json();
      setCredits(data.credits);
    } catch {
      // keep starter defaults
    }
  }

  async function loadLatestGeneration() {
    try {
      const response = await fetch(`${API_BASE}/generations`);
      const data = await response.json();
      if (data.generations?.length) {
        setGeneration(data.generations[0]);
      }
    } catch {
      // keep starter state
    }
  }

  async function loadGeneration(id: string) {
    try {
      const response = await fetch(`${API_BASE}/generations/${id}`);
      const data = await response.json();
      if (data.generation) {
        setGeneration(data.generation);
      }
    } catch {
      // ignore for starter
    }
  }

  async function handleGenerate() {
    setLoading(true);

    try {
      const response = await fetch(`${API_BASE}/generations`, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          projectId: "proj_0001",
          input: form
        })
      });

      const data = await response.json();

      if (!response.ok) {
        alert(data.error ?? "Generation failed.");
        return;
      }

      setGeneration(data.generation);
      await loadCredits();
    } catch {
      alert("Could not reach the API.");
    } finally {
      setLoading(false);
    }
  }

  const estimatedCost = estimateGenerationTokens(form.componentFamily);
  const validationMessages = generation?.result?.validations ?? [];
  const selectedMeta = componentRegistry.find((item) => item.key === selectedFamily)!;

  return (
    <AppShell>
      <div className="workspace-page">
        <header className="topbar">
          <div className="topbar-title-group">
            <div className="eyebrow">Helvarix Systems</div>
            <h1>{appName}</h1>
          </div>

          <div className="topbar-meta">
            <span>Workspace: Fabrication Bay 01</span>
            <span>Project: Lunar Nosecone Study</span>
            <span>Credits: {credits.available}</span>
          </div>
        </header>

        <main className="workspace-grid">
          <WorkspacePanel
            title="Parameters"
            subtitle="Define printable geometry constraints."
            footer={
              <BlackButton>
                <span onClick={handleGenerate}>{loading ? "Submitting..." : "Generate Concept"}</span>
              </BlackButton>
            }
          >
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
                onChange={(value) => setForm((prev) => ({ ...prev, componentName: value }))}
              />
            </SidebarSection>

            <SidebarSection title="Dimensions">
              <InputField
                label="Length (mm)"
                type="number"
                value={form.lengthMm}
                onChange={(value) => setForm((prev) => ({ ...prev, lengthMm: Number(value) }))}
              />
              <InputField
                label="Base Diameter (mm)"
                type="number"
                value={form.baseDiameterMm}
                onChange={(value) => setForm((prev) => ({ ...prev, baseDiameterMm: Number(value) }))}
              />
              <InputField
                label="Wall Thickness (mm)"
                type="number"
                value={form.wallThicknessMm}
                onChange={(value) => setForm((prev) => ({ ...prev, wallThicknessMm: Number(value) }))}
              />
            </SidebarSection>

            <SidebarSection title="Material">
              <SelectField
                label="Build Material"
                defaultValue={form.material}
                options={[
                  { label: "PEEK-CF", value: "PEEK-CF" },
                  { label: "AlSi10Mg", value: "AlSi10Mg" },
                  { label: "Ti-6Al-4V", value: "Ti-6Al-4V" },
                  { label: "Inconel 718", value: "Inconel 718" }
                ]}
                onChange={(value) => setForm((prev) => ({ ...prev, material: value }))}
              />
              <InputField
                label="Target Mass (kg)"
                type="number"
                value={form.targetMassKg}
                onChange={(value) => setForm((prev) => ({ ...prev, targetMassKg: Number(value) }))}
              />
            </SidebarSection>

            <SidebarSection title="Profile">
              <MetricRow label="Profile" value={selectedMeta.label} />
              <MetricRow label="Estimated Burn" value={`${estimatedCost} credits`} />
              <MetricRow label="Mode" value="Concept Geometry" />
            </SidebarSection>
          </WorkspacePanel>

          <section className="center-column">
            <div className="center-toolbar">
              <span>Fabricator Workspace / Geometry Preview</span>
              <span>Run Mode: {generation?.status ?? "idle"}</span>
            </div>

            <GraphPaperRoom
              title={form.componentName}
              geometry={generation?.result?.geometry}
            />

            <div className="statusbar">
              <span>Status: {(generation?.status ?? "idle").toUpperCase()}</span>
              <span>Generation: {generation?.id ?? "—"}</span>
              <span>Updated: {generation ? formatTimestamp(generation.updatedAt) : "—"}</span>
            </div>
          </section>

          <WorkspacePanel title="Results" subtitle="Validation and export status.">
            <SidebarSection title="Output">
              <MetricRow label="Revision" value={generation?.result?.revision ?? "—"} />
              <MetricRow label="Export" value={generation?.result?.exportState ?? "—"} />
              <MetricRow label="Token Cost" value={generation ? String(generation.tokenCost) : "—"} />
              <MetricRow
                label="Estimated Mass"
                value={
                  generation?.result?.estimatedMassKg !== undefined
                    ? `${generation.result.estimatedMassKg} kg`
                    : "—"
                }
              />
            </SidebarSection>

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
                    Submit a concept run to generate geometry and validation output.
                  </div>
                </div>
              )}
            </SidebarSection>

            <SidebarSection title="Actions">
              <div className="actions">
                <BlackButton subdued>Queue Export</BlackButton>
                <BlackButton subdued>Create Iteration</BlackButton>
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
