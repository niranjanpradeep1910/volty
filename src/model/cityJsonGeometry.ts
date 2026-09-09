import {
    CityJsonGeometry,
    ParsedCityJson
} from "./cityJsonParser";

import earcut, { flatten } from "earcut";

import type {
    ModelMaterialGroup
} from "./modelTypes";


interface CityJsonTransform {
    scale: [number, number, number];
    translate: [number, number, number];
}

interface ConvertedGeometry {
    positions: number[];
    indices: number[];
    materialGroups: ModelMaterialGroup[];
}

function readTransform(
    value: unknown
): CityJsonTransform {
    if (
        typeof value !== "object" || 
        value === null ||
        Array.isArray(value)
    ) {
        return {
            scale: [1, 1, 1],
            translate: [0, 0, 0]
        };
    }

    const transform = value as Record<string, unknown>;

    if ( 
        !Array.isArray(transform.scale) ||
        !Array.isArray(transform.translate) ||
        transform.scale.length !== 3 ||
        transform.translate.length !== 3
    ) {

        throw new Error(
            "CityJSON transform must contain scale and translate arrays of length 3"
        );
    }

    const scale = transform.scale;
    const translate = transform.translate;

    if (
        !scale.every(
            (item): item is number =>
                typeof item === "number"
        ) || 
        !translate.every(
            (item): item is number =>
                typeof item === "number"
        )
    ){
        throw new Error("CityJSON transform values must be numbers");
    }

    return {
        scale: [scale[0], scale[1], scale[2]],
        translate: [
            translate[0],
            translate[1],
            translate[2]
        ]
    };
}

function readVertex(
    document: ParsedCityJson,
    index: number,
    transform: CityJsonTransform
): [number, number, number] {
    if (
        !Number.isInteger(index) ||
        index < 0 ||
        index >= document.vertices.length
    ) {
        throw new Error(
            `CityJSON references invalid vertex index ${index}`
        );
    }

    const rawVertex = document.vertices[index];

    if(
        !Array.isArray(rawVertex) ||
        rawVertex.length !== 3 ||
        !rawVertex.every(
            (value): value is number =>
                typeof value === "number"
        )
    ) {
        throw new Error(
            `CityJSON vertex ${index} must contain three numbers`
        );
    }

    return [
        rawVertex[0] * transform.scale[0] + transform.translate[0],
        rawVertex[2] * transform.scale[2] + transform.translate[2],
        -(
            rawVertex[1] * transform.scale[1] + transform.translate[1]
        ),
    ];
}

function getSemanticType(
    semantics: unknown,
    surfaceIndex: number
): string | undefined {
    if (
        typeof semantics !== "object" ||
        semantics === null ||
        Array.isArray(semantics)
    ) {
        return undefined;
    }

    const semanticObject = semantics as Record<string, unknown>;

    if(
        !Array.isArray(semanticObject.values) ||
        !Array.isArray(semanticObject.surfaces)
    ) {
        return undefined;
    }

    const semanticIndex = semanticObject.values[surfaceIndex];

    if(typeof semanticIndex !== "number"){
        return undefined;
    }

    const surface = semanticObject.surfaces[semanticIndex];

    if(
        typeof surface !== "object" ||
        surface === null ||
        Array.isArray(surface)
    ) {
        return undefined;
    }

    const surfaceObject = surface as Record<string,unknown>;

    return typeof surfaceObject.type === "string"
    ? surfaceObject.type
    : undefined;
}


type Point3 = [number, number, number];

function getSurfaceNormal(
    ring: Point3[]
): Point3 | undefined {
    let normalX = 0;
    let normalY = 0;
    let normalZ = 0;

    for (let index = 0; index < ring.length; index++) {
        const current = ring[index];
        const next = ring[(index + 1) % ring.length];

        normalX +=
            (current[1] - next[1]) *
            (current[2] + next[2]);

        normalY +=
            (current[2] - next[2]) *
            (current[0] + next[0]);

        normalZ +=
            (current[0] - next[0]) *
            (current[1] + next[1]);
    }

    const magnitude = Math.sqrt(
        normalX * normalX +
        normalY * normalY +
        normalZ * normalZ
    );

    if (magnitude === 0) {
            return undefined;
    }

    return [
        normalX / magnitude,
        normalY / magnitude,
        normalZ / magnitude
    ];


}


