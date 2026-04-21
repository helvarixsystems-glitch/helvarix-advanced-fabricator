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
import { appName, formatTimestamp, type CreditBalance, type GenerationSummary } from "@haf/shared";
import { componentRegistry } from "@haf/component-registry";
import { estimateGenerationTokens } from "@haf/pricing";
import { getMockValidationMessages } from "@haf/validation";
import "./styles.css";

const credits: CreditBalance = {
  available: 184,
  reserved: 12
};

const latestGeneration: GenerationSummary = {
  id: "gen_0001",
  projectId: "proj_0001",
  componentName: "HAF-NC-01",
  status: "completed",
  tokenCost: 12,
  updatedAt: new Date().toISOString()
};

function App() {
  const selectedFamily = "nosecone";
  const selectedMeta = componentRegistry.find((item) => item.key === selectedFamily)!;
  const estimatedCost = estimateGenerationTokens(selectedFamily);
  const validationMessages = getMockValidationMessages();

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
            footer={<BlackButton>Generate Concept</BlackButton>}
          >
            <SidebarSection title="Component">
              <SelectField
                label="Component Family"
                defaultValue={selectedFamily}
                options={componentRegistry.map((item) => ({
                  label: item.label,
                  value: item.key
                }))}
              />
              <InputField label="Component Name" defaultValue="HAF-NC-01" />
            </SidebarSection>

            <SidebarSection title="Dimensions">
              <InputField label="Length (mm)" type="number" defaultValue="1200" />
              <InputField label="Base Diameter (mm)" type="number" defaultValue="320" />
              <InputField label="Wall Thickness (mm)" type="number" defaultValue="3.4" />
            </SidebarSection>

            <SidebarSection title="Material">
              <SelectField
                label="Build Material"
                defaultValue="AlSi10Mg"
                options={[
                  { label: "AlSi10Mg", value: "AlSi10Mg" },
                  { label: "Ti-6Al-4V", value: "Ti-6Al-4V" },
                  { label: "PEEK-CF", value: "PEEK-CF" }
                ]}
              />
              <InputField label="Target Mass (kg)" type="number" defaultValue="8.6" />
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
              <span>Run Mode: Concept</span>
            </div>

            <GraphPaperRoom title="HAF-NC-01" />

            <div className="statusbar">
              <span>Status: {latestGeneration.status.toUpperCase()}</span>
              <span>Generation: {latestGeneration.id}</span>
              <span>Updated: {formatTimestamp(latestGeneration.updatedAt)}</span>
            </div>
          </section>

          <WorkspacePanel title="Results" subtitle="Validation and export status.">
            <SidebarSection title="Output">
              <MetricRow label="Revision" value="v0.1" />
              <MetricRow label="Export" value="Preview Ready" />
              <MetricRow label="Token Cost" value={String(latestGeneration.tokenCost)} />
            </SidebarSection>

            <SidebarSection title="Validation">
              {validationMessages.map((message, index) => (
                <div key={index} className={`message message-${message.severity}`}>
                  <div className="message-title">{message.title}</div>
                  <div className="message-body">{message.text}</div>
                </div>
              ))}
            </SidebarSection>

            <SidebarSection title="Actions">
              <div className="actions">
                <BlackButton>Queue Export</BlackButton>
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
