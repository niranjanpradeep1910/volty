import type {
    ModelDocument,
    ModelGeometry,
    ModelStatistics
} from "./modelTypes";

export function calculateMeshStatistics(
    document: ModelDocument,
    geometry: ModelGeometry,
    selectedLod?: string
): ModelStatistics {
    const semanticSurfaceCounts:
        Record<string, number> = {};

    for (const group of geometry.materialGroups ?? []) {
        if (!group.semantic) {
            continue;
        }

        semanticSurfaceCounts[group.semantic] =
            (semanticSurfaceCounts[group.semantic] ?? 0) + 1;
    }

    if (geometry.type === "points") {
        return {
            format: document.format,
            objectCount: document.objects.length,
            pointCount: geometry.positions.length / 3,
            selectedLod,
            semanticSurfaceCounts
        };
    }

    return {
        format: document.format,
        objectCount: document.objects.length,
        vertexCount: geometry.positions.length / 3,
        triangleCount: geometry.indices.length / 3,
        selectedLod,
        semanticSurfaceCounts
    };
}
