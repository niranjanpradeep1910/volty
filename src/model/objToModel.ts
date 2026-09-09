import { parseObj } from "./objParser";
import {
  ModelDocument,
  ModelGeometry
} from "./modelTypes";

export function objToModel(
  filename: string,
  content: string
): ModelDocument {
  const parsed = parseObj(content);

  const geometry: ModelGeometry = {
    type: "mesh",
    positions: parsed.positions,
    indices: parsed.indices
  };

  return {
    format: "obj",
    filename,
    metadata: {},
    objects: [
      {
        id: filename,
        type: "OBJModel",
        attributes: {},
        children: [],
        geometries: [geometry]
      }
    ],
    availableLods: []
  };
}
