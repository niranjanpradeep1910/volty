export type ModelFormat = 
| "obj"
| "cityjson"
| "gltf"
| "ply"
| "las"
| "laz"
| "copc";


export interface ModelMaterialGroup {
    start: number;
    count: number;
    semantic?: string;
}

export type PointAttributeType = 
| "scalar"
| "color"
| "category";

export interface PointAttribute {
    type: PointAttributeType;
    values: number[] | string[];
    min?: number;
    max?: number;
}

export interface ModelGeometry {
    type: "mesh" | "points";
    positions: number[];
    indices: number[];
    colors?: number[];
    lod?: string;
    elevationAxis?: 0 | 1 | 2;

    attributes?: Record<string, PointAttribute>;

    materialGroups?: ModelMaterialGroup[];

    source?: {
        format: ModelFormat;
        pointCount?: number;
        geometryType?: string;
        boundaries?: unknown;
        semantics?: unknown;
    };
}

export interface ModelObject {
    id:string;
    type: string;
    attributes: Record<string, unknown>;
    children: string[];
    geometries: ModelGeometry[];
}

export interface ValidationIssue {
    severity: "error" | "warning" | "info";
    code: string;
    message: string;
    objectId?: string;
    lod?: string;
    geometryType?: string;
}

export interface ValidationReport {
    valid: boolean;
    issues: ValidationIssue[];
}

export interface ModelStatistics {
    format: ModelFormat;
    objectCount: number;
    vertexCount?: number;
    triangleCount?: number;
    pointCount?: number;
    tileCount?: number;
    selectedLod?: string;
    semanticSurfaceCounts?: Record<string, number>;
}

export interface ModelDocument {
    format: ModelFormat;
    filename: string;
    metadata: Record<string, unknown>;
    objects: ModelObject[];
    availableLods: string[];
    selectedLod?: string;
    validation?: ValidationReport;
}

