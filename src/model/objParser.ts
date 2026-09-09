export interface ParsedObj {
  positions: number[];
  indices: number[];
}

export function parseObj(input: string): ParsedObj {
  const positions: number[] = [];
  const indices: number[] = [];

  for (const rawLine of input.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const [command, ...values] = line.split(/\s+/);

    if (command === "v") {
      const [x, y, z] = values.map(Number);
      if (
        values.length < 3 ||
        !Number.isFinite(x) ||
        !Number.isFinite(y) ||
        !Number.isFinite(z)
      ) {
        throw new Error("OBJ vertex must contain three finite coordinates");
      }

      positions.push(x, y, z);
      continue;
    }

    if (command !== "f" || values.length < 3) {
      continue;
    }

    const vertexIndex = (value: string): number => {
      const rawIndex = Number(value.split("/")[0]);
      const vertexCount = positions.length / 3;

      if (!Number.isInteger(rawIndex) || rawIndex === 0) {
        throw new Error(`OBJ face has an invalid vertex index: ${value}`);
      }

      const index = rawIndex > 0
        ? rawIndex - 1
        : vertexCount + rawIndex;

      if (index < 0 || index >= vertexCount) {
        throw new Error(`OBJ face references missing vertex: ${value}`);
      }

      return index;
    };

    const first = vertexIndex(values[0]);
    for (let index = 1; index < values.length - 1; index++) {
      indices.push(
        first,
        vertexIndex(values[index]),
        vertexIndex(values[index + 1])
      );
    }
  }

  return { positions, indices };
}
