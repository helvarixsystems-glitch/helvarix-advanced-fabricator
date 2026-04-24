import {
  MeshSettings,
  SimulationArtifact,
  SimulationGeometryInput,
  Vec3,
} from "../types";

export interface GmshGeometryBundle {
  jobName: string;
  geoFileName: string;
  geoText: string;
  artifacts: SimulationArtifact[];
}

/**
 * Gmsh Adapter
 *
 * This generates `.geo` scripts for meshing.
 *
 * Current role:
 * - Creates a box/bracket-style meshing script.
 * - Produces artifacts your job system can save or display.
 *
 * Later role:
 * - Run `gmsh part.geo -3 -format inp`
 * - Feed generated mesh into CalculiX.
 */
export class GmshAdapter {
  buildGeometryBundle(input: {
    jobId: string;
    geometry: SimulationGeometryInput;
    mesh: MeshSettings;
  }): GmshGeometryBundle {
    const jobName = safeName(input.jobId);
    const geoFileName = `${jobName}.geo`;

    const geoText = buildGeoText({
      geometry: input.geometry,
      mesh: input.mesh,
    });

    return {
      jobName,
      geoFileName,
      geoText,
      artifacts: [
        {
          id: `artifact_gmsh_geo_${jobName}`,
          kind: "mesh",
          label: "Gmsh Geometry Script",
          inlineText: geoText,
          metadata: {
            fileName: geoFileName,
            mesher: "gmsh",
          },
        },
      ],
    };
  }
}

function buildGeoText(input: {
  geometry: SimulationGeometryInput;
  mesh: MeshSettings;
}): string {
  const { geometry, mesh } = input;

  const box = geometry.boundingBoxMm;
  const bracket = createBracketApproximation(box);

  const lc = mesh.targetElementSizeMm;

  return [
    `// Helvarix Advanced Fabricator - Gmsh Geometry`,
    `// Geometry: ${geometry.name}`,
    `// Primitive: ${geometry.primitive ?? "custom"}`,
    ``,
    `SetFactory("OpenCASCADE");`,
    ``,
    `lc = ${lc};`,
    ``,
    `// Main bracket body`,
    `Box(1) = {0, 0, 0, ${bracket.base.x}, ${bracket.base.y}, ${bracket.base.z}};`,
    ``,
    `// Upright support body`,
    `Box(2) = {0, 0, 0, ${bracket.upright.x}, ${bracket.upright.y}, ${bracket.upright.z}};`,
    ``,
    `// Top mounting tab`,
    `Box(3) = {0, ${bracket.base.y - bracket.tab.y}, ${
      bracket.upright.z - bracket.tab.z
    }, ${bracket.tab.x}, ${bracket.tab.y}, ${bracket.tab.z}};`,
    ``,
    `// Fuse bracket volumes`,
    `BooleanUnion{ Volume{1}; Delete; }{ Volume{2,3}; Delete; }`,
    ``,
    `// Mounting holes as cylinders`,
    ...buildHoleCylinders(bracket),
    ``,
    `// Subtract holes if possible`,
    `BooleanDifference{ Volume{1}; Delete; }{ Volume{10,11,12}; Delete; }`,
    ``,
    `// Mesh sizing`,
    `Mesh.CharacteristicLengthMin = ${mesh.minElementSizeMm ?? lc * 0.5};`,
    `Mesh.CharacteristicLengthMax = ${mesh.maxElementSizeMm ?? lc * 2};`,
    `Mesh.Optimize = 1;`,
    `Mesh.OptimizeNetgen = 1;`,
    ``,
    `// Physical regions for future load/constraint mapping`,
    `Physical Volume("part") = {1};`,
    `Physical Surface("base-mounting-face") = {1};`,
    `Physical Surface("outer-mounting-face") = {2};`,
    ``,
    `Mesh 3;`,
    ``,
  ].join("\n");
}

function createBracketApproximation(box: Vec3) {
  return {
    base: {
      x: box.x,
      y: box.y * 0.28,
      z: box.z * 0.45,
    },
    upright: {
      x: box.x * 0.22,
      y: box.y,
      z: box.z,
    },
    tab: {
      x: box.x * 0.42,
      y: box.y * 0.24,
      z: box.z * 0.38,
    },
    holeRadius: Math.max(2, Math.min(box.x, box.y, box.z) * 0.065),
  };
}

function buildHoleCylinders(bracket: ReturnType<typeof createBracketApproximation>) {
  const r = bracket.holeRadius;

  const baseY = bracket.base.y * 0.5;
  const baseZ = bracket.base.z * 0.5;

  const hole1X = bracket.base.x * 0.25;
  const hole2X = bracket.base.x * 0.75;

  const tabX = bracket.tab.x * 0.5;
  const tabY = bracket.base.y - bracket.tab.y * 0.5;
  const tabZ = bracket.upright.z - bracket.tab.z * 0.5;

  return [
    `Cylinder(10) = {${hole1X}, ${baseY}, ${baseZ}, 0, ${bracket.base.y}, 0, ${r}};`,
    `Cylinder(11) = {${hole2X}, ${baseY}, ${baseZ}, 0, ${bracket.base.y}, 0, ${r}};`,
    `Cylinder(12) = {${tabX}, ${tabY}, ${tabZ}, ${bracket.tab.x}, 0, 0, ${r}};`,
  ];
}

function safeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 48);
}
