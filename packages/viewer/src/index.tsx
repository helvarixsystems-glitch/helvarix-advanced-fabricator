import React, { type CSSProperties } from "react";
import { theme, type ComponentFamily, type GeometryPreview } from "@haf/shared";

export type ViewerMode = "concept" | "mesh" | "simulation";

export function GraphPaperRoom({
  title = "GEOMETRY PREVIEW",
  geometry,
  mode = "concept",
  status = "idle"
}: {
  title?: string;
  geometry?: GeometryPreview;
  mode?: ViewerMode;
  status?: string;
}) {
  const silhouette = geometry?.silhouette ?? "nosecone";
  const family = silhouette as ComponentFamily;
  const simulationLabel = getSimulationLabel(family);

  return (
    <div style={styles.viewport}>
      <div style={styles.room}>
        <div style={styles.wall} />
        <div style={styles.floor} />
        <div style={styles.ambientGlow} />

        {mode === "simulation" ? (
          <SimulationBackdrop family={family} status={status} />
        ) : null}

        {mode === "mesh" ? <MeshBackdrop /> : null}

        <div style={styles.shadow} />

        <div style={getPartWrapperStyle(mode)}>
          <PartShape family={family} mode={mode} />
        </div>

        <div style={styles.overlayTop}>{title}</div>

        <div style={styles.modeBadge}>
          {mode === "concept" ? "PART REVIEW" : mode === "mesh" ? "MESH VIEW" : simulationLabel}
        </div>

        <div style={styles.overlayBottom}>
          {geometry
            ? `${geometry.material} · ${geometry.lengthMm}MM · ${geometry.wallThicknessMm}MM WALL`
            : "MM · CONCEPT MODE · FABRICATION BAY"}
        </div>

        {mode === "simulation" ? (
          <div style={styles.simulationHud}>
            <HudRow label="MODE" value={simulationLabel} />
            <HudRow label="FLOW STATE" value={status === "running" ? "ACTIVE" : "PREVIEW"} />
            <HudRow label="GEOMETRY" value={family.toUpperCase()} />
          </div>
        ) : null}

        {geometry?.notes?.length ? (
          <div style={styles.notesPanel}>
            {geometry.notes.slice(0, 3).map((note, index) => (
              <div key={index} style={styles.noteLine}>
                {note}
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function HudRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={styles.hudRow}>
      <span style={styles.hudLabel}>{label}</span>
      <span style={styles.hudValue}>{value}</span>
    </div>
  );
}

function PartShape({
  family,
  mode
}: {
  family: ComponentFamily;
  mode: ViewerMode;
}) {
  if (family === "nosecone") return <NoseconeShape mode={mode} />;
  if (family === "shell") return <ShellShape mode={mode} />;
  if (family === "rover-arm") return <RoverArmShape mode={mode} />;
  return <GridFinShape mode={mode} />;
}

function NoseconeShape({ mode }: { mode: ViewerMode }) {
  return (
    <>
      <div style={shapeStyles.tip(mode)} />
      <div style={shapeStyles.body(mode)} />
      <div style={shapeStyles.bandTop(mode)} />
      <div style={shapeStyles.bandMid(mode)} />
      <div style={shapeStyles.nozzleHint(mode)} />
      {mode === "mesh" ? (
        <>
          <div style={shapeStyles.meshLine("50%", 22, 96)} />
          <div style={shapeStyles.meshLine("50%", 56, 98)} />
          <div style={shapeStyles.meshLine("50%", 92, 110)} />
          <div style={shapeStyles.meshLine("50%", 146, 110)} />
          <div style={shapeStyles.meshLine("50%", 196, 110)} />
          <div style={shapeStyles.meshLine("50%", 246, 110)} />
        </>
      ) : null}
    </>
  );
}

function ShellShape({ mode }: { mode: ViewerMode }) {
  return (
    <>
      <div style={shapeStyles.shellOuter(mode)} />
      <div style={shapeStyles.shellInner(mode)} />
      <div style={shapeStyles.shellBraceLeft(mode)} />
      <div style={shapeStyles.shellBraceRight(mode)} />
      {mode === "mesh" ? (
        <>
          <div style={shapeStyles.horizontalMesh(70)} />
          <div style={shapeStyles.horizontalMesh(120)} />
          <div style={shapeStyles.horizontalMesh(170)} />
          <div style={shapeStyles.horizontalMesh(220)} />
          <div style={shapeStyles.verticalMesh(85)} />
          <div style={shapeStyles.verticalMesh(135)} />
        </>
      ) : null}
    </>
  );
}

function RoverArmShape({ mode }: { mode: ViewerMode }) {
  return (
    <>
      <div style={shapeStyles.armBase(mode)} />
      <div style={shapeStyles.armLink(mode)} />
      <div style={shapeStyles.armJointA(mode)} />
      <div style={shapeStyles.armJointB(mode)} />
      <div style={shapeStyles.armHead(mode)} />
      {mode === "mesh" ? (
        <>
          <div style={shapeStyles.armMeshA} />
          <div style={shapeStyles.armMeshB} />
          <div style={shapeStyles.armMeshC} />
        </>
      ) : null}
    </>
  );
}

function GridFinShape({ mode }: { mode: ViewerMode }) {
  return (
    <>
      <div style={shapeStyles.finFrame(mode)} />
      <div style={shapeStyles.finGridA(mode)} />
      <div style={shapeStyles.finGridB(mode)} />
      <div style={shapeStyles.finGridC(mode)} />
      <div style={shapeStyles.finGridD(mode)} />
      {mode === "mesh" ? (
        <>
          <div style={shapeStyles.finDiagA} />
          <div style={shapeStyles.finDiagB} />
          <div style={shapeStyles.finDiagC} />
          <div style={shapeStyles.finDiagD} />
        </>
      ) : null}
    </>
  );
}

function MeshBackdrop() {
  return (
    <>
      <div style={styles.meshSweepA} />
      <div style={styles.meshSweepB} />
      <div style={styles.meshGridOverlay} />
    </>
  );
}

function SimulationBackdrop({
  family,
  status
}: {
  family: ComponentFamily;
  status?: string;
}) {
  if (family === "nosecone" || family === "grid-fin") {
    return (
      <>
        <div style={styles.windTunnelGlow} />
        <div style={styles.flowBandA(status)} />
        <div style={styles.flowBandB(status)} />
        <div style={styles.flowBandC(status)} />
        <div style={styles.flowArrowA} />
        <div style={styles.flowArrowB} />
        <div style={styles.flowArrowC} />
      </>
    );
  }

  if (family === "rover-arm") {
    return (
      <>
        <div style={styles.loadField} />
        <div style={styles.forceArmA} />
        <div style={styles.forceArmB} />
        <div style={styles.forceArmC} />
        <div style={styles.forceNodeA} />
        <div style={styles.forceNodeB} />
      </>
    );
  }

  return (
    <>
      <div style={styles.printBayGlow} />
      <div style={styles.printRailLeft} />
      <div style={styles.printRailRight} />
      <div style={styles.printScanA(status)} />
      <div style={styles.printScanB(status)} />
    </>
  );
}

function getSimulationLabel(family: ComponentFamily) {
  if (family === "nosecone" || family === "grid-fin") return "WIND TUNNEL";
  if (family === "rover-arm") return "LOAD TEST";
  return "PRINT STAND";
}

function getPartWrapperStyle(mode: ViewerMode): CSSProperties {
  return {
    ...styles.part,
    transform:
      mode === "simulation"
        ? "translate(-50%, -50%) scale(1.02)"
        : mode === "mesh"
          ? "translate(-50%, -50%) scale(1.01)"
          : "translate(-50%, -50%)"
  };
}

const gridBackground = `
  linear-gradient(${theme.grid} 1px, transparent 1px),
  linear-gradient(90deg, ${theme.grid} 1px, transparent 1px),
  linear-gradient(${theme.gridFine} 1px, transparent 1px),
  linear-gradient(90deg, ${theme.gridFine} 1px, transparent 1px)
`;

const basePartFill = "linear-gradient(180deg, #dededc 0%, #c8c8c6 48%, #b2b2b0 100%)";
const meshFill = "linear-gradient(180deg, #f0f0ef 0%, #d3d3d1 35%, #ababaa 100%)";
const darkMetal = "linear-gradient(180deg, #8a8a89 0%, #666665 100%)";

const styles: Record<string, CSSProperties | ((status?: string) => CSSProperties)> = {
  viewport: {
    width: "100%",
    minHeight: 430,
    height: "100%",
    border: `1px solid ${theme.border}`,
    overflow: "hidden",
    position: "relative",
    background: "rgba(244,244,242,0.84)"
  },
  room: {
    width: "100%",
    minHeight: 430,
    height: "100%",
    position: "relative",
    background: "linear-gradient(180deg, rgba(247,247,245,1) 0%, rgba(233,233,231,1) 100%)"
  },
  wall: {
    position: "absolute",
    inset: "0 0 40% 0",
    backgroundImage: gridBackground,
    backgroundSize: "80px 80px, 80px 80px, 20px 20px, 20px 20px",
    borderBottom: `1px solid ${theme.border}`
  },
  floor: {
    position: "absolute",
    left: "-12%",
    right: "-12%",
    bottom: "-14%",
    height: "44%",
    transform: "perspective(950px) rotateX(72deg)",
    transformOrigin: "center top",
    backgroundImage: gridBackground,
    backgroundSize: "80px 80px, 80px 80px, 20px 20px, 20px 20px",
    borderTop: `1px solid ${theme.border}`
  },
  ambientGlow: {
    position: "absolute",
    inset: 0,
    background:
      "radial-gradient(circle at 50% 30%, rgba(255,255,255,0.5) 0%, rgba(255,255,255,0) 36%)",
    pointerEvents: "none"
  },
  part: {
    position: "absolute",
    left: "50%",
    top: "49%",
    width: 230,
    height: 360
  },
  shadow: {
    position: "absolute",
    left: "50%",
    top: "68%",
    width: 210,
    height: 52,
    transform: "translateX(-50%)",
    borderRadius: "50%",
    background:
      "radial-gradient(ellipse at center, rgba(0,0,0,0.22) 0%, rgba(0,0,0,0.06) 54%, rgba(0,0,0,0) 78%)",
    filter: "blur(2px)"
  },
  overlayTop: {
    position: "absolute",
    top: 12,
    left: 12,
    padding: "10px 14px",
    background: "rgba(255,255,255,0.88)",
    border: `1px solid ${theme.border}`,
    fontSize: 11,
    letterSpacing: "0.15em",
    textTransform: "uppercase",
    color: theme.muted,
    zIndex: 5
  },
  modeBadge: {
    position: "absolute",
    top: 12,
    right: 12,
    padding: "10px 14px",
    background: "rgba(255,255,255,0.88)",
    border: `1px solid ${theme.border}`,
    fontSize: 11,
    letterSpacing: "0.15em",
    textTransform: "uppercase",
    color: theme.muted,
    zIndex: 5
  },
  overlayBottom: {
    position: "absolute",
    right: 12,
    bottom: 12,
    padding: "10px 14px",
    background: "rgba(255,255,255,0.88)",
    border: `1px solid ${theme.border}`,
    fontSize: 11,
    letterSpacing: "0.15em",
    textTransform: "uppercase",
    color: theme.muted,
    zIndex: 5
  },
  simulationHud: {
    position: "absolute",
    left: 12,
    bottom: 12,
    width: 210,
    padding: 12,
    background: "rgba(255,255,255,0.9)",
    border: `1px solid ${theme.border}`,
    display: "grid",
    gap: 8,
    zIndex: 5
  },
  hudRow: {
    display: "flex",
    justifyContent: "space-between",
    gap: 12,
    fontSize: 11
  },
  hudLabel: {
    color: theme.muted,
    letterSpacing: "0.12em",
    textTransform: "uppercase"
  },
  hudValue: {
    color: theme.text,
    letterSpacing: "0.08em",
    textTransform: "uppercase"
  },
  notesPanel: {
    position: "absolute",
    top: 62,
    left: 12,
    width: 260,
    padding: 12,
    background: "rgba(255,255,255,0.84)",
    border: `1px solid ${theme.border}`,
    display: "grid",
    gap: 6,
    zIndex: 4
  },
  noteLine: {
    fontSize: 12,
    color: theme.muted,
    lineHeight: 1.45
  },

  meshSweepA: {
    position: "absolute",
    inset: "8% 12%",
    background:
      "linear-gradient(90deg, rgba(0,0,0,0) 0%, rgba(140,140,140,0.06) 50%, rgba(0,0,0,0) 100%)"
  },
  meshSweepB: {
    position: "absolute",
    inset: "12% 18%",
    background:
      "linear-gradient(180deg, rgba(0,0,0,0) 0%, rgba(140,140,140,0.05) 50%, rgba(0,0,0,0) 100%)"
  },
  meshGridOverlay: {
    position: "absolute",
    inset: "10% 10% 16% 10%",
    background:
      "linear-gradient(rgba(0,0,0,0.035) 1px, transparent 1px), linear-gradient(90deg, rgba(0,0,0,0.035) 1px, transparent 1px)",
    backgroundSize: "18px 18px"
  },

  windTunnelGlow: {
    position: "absolute",
    inset: "18% 8% 18% 8%",
    background:
      "linear-gradient(90deg, rgba(98,122,146,0.06) 0%, rgba(125,160,190,0.12) 50%, rgba(98,122,146,0.06) 100%)"
  },
  flowBandA: (status?: string) => ({
    position: "absolute",
    left: "8%",
    right: "8%",
    top: "26%",
    height: 18,
    opacity: status === "running" ? 0.95 : 0.55,
    background:
      "linear-gradient(90deg, rgba(88,117,141,0) 0%, rgba(88,117,141,0.25) 18%, rgba(88,117,141,0.05) 60%, rgba(88,117,141,0) 100%)"
  }),
  flowBandB: (status?: string) => ({
    position: "absolute",
    left: "8%",
    right: "8%",
    top: "39%",
    height: 22,
    opacity: status === "running" ? 1 : 0.6,
    background:
      "linear-gradient(90deg, rgba(88,117,141,0) 0%, rgba(88,117,141,0.2) 18%, rgba(88,117,141,0.04) 60%, rgba(88,117,141,0) 100%)"
  }),
  flowBandC: (status?: string) => ({
    position: "absolute",
    left: "8%",
    right: "8%",
    top: "52%",
    height: 18,
    opacity: status === "running" ? 0.92 : 0.58,
    background:
      "linear-gradient(90deg, rgba(88,117,141,0) 0%, rgba(88,117,141,0.25) 18%, rgba(88,117,141,0.05) 60%, rgba(88,117,141,0) 100%)"
  }),
  flowArrowA: {
    position: "absolute",
    left: "12%",
    top: "28.5%",
    width: 90,
    height: 1,
    borderTop: "1px dashed rgba(82,111,137,0.44)"
  },
  flowArrowB: {
    position: "absolute",
    left: "12%",
    top: "42.5%",
    width: 110,
    height: 1,
    borderTop: "1px dashed rgba(82,111,137,0.44)"
  },
  flowArrowC: {
    position: "absolute",
    left: "12%",
    top: "55.5%",
    width: 90,
    height: 1,
    borderTop: "1px dashed rgba(82,111,137,0.44)"
  },

  loadField: {
    position: "absolute",
    inset: "18% 12%",
    background:
      "radial-gradient(circle at 50% 46%, rgba(134,104,75,0.08) 0%, rgba(134,104,75,0.03) 32%, rgba(0,0,0,0) 62%)"
  },
  forceArmA: {
    position: "absolute",
    left: "28%",
    top: "34%",
    width: "42%",
    borderTop: "2px dashed rgba(145,89,43,0.3)",
    transform: "rotate(-28deg)"
  },
  forceArmB: {
    position: "absolute",
    left: "42%",
    top: "46%",
    width: "22%",
    borderTop: "2px dashed rgba(145,89,43,0.34)",
    transform: "rotate(14deg)"
  },
  forceArmC: {
    position: "absolute",
    left: "54%",
    top: "40%",
    width: "16%",
    borderTop: "2px dashed rgba(145,89,43,0.38)",
    transform: "rotate(64deg)"
  },
  forceNodeA: {
    position: "absolute",
    left: "39%",
    top: "42%",
    width: 10,
    height: 10,
    borderRadius: "50%",
    background: "rgba(145,89,43,0.35)"
  },
  forceNodeB: {
    position: "absolute",
    left: "57%",
    top: "39%",
    width: 10,
    height: 10,
    borderRadius: "50%",
    background: "rgba(145,89,43,0.35)"
  },

  printBayGlow: {
    position: "absolute",
    inset: "18% 16%",
    background:
      "linear-gradient(180deg, rgba(85,116,129,0.04) 0%, rgba(85,116,129,0.1) 50%, rgba(85,116,129,0.03) 100%)"
  },
  printRailLeft: {
    position: "absolute",
    left: "34%",
    top: "20%",
    bottom: "22%",
    width: 3,
    background: "rgba(0,0,0,0.12)"
  },
  printRailRight: {
    position: "absolute",
    right: "34%",
    top: "20%",
    bottom: "22%",
    width: 3,
    background: "rgba(0,0,0,0.12)"
  },
  printScanA: (status?: string) => ({
    position: "absolute",
    left: "28%",
    right: "28%",
    top: status === "running" ? "34%" : "46%",
    height: 3,
    background: "rgba(85,116,129,0.26)",
    boxShadow: "0 0 16px rgba(85,116,129,0.18)"
  }),
  printScanB: (status?: string) => ({
    position: "absolute",
    left: "30%",
    right: "30%",
    top: status === "running" ? "55%" : "60%",
    height: 2,
    background: "rgba(85,116,129,0.18)"
  })
};

const shapeStyles = {
  tip: (mode: ViewerMode): CSSProperties => ({
    position: "absolute",
    left: "50%",
    top: 0,
    transform: "translateX(-50%)",
    width: 0,
    height: 0,
    borderLeft: "48px solid transparent",
    borderRight: "48px solid transparent",
    borderBottom: `92px solid ${mode === "mesh" ? "#dddddb" : "#d4d4d2"}`
  }),
  body: (mode: ViewerMode): CSSProperties => ({
    position: "absolute",
    left: "50%",
    top: 84,
    transform: "translateX(-50%)",
    width: 112,
    height: 214,
    background: mode === "mesh" ? meshFill : basePartFill,
    border: "1px solid rgba(0,0,0,0.12)",
    boxShadow: "0 12px 30px rgba(0,0,0,0.1)"
  }),
  bandTop: (mode: ViewerMode): CSSProperties => ({
    position: "absolute",
    left: "50%",
    top: 114,
    transform: "translateX(-50%)",
    width: 126,
    height: 14,
    background: mode === "mesh" ? "#bebebc" : "#b1b1af",
    border: "1px solid rgba(0,0,0,0.14)"
  }),
  bandMid: (mode: ViewerMode): CSSProperties => ({
    position: "absolute",
    left: "50%",
    top: 236,
    transform: "translateX(-50%)",
    width: 126,
    height: 18,
    background: mode === "mesh" ? "#b5b5b3" : "#a8a8a6",
    border: "1px solid rgba(0,0,0,0.14)"
  }),
  nozzleHint: (mode: ViewerMode): CSSProperties => ({
    position: "absolute",
    left: "50%",
    bottom: 16,
    transform: "translateX(-50%)",
    width: 74,
    height: 42,
    background: mode === "mesh" ? "linear-gradient(180deg, #8a8a89 0%, #737372 100%)" : darkMetal,
    clipPath: "polygon(10% 0%, 90% 0%, 100% 100%, 0% 100%)"
  }),

  shellOuter: (mode: ViewerMode): CSSProperties => ({
    position: "absolute",
    left: "50%",
    top: 34,
    transform: "translateX(-50%)",
    width: 146,
    height: 254,
    background: mode === "mesh" ? meshFill : basePartFill,
    border: "1px solid rgba(0,0,0,0.12)"
  }),
  shellInner: (mode: ViewerMode): CSSProperties => ({
    position: "absolute",
    left: "50%",
    top: 56,
    transform: "translateX(-50%)",
    width: 102,
    height: 210,
    background: mode === "mesh" ? "rgba(242,242,240,0.84)" : "rgba(255,255,255,0.45)",
    border: "1px solid rgba(0,0,0,0.08)"
  }),
  shellBraceLeft: (mode: ViewerMode): CSSProperties => ({
    position: "absolute",
    left: 54,
    top: 120,
    width: 26,
    height: 82,
    background: mode === "mesh" ? "#b6b6b4" : "#aaaaa8"
  }),
  shellBraceRight: (mode: ViewerMode): CSSProperties => ({
    position: "absolute",
    right: 54,
    top: 120,
    width: 26,
    height: 82,
    background: mode === "mesh" ? "#b6b6b4" : "#aaaaa8"
  }),

  armBase: (mode: ViewerMode): CSSProperties => ({
    position: "absolute",
    left: 42,
    bottom: 46,
    width: 58,
    height: 58,
    borderRadius: "50%",
    background: mode === "mesh" ? "#d8d8d6" : "#c8c8c6",
    border: "1px solid rgba(0,0,0,0.12)"
  }),
  armLink: (mode: ViewerMode): CSSProperties => ({
    position: "absolute",
    left: 86,
    top: 164,
    width: 106,
    height: 24,
    background: mode === "mesh" ? meshFill : basePartFill,
    transform: "rotate(-28deg)",
    transformOrigin: "left center",
    border: "1px solid rgba(0,0,0,0.12)"
  }),
  armJointA: (mode: ViewerMode): CSSProperties => ({
    position: "absolute",
    left: 88,
    top: 176,
    width: 24,
    height: 24,
    borderRadius: "50%",
    background: mode === "mesh" ? "#c8c8c6" : "#b8b8b6",
    border: "1px solid rgba(0,0,0,0.12)"
  }),
  armJointB: (mode: ViewerMode): CSSProperties => ({
    position: "absolute",
    right: 66,
    top: 116,
    width: 28,
    height: 28,
    borderRadius: "50%",
    background: mode === "mesh" ? "#c8c8c6" : "#b8b8b6",
    border: "1px solid rgba(0,0,0,0.12)"
  }),
  armHead: (mode: ViewerMode): CSSProperties => ({
    position: "absolute",
    right: 34,
    top: 82,
    width: 72,
    height: 42,
    background: mode === "mesh" ? meshFill : basePartFill,
    border: "1px solid rgba(0,0,0,0.12)"
  }),

  finFrame: (mode: ViewerMode): CSSProperties => ({
    position: "absolute",
    left: "50%",
    top: 58,
    transform: "translateX(-50%)",
    width: 146,
    height: 146,
    background: mode === "mesh" ? meshFill : "linear-gradient(180deg, #d3d3d1 0%, #b7b7b5 100%)",
    border: "10px solid rgba(0,0,0,0.18)"
  }),
  finGridA: (mode: ViewerMode): CSSProperties => ({
    position: "absolute",
    left: "50%",
    top: 102,
    transform: "translateX(-50%)",
    width: 126,
    borderTop: `10px solid ${mode === "mesh" ? "#9d9d9b" : "#8f8f8d"}`
  }),
  finGridB: (mode: ViewerMode): CSSProperties => ({
    position: "absolute",
    left: "50%",
    top: 136,
    transform: "translateX(-50%)",
    width: 126,
    borderTop: `10px solid ${mode === "mesh" ? "#9d9d9b" : "#8f8f8d"}`
  }),
  finGridC: (mode: ViewerMode): CSSProperties => ({
    position: "absolute",
    left: 72,
    top: 68,
    width: 10,
    height: 126,
    background: mode === "mesh" ? "#9d9d9b" : "#8f8f8d"
  }),
  finGridD: (mode: ViewerMode): CSSProperties => ({
    position: "absolute",
    right: 72,
    top: 68,
    width: 10,
    height: 126,
    background: mode === "mesh" ? "#9d9d9b" : "#8f8f8d"
  }),

  meshLine: (left: string, top: number, width: number): CSSProperties => ({
    position: "absolute",
    left,
    top,
    width,
    borderTop: "1px solid rgba(0,0,0,0.18)",
    transform: "translateX(-50%)"
  }),
  horizontalMesh: (top: number): CSSProperties => ({
    position: "absolute",
    left: "50%",
    top,
    width: 146,
    borderTop: "1px solid rgba(0,0,0,0.18)",
    transform: "translateX(-50%)"
  }),
  verticalMesh: (left: number): CSSProperties => ({
    position: "absolute",
    left,
    top: 34,
    width: 1,
    height: 254,
    background: "rgba(0,0,0,0.16)"
  }),
  armMeshA: {
    position: "absolute",
    left: 96,
    top: 150,
    width: 86,
    borderTop: "1px solid rgba(0,0,0,0.18)",
    transform: "rotate(-28deg)"
  } as CSSProperties,
  armMeshB: {
    position: "absolute",
    left: 108,
    top: 170,
    width: 66,
    borderTop: "1px solid rgba(0,0,0,0.18)",
    transform: "rotate(-28deg)"
  } as CSSProperties,
  armMeshC: {
    position: "absolute",
    right: 44,
    top: 102,
    width: 54,
    borderTop: "1px solid rgba(0,0,0,0.18)"
  } as CSSProperties,
  finDiagA: {
    position: "absolute",
    left: 56,
    top: 74,
    width: 140,
    borderTop: "1px solid rgba(0,0,0,0.16)",
    transform: "rotate(45deg)"
  } as CSSProperties,
  finDiagB: {
    position: "absolute",
    left: 52,
    top: 150,
    width: 140,
    borderTop: "1px solid rgba(0,0,0,0.16)",
    transform: "rotate(-45deg)"
  } as CSSProperties,
  finDiagC: {
    position: "absolute",
    left: 74,
    top: 64,
    width: 120,
    borderTop: "1px solid rgba(0,0,0,0.16)",
    transform: "rotate(45deg)"
  } as CSSProperties,
  finDiagD: {
    position: "absolute",
    left: 58,
    top: 140,
    width: 120,
    borderTop: "1px solid rgba(0,0,0,0.16)",
    transform: "rotate(-45deg)"
  } as CSSProperties
};