function getProjectionAxis(
    ring: Point3[]
): 0 | 1 | 2 {
    let normalX = 0;
    let normalY = 0;
    let normalZ = 0;

    for (let index = 0; index < ring.length; index++){
        const current = ring[index];
        const next = ring[(index + 1) % ring.length];

        normalX += (current[1] - next[1]) * (current[2] + next[2]);
        normalY += (current[2] - next[2]) * (current[0] + next[0]);
        normalZ += (current[0] - next[0]) * (current[1] + next[1]);
    }

    const absX = Math.abs(normalX);
    const absY = Math.abs(normalY);
    const absZ = Math.abs(normalZ);

    if (absX >= absY && absX >= absZ){
        return 0;
    }

    if (absY >= absZ){
        return 1;
    }

    return 2;
}

function projectPoint(
    point: Point3,
    projectionAxis: 0 | 1 | 2): [number, number] {
        if (projectionAxis === 0){
            return [point[1], point[2]];
        }

        if (projectionAxis === 1){
            return [point[0], point[2]];
        }

        return [point[0], point[1]];
    }




export function convertMultiSurface(
    document: ParsedCityJson,
    geometry: CityJsonGeometry
): ConvertedGeometry {
    if (geometry.type !== "MultiSurface") {
        throw new Error(
            `Unsupported CityJSON geometry type : ${geometry.type}`
        );
    }


    if(!Array.isArray(geometry.boundaries)){
        throw new Error(
            "MultiSurface boundaries must be an array"
        );
    }

    const transform = readTransform(
        document.transform
    );

    const positions: number[] = [];
    const indices: number[] = [];
    const materialGroups: ModelMaterialGroup[] = [];

    for (
        let surfaceIndex = 0;
        surfaceIndex < geometry.boundaries.length;
        surfaceIndex++
    ) {
        const surface = geometry.boundaries[surfaceIndex];
        if(
            !Array.isArray(surface) ||
            surface.length === 0
        ){
            throw new Error(
                "Each surface must contain at least one ring"
            );
        }

        const rings: number[][] = [];

        for (const rawRing of surface){
            if (
                !Array.isArray(rawRing) ||
                !rawRing.every(
                    (value): value is number =>
                        Number.isInteger(value)
                )
            ){
                throw new Error(
                    "CityJSON rings must contain integer vertex indices"
                );
            }

            const ring = rawRing.length > 3 &&
            rawRing[0] === rawRing[rawRing.length - 1]
            ? rawRing.slice(0, -1)
            :rawRing;

            if (ring.length < 3) {
                throw new Error(
                    "A ring must contain at least three vertices"
                );
            }

            rings.push(ring);
        }

        const ringPoints: Point3[][] = rings.map(
            (ring) => 
                ring.map((vertexIndex) =>
                readVertex(
                    document,
                    vertexIndex,
                    transform
                )
            )
        );

        const allPoints = ringPoints.flat();

        const surfaceNormal = getSurfaceNormal(
            ringPoints[0]
        );

        if(!surfaceNormal){
            console.warn(
                `Skipping degenerate CityJSON surface ${surfaceIndex}`
            );
            
            continue;
        }

        const projectionAxis = getProjectionAxis(
            ringPoints[0]
        );

        const flatCoordinates: number[] = [];
        const holeIndices: number[] = [];

        const firstIndex = positions.length / 3;
        for (
            let ringIndex = 0;
            ringIndex < ringPoints.length;
            ringIndex++
        ) {
            if (ringIndex > 0){
                holeIndices.push(
                    flatCoordinates.length / 2
                );
            }

            for (const point of ringPoints[ringIndex]) {
                positions.push(
                    point[0],
                    point[1],
                    point[2]
                );

                const projected = projectPoint(
                    point,
                    projectionAxis
                );

                flatCoordinates.push(
                    projected[0],
                    projected[1]
                );
            }
        }

        const triangulatedIndices = earcut(
            flatCoordinates,
            holeIndices,
            2
        );

        const indexStart = indices.length;

        for (let index = 0; index < triangulatedIndices.length; index+=3) {
            const localA = triangulatedIndices[index];
            const localB = triangulatedIndices[index + 1];
            const localC = triangulatedIndices[index + 2];

            const pointA = allPoints[localA];
            const pointB = allPoints[localB];
            const pointC = allPoints[localC];

            const edgeAB: Point3 = [
                pointB[0] - pointA[0],
                pointB[1] - pointA[1],
                pointB[2] - pointA[2]
            ];

            const edgeAC: Point3 = [
                pointC[0] - pointA[0],
                pointC[1] - pointA[1],
                pointC[2] - pointA[2]
            ];

            const triangleNormal: Point3 = [
                edgeAB[1] * edgeAC[2] -
                    edgeAB[2] * edgeAC[1],

                edgeAB[2] * edgeAC[0] -
                    edgeAB[0] * edgeAC[2],

                edgeAB[0] * edgeAC[1] -
                    edgeAB[1] * edgeAC[0]
            ];

            const dotProduct =
                triangleNormal[0] * surfaceNormal[0] +
                triangleNormal[1] * surfaceNormal[1] +
                triangleNormal[2] * surfaceNormal[2];

            if (dotProduct < 0) {
                indices.push(
                    firstIndex + localA,
                    firstIndex + localC,
                    firstIndex + localB
                );
            } else {
                indices.push(
                    firstIndex + localA,
                    firstIndex + localB,
                    firstIndex + localC
                );
            }

        }

        const triangleCount = 
            indices.length - indexStart;

        if (triangleCount > 0){
            materialGroups.push({
                start: indexStart,
                count: triangleCount,
                semantic: getSemanticType(
                    geometry.semantics,
                    surfaceIndex
                )
            });
        }


    }

    return {
        positions,
        indices,
        materialGroups
    };
}


