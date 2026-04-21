import React, { type CSSProperties } from "react";
import { theme } from "@haf/shared";

export function GraphPaperRoom({ title = "GEOMETRY PREVIEW" }: { title?: string }) {
  return (
    <div style={styles.viewport}>
      <div style={styles.room}>
        <div style={styles.wall} />
        <div style={styles.floor} />
        <div style={styles.shadow} />

        <div style={styles.part}>
          <div style={styles.tip} />
          <div style={styles.body} />
          <div style={styles.bandTop} />
          <div style={styles.bandMid} />
          <div style={styles.nozzleHint} />
        </div>

        <div style={styles.overlayTop}>{title}</div>
        <div style={styles.overlayBottom}>MM · CONCEPT MODE · FABRICATION BAY</div>
      </div>
    </div>
  );
}

const gridBackground = `
  linear-gradient(${theme.grid} 1px, transparent 1px),
  linear-gradient(90deg, ${theme.grid} 1px, transparent 1px),
  linear-gradient(${theme.gridFine} 1px, transparent 1px),
  linear-gradient(90deg, ${theme.gridFine} 1px, transparent 1px)
`;

const styles: Record<string, CSSProperties> = {
  viewport: {
    width: "100%",
    height: "100%",
    minHeight: 420,
    background: "rgba(244,244,242,0.72)",
    border: `1px solid ${theme.border}`,
    overflow: "hidden",
    position: "relative"
  },
  room: {
    width: "100%",
    height: "100%",
    position: "relative",
    background: "linear-gradient(180deg, rgba(245,245,243,1) 0%, rgba(233,233,231,1) 100%)"
  },
  wall: {
    position: "absolute",
    inset: "0 0 42% 0",
    backgroundImage: gridBackground,
    backgroundSize: "80px 80px, 80px 80px, 20px 20px, 20px 20px",
    borderBottom: `1px solid ${theme.border}`
  },
  floor: {
    position: "absolute",
    left: "-10%",
    right: "-10%",
    bottom: "-12%",
    height: "44%",
    transform: "perspective(900px) rotateX(72deg)",
    transformOrigin: "center top",
    backgroundImage: gridBackground,
    backgroundSize: "80px 80px, 80px 80px, 20px 20px, 20px 20px",
    borderTop: `1px solid ${theme.border}`
  },
  shadow: {
    position: "absolute",
    left: "50%",
    top: "67%",
    width: 200,
    height: 48,
    transform: "translateX(-50%)",
    borderRadius: "50%",
    background: "radial-gradient(ellipse at center, rgba(0,0,0,0.22) 0%, rgba(0,0,0,0.06) 54%, rgba(0,0,0,0) 78%)",
    filter: "blur(2px)"
  },
  part: {
    position: "absolute",
    left: "50%",
    top: "48%",
    transform: "translate(-50%, -50%)",
    width: 160,
    height: 360
  },
  tip: {
    position: "absolute",
    left: "50%",
    top: 0,
    transform: "translateX(-50%)",
    width: 0,
    height: 0,
    borderLeft: "48px solid transparent",
    borderRight: "48px solid transparent",
    borderBottom: "90px solid #d4d4d2",
    filter: "drop-shadow(0 2px 2px rgba(0,0,0,0.16))"
  },
  body: {
    position: "absolute",
    left: "50%",
    top: 84,
    transform: "translateX(-50%)",
    width: 112,
    height: 214,
    background: "linear-gradient(180deg, #dfdfdd 0%, #c9c9c7 48%, #b5b5b3 100%)",
    border: "1px solid rgba(0,0,0,0.12)",
    boxShadow: "0 12px 30px rgba(0,0,0,0.1)"
  },
  bandTop: {
    position: "absolute",
    left: "50%",
    top: 114,
    transform: "translateX(-50%)",
    width: 126,
    height: 14,
    background: "#b1b1af",
    border: "1px solid rgba(0,0,0,0.14)"
  },
  bandMid: {
    position: "absolute",
    left: "50%",
    top: 236,
    transform: "translateX(-50%)",
    width: 126,
    height: 18,
    background: "#a8a8a6",
    border: "1px solid rgba(0,0,0,0.14)"
  },
  nozzleHint: {
    position: "absolute",
    left: "50%",
    bottom: 16,
    transform: "translateX(-50%)",
    width: 74,
    height: 42,
    background: "linear-gradient(180deg, #7f7f7e 0%, #616160 100%)",
    clipPath: "polygon(10% 0%, 90% 0%, 100% 100%, 0% 100%)"
  },
  overlayTop: {
    position: "absolute",
    top: 12,
    left: 12,
    fontSize: 11,
    letterSpacing: "0.14em",
    textTransform: "uppercase",
    color: theme.muted,
    background: "rgba(255,255,255,0.66)",
    padding: "6px 8px",
    border: `1px solid ${theme.border}`
  },
  overlayBottom: {
    position: "absolute",
    bottom: 12,
    right: 12,
    fontSize: 11,
    letterSpacing: "0.14em",
    textTransform: "uppercase",
    color: theme.muted,
    background: "rgba(255,255,255,0.66)",
    padding: "6px 8px",
    border: `1px solid ${theme.border}`
  }
};
