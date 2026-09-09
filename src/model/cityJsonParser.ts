export interface CityJsonGeometry {
  type: string;
  lod: string;
  boundaries: unknown;
  semantics?: unknown;
}

export interface CityJsonObject {
  type: string;
  attributes: Record<string, unknown>;
  children: string[];
  geometry: CityJsonGeometry[];
}

export interface ParsedCityJson {
  type: "CityJSON";
  version: string;
  vertices: unknown[];
  cityObjects: Record<string, CityJsonObject>;
  metadata: Record<string, unknown>;
  transform?: unknown;
  availableLods: string[];
}

function isRecord(
  value: unknown
): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

function toLodString(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }

  if (typeof value === "string" && value.trim() !== "") {
    return value;
  }

  throw new Error(
    "CityJSON geometry has an invalid LoD"
  );
}

function readStringArray(
  value: unknown,
  fieldName: string,
  objectId: string
): string[] {
  if (value === undefined) {
    return [];
  }

  if (!Array.isArray(value)) {
    throw new Error(
      `CityObject ${objectId} field ${fieldName} must be an array`
    );
  }

  for (const item of value) {
    if (typeof item !== "string") {
      throw new Error(
        `CityObject ${objectId} field ${fieldName} contains a non-string value`
      );
    }
  }

  return value;
}

export function parseCityJson(
  input: string
): ParsedCityJson {
  const parsed: unknown = JSON.parse(input);

  if (!isRecord(parsed)) {
    throw new Error("CityJSON root must be an object");
  }

  if (parsed.type !== "CityJSON") {
    throw new Error("File is not a CityJSON document");
  }

  if (typeof parsed.version !== "string") {
    throw new Error("CityJSON version is missing");
  }

  if (!Array.isArray(parsed.vertices)) {
    throw new Error("CityJSON vertices must be an array");
  }

  if (!isRecord(parsed.CityObjects)) {
    throw new Error(
      "CityJSON CityObjects must be an object"
    );
  }

  const cityObjects: Record<string, CityJsonObject> = {};
  const lods = new Set<string>();

  for (const [id, rawObject] of Object.entries(
    parsed.CityObjects
  )) {
    if (!isRecord(rawObject)) {
      throw new Error(
        `CityObject ${id} must be an object`
      );
    }

    if (typeof rawObject.type !== "string") {
      throw new Error(
        `CityObject ${id} has no valid type`
      );
    }

    if (
      rawObject.attributes !== undefined &&
      !isRecord(rawObject.attributes)
    ) {
      throw new Error(
        `CityObject ${id} attributes must be an object`
      );
    }

    if (
      rawObject.geometry !== undefined &&
      !Array.isArray(rawObject.geometry)
    ) {
      throw new Error(
        `CityObject ${id} geometry must be an array`
      );
    }

    const geometries: CityJsonGeometry[] = [];

    for (const rawGeometry of rawObject.geometry ?? []) {
      if (!isRecord(rawGeometry)) {
        throw new Error(
          `Geometry in ${id} must be an object`
        );
      }

      if (typeof rawGeometry.type !== "string") {
        throw new Error(
          `Geometry in ${id} has no valid type`
        );
      }

      if (!("lod" in rawGeometry)) {
        throw new Error(
          `Geometry in ${id} has no LoD`
        );
      }

      if (!("boundaries" in rawGeometry)) {
        throw new Error(
          `Geometry in ${id} has no boundaries`
        );
      }

      const lod = toLodString(rawGeometry.lod);

      geometries.push({
        type: rawGeometry.type,
        lod,
        boundaries: rawGeometry.boundaries,
        semantics: rawGeometry.semantics
      });

      lods.add(lod);
    }

    cityObjects[id] = {
      type: rawObject.type,
      attributes: isRecord(rawObject.attributes)
        ? rawObject.attributes
        : {},
      children: readStringArray(
        rawObject.children,
        "children",
        id
      ),
      geometry: geometries
    };
  }

  const availableLods = Array.from(lods).sort(
    (a, b) => Number(a) - Number(b)
  );

  return {
    type: "CityJSON",
    version: parsed.version,
    vertices: parsed.vertices,
    cityObjects,
    metadata: isRecord(parsed.metadata)
      ? parsed.metadata
      : {},
    transform: parsed.transform,
    availableLods
  };
}