export function convertSolid(
    document: ParsedCityJson,
    geometry: CityJsonGeometry
): ConvertedGeometry {
    if (geometry.type !== "Solid") {
        throw new Error(
    `Unsupported CityJSON geometry type: ${geometry.type}`);
        }
    
    if (!Array.isArray(geometry.boundaries)) {
        throw new Error(
            "Solid boundaries must be an array of shells"
        );
    }

    const flattenedBoundaries: unknown[] = [];
    const flattenedValues: unknown[] = [];

    const semantics = typeof geometry.semantics === "object" &&
    geometry.semantics !== null && 
    !Array.isArray(geometry.semantics)
    ?geometry.semantics as Record<string, unknown>
    : undefined;

    const semanticValues = semantics?.values;

    for (
        let shellIndex = 0;
        shellIndex < geometry.boundaries.length;
        shellIndex++
    ){
        const shell = geometry.boundaries[shellIndex];

        if(!Array.isArray(shell)) {
            throw new Error(
                "Each Solid shell must contain surfaces"
            );
        }


        const shellValues = 
        Array.isArray(semanticValues)
        ? semanticValues[shellIndex]
        : undefined;


        for (
            let surfaceIndex = 0;
            surfaceIndex < shell.length;
            surfaceIndex++
        ){
            flattenedBoundaries.push(
                shell[surfaceIndex]
            );

            flattenedValues.push(
                Array.isArray(shellValues)
                ? shellValues[surfaceIndex]
                : undefined
            );
        }
    }

    return convertMultiSurface(
        document,
        {
            ...geometry,
            type: "MultiSurface",
            boundaries: flattenedBoundaries,
            semantics: semantics
            ? {
                ...semantics,
                values: flattenedValues
            }
            : undefined
        }
    );
}

