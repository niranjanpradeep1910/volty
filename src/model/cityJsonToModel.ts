import {
  ModelDocument,
  ModelGeometry,
  ValidationIssue
} from "./modelTypes";

import { parseCityJson } from "./cityJsonParser";
import { convertMultiSurface, convertSolid } from "./cityJsonGeometry";

export function cityJsonToModel(
  filename: string,
  content: string
): ModelDocument {
  const parsed = parseCityJson(content);
  const issues: ValidationIssue[] = [];

  const objects = Object.entries(
    parsed.cityObjects
  ).map(([id, cityObject]) => {
    const geometries: ModelGeometry[] =
      cityObject.geometry.map((geometry) => {
        let converted;

        try {
            converted = geometry.type === "MultiSurface"
            ? convertMultiSurface(parsed, geometry)
            : geometry.type === "Solid"
            ? convertSolid(parsed, geometry)
            :{
                positions: [],
                indices: [],
                materialGroups: []
              };
            }
        catch (error) {
          const message = error instanceof Error
          ? error.message
          : "Unknown geometry conversion error";

          issues.push({
            severity: "warning",
            code: "GEOMETRY_CONVERSION_FAILED",
            message,
            objectId: id,
            lod: geometry.lod,
            geometryType: geometry.type
          });


          console.warn(
            `Skipping ${geometry.type} LoD ${geometry.lod}` + 
            `for ${id}: ${message}`
          );

          converted = {
            positions: [],
            indices: [],
            materialGroups: []
          };
          
        }
        return {
          type: "mesh",
          positions: converted.positions,
          indices: converted.indices,
          materialGroups: converted.materialGroups,
          lod: geometry.lod,
          source: {
            format: "cityjson",
            geometryType: geometry.type,
            boundaries: geometry.boundaries,
            semantics: geometry.semantics
          }
        };
      });

    return {
      id,
      type: cityObject.type,
      attributes: cityObject.attributes,
      children: cityObject.children,
      geometries
    };
  });

  return {
    format: "cityjson",
    filename,
    metadata: parsed.metadata,
    objects,
    availableLods: parsed.availableLods,
    validation: {
      valid: issues.every(
        (issue) => issue.severity !== "error"
      ),
      issues
    }
  };
}
