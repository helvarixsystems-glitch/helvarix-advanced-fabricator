export function getExportFilename(componentName: string, extension: "stl" | "step" | "json") {
  const safe = componentName.toLowerCase().replace(/\s+/g, "-");
  return `${safe}.${extension}`;
}
