import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";


import type {
    ModelDocument,
    ModelGeometry
} from "./modelTypes";


export async function gltfToModel(
    filename:string,
    content: string | ArrayBuffer | Uint8Array,
    resources: Record<string, string> = {}
): Promise <ModelDocument> {
    const manager = new THREE.LoadingManager();

    manager.setURLModifier((url) => {
        return resources[url]
            ?? resources[decodeURIComponent(url)]
            ?? url;
    });

    const loader = new GLTFLoader(manager);

    const data: string | ArrayBuffer = content instanceof Uint8Array
        ? new Uint8Array(content).slice().buffer
        : content;

    const gltf = await loader.parseAsync(
        data,
        ""
    );

    const positions: number[] = [];
    const indices: number[] = [];

    gltf.scene.updateMatrixWorld(true);

    gltf.scene.traverse((node) => {
        if(!(node instanceof THREE.Mesh)) {
            return;
        }

        const geometry = node.geometry;
        const positionAttribute = geometry.getAttribute("position");

        if (!positionAttribute) {
            return;
        }

        const vertexOffset = positions.length / 3;

        const vertex = new THREE.Vector3();

        for(let index = 0; index < positionAttribute.count; index++){
            vertex.fromBufferAttribute(
                positionAttribute,
                index
            );

            vertex.applyMatrix4(node.matrixWorld);

            positions.push(
                vertex.x,
                vertex.y,
                vertex.z
            );
        }


        if(geometry.index) {
            for(
                let index = 0;
                index < geometry.index.count;
                index++
            ){
                indices.push(
                    geometry.index.getX(index) + vertexOffset
                );
            }
        } else {
            for (
                let index = 0;
                index < positionAttribute.count;
                index++
            ){
                indices.push(index + vertexOffset);
            }
        }
    });

    const geometry: ModelGeometry = {
        type: "mesh",
        positions,
        indices
    };

    return {
        format: "gltf",
        filename,
        metadata: {},
        availableLods: [],
        objects: [
            {
                id: filename,
                type: "glTFModel",
                attributes: {},
                children: [],
                geometries: [geometry]
            }
        ]
    };
}
