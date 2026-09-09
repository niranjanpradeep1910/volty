import * as THREE from "three";
import { PLYLoader } from "three/examples/jsm/loaders/PLYLoader.js";

import type {
    ModelDocument,
    ModelGeometry
} from "./modelTypes";


export function plyToModel(
    filename: string,
    content: string | ArrayBuffer | Uint8Array
): ModelDocument {
    const loader = new PLYLoader();

    const data: string | ArrayBuffer = 
    content instanceof Uint8Array
    ? new Uint8Array(content).slice().buffer
    : content;

    const parsedGeometry = loader.parse(data);

    const positionAttribute = parsedGeometry.getAttribute("position");

    if(!positionAttribute) {
        throw new Error("PLY file has no vertex positions.");
    }

    const positions: number[] = [];

    for(
        let index = 0;
        index < positionAttribute.count;
        index++
    ){
        positions.push(
            positionAttribute.getX(index),
            positionAttribute.getY(index),
            positionAttribute.getZ(index)
        );
    }


    const colors: number[] = [];
    const colorAttribute = parsedGeometry.getAttribute("color");

    if(colorAttribute){
        for(
            let index = 0;
            index < colorAttribute.count;
            index++
        ){
            colors.push(
                colorAttribute.getX(index),
                colorAttribute.getY(index),
                colorAttribute.getZ(index)
            );
        }
    }


    const geometry: ModelGeometry = {
        type: "points",
        positions,
        indices: [],
        elevationAxis: 2,
        colors: colors.length > 0
        ? colors: undefined,
        attributes: colors.length > 0
        ? {
            color: {
                type: "color",
                values: colors
            }
        }
        : {}
    };

    return {
        format: "ply",
        filename,
        metadata: {},
        availableLods: [],
        objects: [
            {
                id: filename,
                type: "PLYPointCloud",
                attributes: {},
                children: [],
                geometries: [geometry]
            }
        ]
    };
}
