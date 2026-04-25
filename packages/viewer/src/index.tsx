import React, { type CSSProperties } from "react";
import { theme, type GeometryPreview } from "@haf/shared";

export type ViewerMode = "concept" | "mesh" | "simulation";

type VisualFamily =
  | "structural-bracket"
  | "bell-nozzle"
  | "pressure-vessel"
  | "rover-arm"
  | "grid-fin"
  | "nosecone"
  | "shell";

type Vec3 = [number, number, number];

type MeshFace = {
  indices: number[];
  shade?: number;
};

type MeshModel = {
  vertices: Vec3[];
  faces: MeshFace[];
};

type SafeGeometry = GeometryPreview & {
  family?: string;
  silhouette?: string;
  material?: string;
  widthMm?: number;
  heightMm?: number;
  depthMm?: number;
  lengthMm?: number;
  wallThicknessMm?: number;
  notes?: string[];
  dimensions?: Record<string, number>;
  derived?: Record<string, any>;
  derivedParameters?: Record<string, unknown>;
};

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
  const safeGeometry = geometry as SafeGeometry | undefined;
  const family = normalizeFamily(safeGeometry);
  const hasGeneratedGeometry = Boolean(family);
  const simulationLabel = family ? getSimulationLabel(family) : "SIMULATION VIEW";

  return (
    <div style={styles.viewport}>
      <div style={styles.room}>
        <div style={styles.wall} />
        <div style={styles.floor} />
        <div style={styles.ambientGlow} />

        {mode === "simulation" && family ? (
          <SimulationBackdrop family={family} status={status} />
        ) : null}

        {mode === "mesh" ? <MeshBackdrop /> : null}

        {hasGeneratedGeometry && family ? (
          <>
            <div style={styles.shadow} />
            <GeneratedMesh geometry={safeGeometry} family={family} mode={mode} status={status} />
          </>
        ) : null}

        <div style={styles.overlayTop}>{title}</div>

        <div style={styles.modeBadge}>
          {mode === "concept"
            ? "PART REVIEW"
            : mode === "mesh"
              ? "MESH VIEW"
              : simulationLabel}
        </div>

        <div style={styles.overlayBottom}>
          {safeGeometry ? formatGeometryLabel(safeGeometry) : "GENERATE CONCEPT · NO GEOMETRY LOADED"}
        </div>

        {mode === "simulation" ? (
          <div style={styles.simulationHud}>
            <HudRow label="MODE" value={simulationLabel} />
            <HudRow label="FLOW STATE" value={status === "running" ? "ACTIVE" : "PREVIEW"} />
            <HudRow label="GEOMETRY" value={family ? family.toUpperCase() : "NONE"} />
          </div>
        ) : null}

        {safeGeometry?.notes?.length ? (
          <div style={styles.notesPanel}>
            {safeGeometry.notes.slice(0, 3).map((note, index) => (
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

function GeneratedMesh({
  geometry,
  family,
  mode,
  status
}: {
  geometry: SafeGeometry;
  family: VisualFamily;
  mode: ViewerMode;
  status: string;
}) {
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const [rotation, setRotation] = React.useState(() => ({
    x: family === "bell-nozzle" ? -0.22 : -0.28,
    y: family === "bell-nozzle" ? 0.48 : 0.42
  }));

  const dragRef = React.useRef<{ x: number; y: number } | null>(null);

  React.useEffect(() => {
    setRotation({
      x: family === "bell-nozzle" ? -0.22 : -0.28,
      y: family === "bell-nozzle" ? 0.48 : 0.42
    });
  }, [family]);

  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const draw = () => {
      const rect = canvas.getBoundingClientRect();
      const ratio = window.devicePixelRatio || 1;

      canvas.width = Math.max(1, Math.floor(rect.width * ratio));
      canvas.height = Math.max(1, Math.floor(rect.height * ratio));

      drawGeneratedMesh(canvas, geometry, family, mode, status, rotation, ratio);
    };

    draw();

    const observer = new ResizeObserver(draw);
    observer.observe(canvas);

    return () => observer.disconnect();
  }, [geometry, family, mode, status, rotation]);

  return (
    <div style={styles.meshCanvasWrap}>
      <canvas
        ref={canvasRef}
        style={styles.meshCanvas}
        onPointerDown={(event) => {
          dragRef.current = { x: event.clientX, y: event.clientY };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          if (!dragRef.current) return;

          const dx = event.clientX - dragRef.current.x;
          const dy = event.clientY - dragRef.current.y;

          dragRef.current = { x: event.clientX, y: event.clientY };

          setRotation((current) => ({
            x: clamp(current.x + dy * 0.008, -1.25, 1.25),
            y: current.y + dx * 0.008
          }));
        }}
        onPointerUp={() => {
          dragRef.current = null;
        }}
        onPointerCancel={() => {
          dragRef.current = null;
        }}
      />

      <div style={styles.meshHint}>DRAG TO ROTATE</div>
    </div>
  );
}

function drawGeneratedMesh(
  canvas: HTMLCanvasElement,
  geometry: SafeGeometry,
  family: VisualFamily,
  mode: ViewerMode,
  status: string,
  rotation: { x: number; y: number },
  ratio: number
) {
  const context = canvas.getContext("2d");
  if (!context) return;

  context.clearRect(0, 0, canvas.width, canvas.height);

  const mesh = buildMeshForFamily(geometry, family);
  const projected = mesh.vertices.map((vertex) =>
    projectVertex(rotateVertex(vertex, rotation.x, rotation.y), canvas.width, canvas.height)
  );

  const faces = mesh.faces
    .map((face) => {
      const points = face.indices.map((index) => projected[index]);
      const z =
        face.indices.reduce((sum, index) => {
          const rotated = rotateVertex(mesh.vertices[index], rotation.x, rotation.y);
          return sum + rotated[2];
        }, 0) / Math.max(face.indices.length, 1);

      return { face, points, z };
    })
    .sort((a, b) => a.z - b.z);

  context.save();

  for (const item of faces) {
    if (item.points.length < 3) continue;

    context.beginPath();
    context.moveTo(item.points[0][0], item.points[0][1]);

    for (let index = 1; index < item.points.length; index += 1) {
      context.lineTo(item.points[index][0], item.points[index][1]);
    }

    context.closePath();

    const shade = item.face.shade ?? 0.74;
    const materialTone = getMaterialTone(geometry.material);

    if (mode === "simulation") {
      context.fillStyle =
        family === "bell-nozzle" || family === "grid-fin" || family === "nosecone"
          ? `rgba(${Math.floor(125 * shade)}, ${Math.floor(145 * shade)}, ${Math.floor(
              170 * shade
            )}, 0.94)`
          : `rgba(${Math.floor(160 * shade)}, ${Math.floor(128 * shade)}, ${Math.floor(
              86 * shade
            )}, 0.94)`;
    } else {
      context.fillStyle = `rgba(${Math.floor(materialTone[0] * shade)}, ${Math.floor(
        materialTone[1] * shade
      )}, ${Math.floor(materialTone[2] * shade)}, 0.97)`;
    }

    context.strokeStyle = mode === "mesh" ? "rgba(0,0,0,0.44)" : "rgba(0,0,0,0.18)";
    context.lineWidth = mode === "mesh" ? 1.2 * ratio : 0.8 * ratio;

    context.fill();
    context.stroke();
  }

  if (mode === "mesh") {
    drawMeshWireframe(context, mesh, projected, ratio);
  }

  if (mode === "simulation") {
    drawMeshStressOverlay(context, canvas.width, canvas.height, family, status, ratio);
  }

  context.restore();
}

function drawMeshWireframe(
  context: CanvasRenderingContext2D,
  mesh: MeshModel,
  projected: Array<[number, number]>,
  ratio: number
) {
  context.save();
  context.strokeStyle = "rgba(0,0,0,0.28)";
  context.lineWidth = 0.8 * ratio;

  for (const face of mesh.faces) {
    const points = face.indices.map((index) => projected[index]);
    if (points.length < 3) continue;

    context.beginPath();
    context.moveTo(points[0][0], points[0][1]);

    for (let index = 1; index < points.length; index += 1) {
      context.lineTo(points[index][0], points[index][1]);
    }

    context.closePath();
    context.stroke();
  }

  context.restore();
}

function drawMeshStressOverlay(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  family: VisualFamily,
  status: string,
  ratio: number
) {
  context.save();

  const isFlowFamily = family === "bell-nozzle" || family === "grid-fin" || family === "nosecone";

  context.globalAlpha = status === "running" ? 0.92 : 0.58;
  context.strokeStyle = isFlowFamily ? "rgba(60, 105, 150, 0.48)" : "rgba(150, 92, 35, 0.44)";
  context.lineWidth = 2 * ratio;
  context.setLineDash([10 * ratio, 8 * ratio]);

  for (let index = 0; index < 5; index += 1) {
    const y = height * (0.27 + index * 0.095);
    context.beginPath();

    if (isFlowFamily) {
      context.moveTo(width * 0.12, y);
      context.bezierCurveTo(width * 0.34, y - 16 * ratio, width * 0.62, y + 18 * ratio, width * 0.9, y);
    } else {
      context.moveTo(width * 0.28, y);
      context.lineTo(width * 0.72, y - 28 * ratio);
    }

    context.stroke();
  }

  context.restore();
}

function buildMeshForFamily(geometry: SafeGeometry, family: VisualFamily): MeshModel {
  if (family === "bell-nozzle") return buildBellNozzleMesh(geometry);
  if (family === "pressure-vessel") return buildPressureVesselMesh(geometry);
  if (family === "rover-arm") return buildRoverArmMesh(geometry);
  if (family === "grid-fin") return buildGridFinMesh(geometry);
  if (family === "nosecone") return buildNoseconeMesh(geometry);
  if (family === "shell") return buildShellMesh(geometry);

  return buildStructuralBracketMesh(geometry);
}

function buildStructuralBracketMesh(geometry: SafeGeometry): MeshModel {
  const width = getDimension(geometry, "widthMm", 140);
  const height = getDimension(geometry, "heightMm", 120);
  const depth = getDimension(geometry, "depthMm", 52);
  const wall = getDimension(geometry, "wallThicknessMm", 7);

  const mesh = createEmptyMesh();

  addBox(mesh, [-width / 2, -height / 2, -depth / 2], [width / 2, -height / 2 + wall, depth / 2]);
  addBox(mesh, [-width / 2, height / 2 - wall, -depth / 2], [width / 2, height / 2, depth / 2]);
  addBox(mesh, [-width / 2, -height / 2, -depth / 2], [-width / 2 + wall, height / 2, depth / 2]);
  addBox(mesh, [width / 2 - wall, -height / 2, -depth / 2], [width / 2, height / 2, depth / 2]);

  const ribWidth = Math.max(wall * 1.6, width * 0.08);
  addBox(mesh, [-ribWidth / 2, -height / 2 + wall, -depth / 2], [ribWidth / 2, height / 2 - wall, depth / 2]);

  addTriangularPrism(mesh, width, height, depth, wall, -1);
  addTriangularPrism(mesh, width, height, depth, wall, 1);

  const boltRadius = Math.max(wall * 0.8, width * 0.035);
  addBoltBoss(mesh, -width * 0.31, -height * 0.36, depth, boltRadius);
  addBoltBoss(mesh, width * 0.31, -height * 0.36, depth, boltRadius);
  addBoltBoss(mesh, -width * 0.31, height * 0.36, depth, boltRadius);
  addBoltBoss(mesh, width * 0.31, height * 0.36, depth, boltRadius);

  return centerAndScaleMesh(mesh);
}

function buildBellNozzleMesh(geometry: SafeGeometry): MeshModel {
  const derived = getDerivedParameters(geometry);

  const length = getDimension(geometry, "lengthMm", 180);
  const exitDiameter =
    numberFrom(derived.exitDiameterMm) ?? getDimension(geometry, "widthMm", 110);
  const throatDiameter = numberFrom(derived.throatDiameterMm) ?? exitDiameter * 0.28;
  const wall = getDimension(geometry, "wallThicknessMm", 3.2);
  const chamberDiameter = Math.max(throatDiameter * 2.4, exitDiameter * 0.42);

  const stations = [
    { z: -length * 0.5, radius: chamberDiameter / 2 },
    { z: -length * 0.31, radius: chamberDiameter / 2 },
    { z: -length * 0.13, radius: throatDiameter / 2 },
    { z: length * 0.12, radius: exitDiameter * 0.31 },
    { z: length * 0.34, radius: exitDiameter * 0.43 },
    { z: length * 0.5, radius: exitDiameter / 2 }
  ];

  return centerAndScaleMesh(createLatheMesh(stations, 32, wall));
}

function buildPressureVesselMesh(geometry: SafeGeometry): MeshModel {
  const length = getDimension(geometry, "lengthMm", 170);
  const diameter = Math.max(getDimension(geometry, "widthMm", 96), getDimension(geometry, "heightMm", 96));
  const wall = getDimension(geometry, "wallThicknessMm", 4);

  const stations = [
    { z: -length / 2, radius: diameter * 0.08 },
    { z: -length * 0.42, radius: diameter / 2 },
    { z: length * 0.42, radius: diameter / 2 },
    { z: length / 2, radius: diameter * 0.08 }
  ];

  return centerAndScaleMesh(createLatheMesh(stations, 28, wall));
}

function buildRoverArmMesh(geometry: SafeGeometry): MeshModel {
  const length = getDimension(geometry, "lengthMm", 170);
  const width = getDimension(geometry, "widthMm", 48);
  const depth = getDimension(geometry, "depthMm", 34);
  const wall = getDimension(geometry, "wallThicknessMm", 6);

  const mesh = createEmptyMesh();

  addBox(mesh, [-length / 2, -wall, -depth / 2], [length / 2, wall, depth / 2]);
  addBox(mesh, [-length / 2 - width / 2, -width / 2, -depth / 2], [-length / 2 + width / 2, width / 2, depth / 2]);
  addBox(mesh, [length / 2 - width / 2, -width / 2, -depth / 2], [length / 2 + width / 2, width / 2, depth / 2]);
  addBox(mesh, [-length * 0.18, -width * 0.18, -depth / 2], [length * 0.18, width * 0.18, depth / 2]);

  return centerAndScaleMesh(mesh);
}

function buildGridFinMesh(geometry: SafeGeometry): MeshModel {
  const width = getDimension(geometry, "widthMm", 132);
  const height = getDimension(geometry, "heightMm", 132);
  const depth = getDimension(geometry, "depthMm", 20);
  const wall = getDimension(geometry, "wallThicknessMm", 6);

  const mesh = createEmptyMesh();

  addBox(mesh, [-width / 2, -height / 2, -depth / 2], [width / 2, -height / 2 + wall, depth / 2]);
  addBox(mesh, [-width / 2, height / 2 - wall, -depth / 2], [width / 2, height / 2, depth / 2]);
  addBox(mesh, [-width / 2, -height / 2, -depth / 2], [-width / 2 + wall, height / 2, depth / 2]);
  addBox(mesh, [width / 2 - wall, -height / 2, -depth / 2], [width / 2, height / 2, depth / 2]);

  for (const offset of [-0.25, 0, 0.25]) {
    const x = width * offset;
    const y = height * offset;
    addBox(mesh, [x - wall / 2, -height / 2, -depth / 2], [x + wall / 2, height / 2, depth / 2]);
    addBox(mesh, [-width / 2, y - wall / 2, -depth / 2], [width / 2, y + wall / 2, depth / 2]);
  }

  return centerAndScaleMesh(mesh);
}

function buildNoseconeMesh(geometry: SafeGeometry): MeshModel {
  const length = getDimension(geometry, "lengthMm", 190);
  const diameter = getDimension(geometry, "widthMm", 80);
  const wall = getDimension(geometry, "wallThicknessMm", 3);

  const stations = [
    { z: -length / 2, radius: diameter / 2 },
    { z: -length * 0.18, radius: diameter * 0.45 },
    { z: length * 0.18, radius: diameter * 0.25 },
    { z: length / 2, radius: diameter * 0.02 }
  ];

  return centerAndScaleMesh(createLatheMesh(stations, 28, wall));
}

function buildShellMesh(geometry: SafeGeometry): MeshModel {
  const width = getDimension(geometry, "widthMm", 120);
  const height = getDimension(geometry, "heightMm", 160);
  const depth = getDimension(geometry, "depthMm", 36);
  const wall = getDimension(geometry, "wallThicknessMm", 6);

  const mesh = createEmptyMesh();

  addBox(mesh, [-width / 2, -height / 2, -depth / 2], [width / 2, height / 2, depth / 2]);
  addBox(mesh, [-width / 2 + wall * 1.6, -height / 2 + wall * 1.6, -depth / 2 - 1], [
    width / 2 - wall * 1.6,
    height / 2 - wall * 1.6,
    depth / 2 + 1
  ]);

  return centerAndScaleMesh(mesh);
}

function createLatheMesh(
  stations: Array<{ z: number; radius: number }>,
  segments: number,
  wallThickness: number
): MeshModel {
  const mesh = createEmptyMesh();

  for (const station of stations) {
    for (let index = 0; index < segments; index += 1) {
      const angle = (Math.PI * 2 * index) / segments;
      mesh.vertices.push([
        Math.cos(angle) * station.radius,
        Math.sin(angle) * station.radius,
        station.z
      ]);
    }
  }

  for (let stationIndex = 0; stationIndex < stations.length - 1; stationIndex += 1) {
    for (let segmentIndex = 0; segmentIndex < segments; segmentIndex += 1) {
      const next = (segmentIndex + 1) % segments;
      mesh.faces.push({
        indices: [
          stationIndex * segments + segmentIndex,
          stationIndex * segments + next,
          (stationIndex + 1) * segments + next,
          (stationIndex + 1) * segments + segmentIndex
        ],
        shade: 0.66 + (stationIndex / stations.length) * 0.22
      });
    }
  }

  const largestRadius = Math.max(...stations.map((station) => station.radius), 1);
  const innerScale = clamp(1 - wallThickness / largestRadius, 0.42, 0.94);
  const innerStart = mesh.vertices.length;

  for (const station of stations) {
    for (let index = 0; index < segments; index += 1) {
      const angle = (Math.PI * 2 * index) / segments;
      mesh.vertices.push([
        Math.cos(angle) * station.radius * innerScale,
        Math.sin(angle) * station.radius * innerScale,
        station.z
      ]);
    }
  }

  for (let stationIndex = 0; stationIndex < stations.length - 1; stationIndex += 1) {
    for (let segmentIndex = 0; segmentIndex < segments; segmentIndex += 1) {
      const next = (segmentIndex + 1) % segments;
      mesh.faces.push({
        indices: [
          innerStart + stationIndex * segments + segmentIndex,
          innerStart + (stationIndex + 1) * segments + segmentIndex,
          innerStart + (stationIndex + 1) * segments + next,
          innerStart + stationIndex * segments + next
        ],
        shade: 0.44
      });
    }
  }

  return mesh;
}

function addBox(mesh: MeshModel, min: Vec3, max: Vec3) {
  const start = mesh.vertices.length;
  const [x0, y0, z0] = min;
  const [x1, y1, z1] = max;

  mesh.vertices.push(
    [x0, y0, z0],
    [x1, y0, z0],
    [x1, y1, z0],
    [x0, y1, z0],
    [x0, y0, z1],
    [x1, y0, z1],
    [x1, y1, z1],
    [x0, y1, z1]
  );

  mesh.faces.push(
    { indices: [start + 0, start + 1, start + 2, start + 3], shade: 0.62 },
    { indices: [start + 4, start + 7, start + 6, start + 5], shade: 0.86 },
    { indices: [start + 0, start + 4, start + 5, start + 1], shade: 0.74 },
    { indices: [start + 1, start + 5, start + 6, start + 2], shade: 0.78 },
    { indices: [start + 2, start + 6, start + 7, start + 3], shade: 0.7 },
    { indices: [start + 3, start + 7, start + 4, start + 0], shade: 0.58 }
  );
}

function addTriangularPrism(
  mesh: MeshModel,
  width: number,
  height: number,
  depth: number,
  wall: number,
  side: -1 | 1
) {
  const start = mesh.vertices.length;
  const x0 = side < 0 ? -width / 2 + wall : width / 2 - wall;
  const x1 = side < 0 ? -width * 0.12 : width * 0.12;
  const y0 = -height / 2 + wall;
  const y1 = height / 2 - wall;
  const z0 = -depth / 2;
  const z1 = depth / 2;

  mesh.vertices.push(
    [x0, y0, z0],
    [x1, y0, z0],
    [x0, y1, z0],
    [x0, y0, z1],
    [x1, y0, z1],
    [x0, y1, z1]
  );

  mesh.faces.push(
    { indices: [start + 0, start + 1, start + 2], shade: 0.64 },
    { indices: [start + 3, start + 5, start + 4], shade: 0.82 },
    { indices: [start + 0, start + 3, start + 4, start + 1], shade: 0.76 },
    { indices: [start + 1, start + 4, start + 5, start + 2], shade: 0.68 },
    { indices: [start + 2, start + 5, start + 3, start + 0], shade: 0.58 }
  );
}

function addBoltBoss(mesh: MeshModel, x: number, y: number, depth: number, radius: number) {
  const segments = 12;
  const z0 = depth / 2;
  const z1 = depth / 2 + radius * 0.55;
  const start = mesh.vertices.length;

  for (let layer = 0; layer < 2; layer += 1) {
    for (let index = 0; index < segments; index += 1) {
      const angle = (Math.PI * 2 * index) / segments;
      mesh.vertices.push([
        x + Math.cos(angle) * radius,
        y + Math.sin(angle) * radius,
        layer === 0 ? z0 : z1
      ]);
    }
  }

  for (let index = 0; index < segments; index += 1) {
    const next = (index + 1) % segments;
    mesh.faces.push({
      indices: [start + index, start + next, start + segments + next, start + segments + index],
      shade: 0.82
    });
  }
}

function createEmptyMesh(): MeshModel {
  return {
    vertices: [],
    faces: []
  };
}

function centerAndScaleMesh(mesh: MeshModel): MeshModel {
  if (!mesh.vertices.length) return mesh;

  const xs = mesh.vertices.map((vertex) => vertex[0]);
  const ys = mesh.vertices.map((vertex) => vertex[1]);
  const zs = mesh.vertices.map((vertex) => vertex[2]);

  const centerX = (Math.min(...xs) + Math.max(...xs)) / 2;
  const centerY = (Math.min(...ys) + Math.max(...ys)) / 2;
  const centerZ = (Math.min(...zs) + Math.max(...zs)) / 2;

  return {
    vertices: mesh.vertices.map(([x, y, z]) => [x - centerX, y - centerY, z - centerZ]),
    faces: mesh.faces
  };
}

function rotateVertex(vertex: Vec3, rx: number, ry: number): Vec3 {
  const [x, y, z] = vertex;

  const cosY = Math.cos(ry);
  const sinY = Math.sin(ry);

  const x1 = x * cosY + z * sinY;
  const z1 = -x * sinY + z * cosY;

  const cosX = Math.cos(rx);
  const sinX = Math.sin(rx);

  const y2 = y * cosX - z1 * sinX;
  const z2 = y * sinX + z1 * cosX;

  return [x1, y2, z2];
}

function projectVertex(vertex: Vec3, width: number, height: number): [number, number] {
  const [x, y, z] = vertex;
  const sceneSize = Math.min(width, height);

  const scale = sceneSize * 0.00165;
  const distance = sceneSize * 2.4;
  const perspective = distance / Math.max(distance + z * scale * 28, 1);

  return [width / 2 + x * scale * perspective, height / 2 - y * scale * perspective];
}

function normalizeFamily(geometry?: SafeGeometry): VisualFamily | undefined {
  const rawFamily = geometry?.family ?? geometry?.silhouette;

  if (!rawFamily) return undefined;

  if (rawFamily === "structural-bracket") return "structural-bracket";
  if (rawFamily === "bell-nozzle") return "bell-nozzle";
  if (rawFamily === "pressure-vessel") return "pressure-vessel";
  if (rawFamily === "rover-arm") return "rover-arm";
  if (rawFamily === "grid-fin") return "grid-fin";
  if (rawFamily === "nosecone") return "nosecone";
  if (rawFamily === "shell") return "shell";

  return undefined;
}

function formatGeometryLabel(geometry: SafeGeometry) {
  const material = geometry.material ?? "MATERIAL TBD";
  const primaryLength =
    getDimensionOptional(geometry, "lengthMm") ??
    getDimensionOptional(geometry, "heightMm") ??
    getDimensionOptional(geometry, "widthMm");

  const wallThickness = getDimensionOptional(geometry, "wallThicknessMm");

  return `${material} · ${formatNumber(primaryLength)}MM · ${formatNumber(wallThickness)}MM WALL`;
}

function getDimension(geometry: SafeGeometry, key: string, fallback: number) {
  return getDimensionOptional(geometry, key) ?? fallback;
}

function getDimensionOptional(geometry: SafeGeometry, key: string) {
  const direct = (geometry as Record<string, unknown>)[key];
  if (typeof direct === "number" && !Number.isNaN(direct)) return direct;

  const dimension = geometry.dimensions?.[key];
  if (typeof dimension === "number" && !Number.isNaN(dimension)) return dimension;

  const derivedValue = geometry.derived?.[key];
  if (typeof derivedValue === "number" && !Number.isNaN(derivedValue)) return derivedValue;

  return undefined;
}

function getDerivedParameters(geometry: SafeGeometry) {
  return (
    geometry.derivedParameters ??
    geometry.derived?.derivedParameters ??
    geometry.derived?.derived ??
    {}
  ) as Record<string, unknown>;
}

function getMaterialTone(material?: string): [number, number, number] {
  if (!material) return [210, 210, 206];

  const normalized = material.toLowerCase();

  if (normalized.includes("inconel")) return [205, 204, 198];
  if (normalized.includes("titanium") || normalized.includes("ti-")) return [196, 202, 207];
  if (normalized.includes("copper") || normalized.includes("grcop")) return [214, 178, 136];
  if (normalized.includes("niobium") || normalized.includes("c103")) return [194, 190, 204];
  if (normalized.includes("al")) return [216, 216, 210];

  return [210, 210, 206];
}

function formatNumber(value?: number) {
  if (typeof value !== "number" || Number.isNaN(value)) return "—";
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function numberFrom(value: unknown) {
  return typeof value === "number" && !Number.isNaN(value) ? value : undefined;
}

function HudRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={styles.hudRow}>
      <span style={styles.hudLabel}>{label}</span>
      <span style={styles.hudValue}>{value}</span>
    </div>
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
  family: VisualFamily;
  status?: string;
}) {
  if (family === "bell-nozzle" || family === "nosecone" || family === "grid-fin") {
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

  if (family === "rover-arm" || family === "structural-bracket") {
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

function getSimulationLabel(family: VisualFamily) {
  if (family === "bell-nozzle" || family === "nosecone" || family === "grid-fin") {
    return "FLOW REVIEW";
  }

  if (family === "rover-arm" || family === "structural-bracket") {
    return "LOAD TEST";
  }

  return "PRINT STAND";
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

const gridBackground = `
  linear-gradient(${theme.grid} 1px, transparent 1px),
  linear-gradient(90deg, ${theme.grid} 1px, transparent 1px),
  linear-gradient(${theme.gridFine} 1px, transparent 1px),
  linear-gradient(90deg, ${theme.gridFine} 1px, transparent 1px)
`;

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
  meshCanvasWrap: {
    position: "absolute",
    inset: "44px 0 36px 0",
    zIndex: 2
  },
  meshCanvas: {
    width: "100%",
    height: "100%",
    display: "block",
    cursor: "grab",
    touchAction: "none"
  },
  meshHint: {
    position: "absolute",
    left: "50%",
    bottom: 18,
    transform: "translateX(-50%)",
    padding: "7px 10px",
    background: "rgba(255,255,255,0.72)",
    border: `1px solid ${theme.border}`,
    fontSize: 10,
    letterSpacing: "0.14em",
    color: theme.muted,
    textTransform: "uppercase",
    pointerEvents: "none"
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
    filter: "blur(2px)",
    zIndex: 1
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
