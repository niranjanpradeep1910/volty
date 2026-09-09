import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { objToModel } from "../model/objToModel";
import {
    cityJsonToModel
} from "../model/cityJsonToModel";
import { gltfToModel } from "../model/gltfToModel";
import { plyToModel } from "../model/plyToModel";
import {
    calculateMeshStatistics
} from "../model/modelStatistics";


import type {
    ModelGeometry,
    ModelDocument,
    ModelMaterialGroup,
    ModelStatistics,
    PointAttribute,
    ValidationReport
} from "../model/modelTypes";


function updateValidationPanel(
    report: ValidationReport | undefined
): void {
    const summary = document.getElementById(
        "validation-summary"
    );

    const issueList = document.getElementById(
        "validation-issues"
    );

    if (!summary || !issueList){
        return;
    }


    issueList.innerHTML = "";

    if(!report || report.issues.length === 0){
        summary.textContent = "No conversion issues";
        return;
    }

    summary.textContent = 
        `${report.issues.length} issue(s) found`;

    for (const issue of report.issues) {
        const item = document.createElement("li");

        const location = [
            issue.objectId,
            issue.geometryType,
            issue.lod
                ?`LoD ${issue.lod}`
                : undefined
        ]

            .filter(Boolean)
            .join(" - ");

        item.textContent = location
        ?  `${location}: ${issue.message}`
        : issue.message;

        issueList.appendChild(item);
    }
}

function updateStatisticsPanel(
    statistics: ModelStatistics
): void {
    const objectDetail = document.getElementById("detail-objects");
    const verticesDetail = document.getElementById("detail-vertices");
    const trianglesDetail = document.getElementById("detail-triangles");
    const pointsDetail = document.getElementById("detail-points");
    const selectedLodDetail = document.getElementById("detail-selected-lod");
    const semanticsDetail = document.getElementById("detail-semantics");

    if (objectDetail) {
        objectDetail.textContent = String(statistics.objectCount);
    }

    if (verticesDetail) {
        verticesDetail.textContent = statistics.vertexCount === undefined
            ? "Not available"
            : String(statistics.vertexCount);
    }

    if (trianglesDetail) {
        trianglesDetail.textContent = statistics.triangleCount === undefined
            ? "Not available"
            : String(statistics.triangleCount);
    }

    if (pointsDetail) {
        pointsDetail.textContent = statistics.pointCount === undefined
            ? "Not applicable"
            : String(statistics.pointCount);
    }

    if (selectedLodDetail) {
        selectedLodDetail.textContent = statistics.selectedLod ?? "Not applicable";
    }

    if (semanticsDetail) {
        const semanticEntries = Object.entries(
            statistics.semanticSurfaceCounts ?? {}
        );

        semanticsDetail.textContent = "";

        if (semanticEntries.length === 0) {
            semanticsDetail.textContent = "Not applicable";
        } else {
            for (const [semantic, count] of semanticEntries) {
                const line = document.createElement("span");
                const swatch = document.createElement("span");
                const color = semanticColors[semantic] ?? 0x6699CC;

                line.textContent = `${semantic}: ${count}`;
                line.style.display = "flex";
                line.style.alignItems = "center";
                line.style.gap = "7px";

                swatch.className = "semantic-swatch";
                swatch.style.backgroundColor = `#${color
                    .toString(16)
                    .padStart(6, "0")}`;

                line.prepend(swatch);
                semanticsDetail.appendChild(line);
            }
        }
    }
}

function disableLodSelector(): void {
    const lodSelect = document.getElementById(
        "lod-select"
    ) as HTMLSelectElement | null;

    if (!lodSelect) {
        return;
    }

    lodSelect.innerHTML = "";

    const option = document.createElement("option");
    option.textContent = "No LoD available";
    option.value = "";
    lodSelect.appendChild(option);
    lodSelect.disabled = true;
}

function setPointControlsVisible(visible: boolean): void {
    const pointControls = document.getElementById("point-controls");

    if (pointControls) {
        pointControls.style.display = visible ? "flex" : "none";
    }
}

function setDetailVisible(
    detailId: string,
    visible: boolean
): void {
    const detail = document.getElementById(detailId);
    const label = detail?.previousElementSibling as HTMLElement | null;

    if (detail) {
        detail.style.display = visible ? "" : "none";
    }

    if (label) {
        label.style.display = visible ? "" : "none";
    }
}

function setPropertiesForFormat(
    format: "cityjson" | "mesh" | "points" | "none"
): void {
    const isCityJson = format === "cityjson";
    const isPoints = format === "points";
    const hasMesh = format === "mesh" || isCityJson;
    const validationPanel = document.getElementById("validation-panel");
    const lodControl = document.getElementById("lod-control");

    if (validationPanel) {
        validationPanel.style.display = isCityJson ? "" : "none";
    }

    if (lodControl) {
        lodControl.style.display = isCityJson ? "" : "none";
    }

    setDetailVisible("detail-objects", format !== "none");
    setDetailVisible("detail-vertices", hasMesh);
    setDetailVisible("detail-points", isPoints);
    setDetailVisible("detail-triangles", hasMesh);
    setDetailVisible("detail-lods", isCityJson);
    setDetailVisible("detail-selected-lod", isCityJson);
    setDetailVisible("detail-semantics", isCityJson);
    setDetailVisible("detail-attributes", false);
}


declare function acquireVsCodeApi(): {
    postMessage(message: unknown): void;
};

const vscodeApi = acquireVsCodeApi();

const container = document.getElementById("viewer");




if(!container){
    throw new Error("Viewer container was not found");
}

const viewer = container;

const scene = new THREE.Scene();

scene.background = new THREE.Color(0xF7F4ED);

let currentModel: THREE.Object3D | undefined; 

let currentCityDocument: ModelDocument | undefined;
let selectedLod: string | undefined;

let placeholderActive = true;

let currentEdges: THREE.LineSegments | undefined;
let currentMaterials: THREE.MeshStandardMaterial[] = [];
let currentUsesSemanticMaterials = false;
let currentPointMaterial: THREE.PointsMaterial | undefined;
let currentPointGeometry: THREE.BufferGeometry | undefined;
let currentPointRgbColors: number[] | undefined;
let currentPointAttributes:
    Record<string, PointAttribute> = {};
let currentPointSource: ModelGeometry | undefined;
let currentPointSourceCount: number | undefined;
let visibleClassifications = new Set<string>();
let currentPointElevationRange: [number, number] | undefined;

function removeAndDisposeCurrentModel(): void {
    if (!currentModel) {
        return;
    }

    scene.remove(currentModel);
    currentModel.traverse((object) => {
        if (
            object instanceof THREE.Mesh ||
            object instanceof THREE.Points ||
            object instanceof THREE.LineSegments
        ) {
            object.geometry.dispose();
            const materials = Array.isArray(object.material)
                ? object.material
                : [object.material];

            for (const material of materials) {
                material.dispose();
            }
        }
    });
}

interface ViewerSettings {
    showGrid: boolean;
    showAxes: boolean;
    showEdges: boolean;
    surfaceColor: string;
    pointSize: number;
    pointLimit: number;
    pointColorMode: PointColorMode;
    colorRamp: ColorRampName;
}

type PointColorMode = string;

type ColorRampName = 
| "viridis"
| "turbo"
| "grayscale"
| "terrain";

const settings: ViewerSettings = {
    showGrid: true,
    showAxes: true,
    showEdges: true,
    surfaceColor: "#6699cc",
    pointSize: 0.04,
    pointLimit: 1_000_000,
    pointColorMode: "rgb",
    colorRamp: "viridis"
};

const semanticColors: Record<string, number> = {
    RoofSurface: 0xE63946,
    WallSurface: 0x6699CC,
    GroundSurface: 0x6A994E
};

const colorRamps: Record<ColorRampName, number[] > = {
    viridis: [
        0x440154,
        0x31688E,
        0x35B779,
        0xFDE725
    ],

    turbo: [
        0x30123B,
        0x466BE3,
        0x1AC7C2,
        0xA4FC3C,
        0xF9D057,
        0xF23B27
    ],

    grayscale: [
        0x111111,
        0x888888,
        0xFFFFFF
    ],

    terrain: [
        0x2E7D32,
        0xA5D66A,
        0xFDD835,
        0x8D6E63,
        0xFFFFFF
    ]
};

const lasClassificationNames: Record<number, string> = {
    0: "Never Classified",
    1: "Unassigned",
    2: "Ground",
    3: "Low Vegetation",
    4: "Medium Vegetation",
    5: "High Vegetation",
    6: "Building",
    7: "Low Point (Noise)",
    8: "Reserved",
    9: "Water",
    10: "Rail",
    11: "Road Surface",
    12: "Reserved",
    13: "Wire - Guard",
    14: "Wire - Conductor",
    15: "Transmission Tower",
    16: "Wire Connector",
    17: "Bridge Deck",
    18: "High Noise"
};

function combineCityJsonGeometry(
    modelDocument: ModelDocument,
    lod: string
): ModelGeometry | undefined {
    const positions: number[] = [];
    const indices: number[] = [];

    const materialGroups: ModelMaterialGroup[] = [];

    for(const object of modelDocument.objects){
        const geometry = object.geometries.find(
            (candidate) =>
                candidate.lod === lod &&
                candidate.positions.length > 0 &&
                candidate.indices.length > 0
        );

        if (!geometry) {
            continue;
        }

        const indexStart = indices.length;

        const vertexOffset = positions.length / 3;
        positions.push(...geometry.positions);

        for(const index of geometry.indices) {
            indices.push(index + vertexOffset);
        }

        for(const group of geometry.materialGroups ?? []){
            materialGroups.push({
                start: indexStart + group.start,
                count: group.count,
                semantic: group.semantic
            });
        }
    }

    if (positions.length === 0 || indices.length === 0) {
        return undefined;
    }

    return {
        type: "mesh",
        positions,
        indices,
        lod,
        materialGroups
    };
}


function renderCityJsonLoD(
    modelDocument: ModelDocument,
    lod: string
) {
    const geometryData = combineCityJsonGeometry(
        modelDocument,
        lod
    );

    if (!geometryData) {
        console.log(`No renderable geometry found for LoD ${lod}`);
        return;
    }


    displayGeometry(geometryData);

    const statistics = calculateMeshStatistics(
        modelDocument,
        geometryData,
        lod
    );

    updateStatisticsPanel(statistics);
}

function createElevationColors(
    positions: number[],
    rampName: ColorRampName,
    elevationAxis: 0 | 1 | 2 = 2
): number[]{
    const colors: number[] = [];
    const ramp = colorRamps[rampName];

    let minimumZ = Infinity;
    let maximumZ = -Infinity;

    for(
        let index = 2;
        index < positions.length;
        index += 3
    ) {
        const elevation = positions[
            index - 2 + elevationAxis
        ];
        minimumZ = Math.min(minimumZ, elevation);

        maximumZ = Math.max(maximumZ, elevation);
    }

    const heightRange = maximumZ - minimumZ;

    for (
        let index = 2;
        index < positions.length;
        index +=3
    ){
        const elevation = positions[
            index - 2 + elevationAxis
        ];
        const normalized = heightRange === 0
        ? 0.5
        : (elevation - minimumZ) / heightRange;

        const scaled = normalized * (ramp.length - 1);

        const lowerIndex = Math.floor(scaled);
        const upperIndex = Math.min(
            lowerIndex + 1,
            ramp.length - 1
        );

        const amount = scaled - lowerIndex;

        const color = new THREE.Color(
            ramp[lowerIndex]
        ).lerp(
            new THREE.Color(ramp[upperIndex]),
            amount
        );

        colors.push(
            color.r,
            color.g,
            color.b
        );
    }
    return colors;
}

function createScalarColors(
    values: number[],
    attribute: PointAttribute,
    rampName: ColorRampName
): number[] {
    let minimum = attribute.min ?? Infinity;
    let maximum = attribute.max ?? -Infinity;

    if (
        attribute.min === undefined ||
        attribute.max === undefined
    ) {
        for (const value of values) {
            minimum = Math.min(minimum, value);
            maximum = Math.max(maximum, value);
        }
    }

    const range = maximum - minimum;

    return values.flatMap((value) => {
        const normalized = range === 0
            ? 0.5
            : (value - minimum) / range;

        const ramp = colorRamps[rampName];
        const scaled = normalized * (ramp.length - 1);
        const lowerIndex = Math.max(0, Math.floor(scaled));
        const upperIndex = Math.min(
            lowerIndex + 1,
            ramp.length - 1
        );
        const amount = scaled - lowerIndex;
        const color = new THREE.Color(ramp[lowerIndex]).lerp(
            new THREE.Color(ramp[upperIndex]),
            amount
        );

        return [color.r, color.g, color.b];
    });
}

function createCategoryColors(
    values: number[] | string[]
): number[] {
    const categories = [...new Set(values.map(String))];

    return values.flatMap((value) => {
        const color = getCategoryColor(
            String(value),
            categories
        );

        return [color.r, color.g, color.b];
    });
}

const pointCategoryPalette = [
        0xE63946,
        0x457B9D,
        0x2A9D8F,
        0xE9C46A,
        0xF4A261,
        0x9B5DE5
];

function getCategoryColor(
    category: string,
    categories: string[]
): THREE.Color {
    const categoryIndex = categories.indexOf(category);

    return new THREE.Color(
        pointCategoryPalette[
            categoryIndex % pointCategoryPalette.length
        ]
    );
}

function updatePointColorModeOptions(
    attributes: Record<string, PointAttribute>
): void {
    if (!pointColorModeSelect) {
        return;
    }

    pointColorModeSelect.innerHTML = "";

    const baseOptions = [
        ["rgb", "RGB"],
        ["elevation", "Elevation"]
    ];

    for (const [value, label] of baseOptions) {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = label;
        pointColorModeSelect.appendChild(option);
    }

    for (const [name] of Object.entries(attributes)) {
        if (name === "color") {
            continue;
        }

        const option = document.createElement("option");
        option.value = `attribute:${name}`;
        option.textContent = {
            returnNumber: "Return number",
            numberOfReturns: "Number of returns"
        }[name] ?? name;
        pointColorModeSelect.appendChild(option);
    }

    pointColorModeSelect.value = settings.pointColorMode;
}

function updateClassificationControls(
    mode: PointColorMode
): void {
    const controls = document.getElementById(
        "classification-controls"
    );

    if (!controls) {
        return;
    }

    controls.innerHTML = "";

    if (
        mode !== "attribute:classification" ||
        !currentPointSource
    ) {
        controls.style.display = "none";
        return;
    }

    const attribute =
        currentPointSource.attributes?.classification;

    if (!attribute) {
        controls.style.display = "none";
        return;
    }

    controls.style.display = "flex";

    const categories = [
        ...new Set(attribute.values.map(String))
    ].sort((left, right) =>
        Number(left) - Number(right)
    );

    for (const category of categories) {
        const label = document.createElement("label");
        const checkbox = document.createElement("input");
        const swatch = document.createElement("span");

        checkbox.type = "checkbox";
        checkbox.checked = visibleClassifications.has(category);

        checkbox.addEventListener("change", () => {
            if (checkbox.checked) {
                visibleClassifications.add(category);
            } else {
                visibleClassifications.delete(category);
            }

            if (currentPointSource) {
                displayPointGeometry(currentPointSource);
            }
        });

        swatch.className = "point-color-legend-swatch";
        swatch.style.backgroundColor =
            `#${getCategoryColor(category, categories).getHexString()}`;

        label.appendChild(checkbox);
        label.appendChild(swatch);
        label.appendChild(
            document.createTextNode(
                `${category} - ${lasClassificationNames[Number(category)] ?? "Unknown"}`
            )
        );
        controls.appendChild(label);
    }
}

function filterPointGeometry(
    source: ModelGeometry
): ModelGeometry {
    if (
        source.type !== "points" ||
        settings.pointColorMode !== "attribute:classification"
    ) {
        return limitPointGeometry(source);
    }

    const classification =
        source.attributes?.classification;

    if (!classification) {
        return limitPointGeometry(source);
    }

    const positions: number[] = [];
    const colors: number[] = [];
    const visiblePointIndices: number[] = [];

    for (
        let pointIndex = 0;
        pointIndex < classification.values.length;
        pointIndex++
    ) {
        if (
            visibleClassifications.has(
                String(classification.values[pointIndex])
            )
        ) {
            visiblePointIndices.push(pointIndex);
        }
    }

    for (const pointIndex of visiblePointIndices) {
        positions.push(
            source.positions[pointIndex * 3],
            source.positions[pointIndex * 3 + 1],
            source.positions[pointIndex * 3 + 2]
        );

        if (source.colors) {
            colors.push(
                source.colors[pointIndex * 3],
                source.colors[pointIndex * 3 + 1],
                source.colors[pointIndex * 3 + 2]
            );
        }
    }

    const attributes: Record<string, PointAttribute> = {};

    for (const [name, attribute] of Object.entries(
        source.attributes ?? {}
    )) {
        attributes[name] = {
            ...attribute,
            values: visiblePointIndices.map(
                (pointIndex) => attribute.values[pointIndex]
            ) as number[] | string[]
        };
    }

    return limitPointGeometry({
        ...source,
        positions,
        colors: source.colors ? colors : undefined,
        attributes
    });
}

function limitPointGeometry(source: ModelGeometry): ModelGeometry {
    if (source.type !== "points") {
        return source;
    }

    const sourceCount = source.positions.length / 3;
    const displayCount = Math.min(settings.pointLimit, sourceCount);

    if (displayCount === sourceCount) {
        return source;
    }

    const positions: number[] = [];
    const colors: number[] = [];
    const pointIndices: number[] = [];

    for (let index = 0; index < displayCount; index++) {
        const pointIndex = Math.floor(index * sourceCount / displayCount);
        pointIndices.push(pointIndex);
        positions.push(
            source.positions[pointIndex * 3],
            source.positions[pointIndex * 3 + 1],
            source.positions[pointIndex * 3 + 2]
        );

        if (source.colors) {
            colors.push(
                source.colors[pointIndex * 3],
                source.colors[pointIndex * 3 + 1],
                source.colors[pointIndex * 3 + 2]
            );
        }
    }

    const attributes: Record<string, PointAttribute> = {};
    for (const [name, attribute] of Object.entries(source.attributes ?? {})) {
        attributes[name] = {
            ...attribute,
            values: pointIndices.map(
                (pointIndex) => attribute.values[pointIndex]
            ) as number[] | string[]
        };
    }

    return {
        ...source,
        positions,
        colors: source.colors ? colors : undefined,
        attributes
    };
}

function createAttributeColors(
    mode: string
): number[] {
    const attributeName = mode.replace(
        "attribute:",
        ""
    );
    const attribute = currentPointAttributes[attributeName];

    if (!attribute) {
        return createElevationColors(
            Array.from(
                currentPointGeometry!.getAttribute("position").array
            ) as number[],
            settings.colorRamp,
            currentPointSource?.elevationAxis ?? 2
        );
    }

    if (attribute.type === "category") {
        return createCategoryColors(attribute.values);
    }

    if (
        !attribute.values.every(
            (value): value is number => typeof value === "number"
        )
    ) {
        return createCategoryColors(attribute.values);
    }

    return createScalarColors(
        attribute.values,
        attribute,
        settings.colorRamp
    );
}

function updatePointColorLegend(
    mode: PointColorMode
): void {
    const legend = document.getElementById(
        "point-color-legend"
    );
    const bar = document.getElementById(
        "point-color-legend-bar"
    );
    const minimumLabel = document.getElementById(
        "point-color-legend-min"
    );
    const maximumLabel = document.getElementById(
        "point-color-legend-max"
    );
    const categoryItems = document.getElementById(
        "point-color-legend-items"
    );

    if (!legend || !bar || !categoryItems) {
        return;
    }

    if (!currentPointGeometry) {
        legend.style.display = "none";
        return;
    }

    categoryItems.innerHTML = "";

    if (mode.startsWith("attribute:")) {
        const attributeName = mode.replace("attribute:", "");
        const attribute = currentPointAttributes[attributeName];

        if (attribute?.type === "category") {
            if (attributeName === "classification") {
                legend.style.display = "none";
                return;
            }

            const categories = [
                ...new Set(attribute.values.map(String))
            ].sort((left, right) =>
                Number(left) - Number(right)
            );

            for (const category of categories) {
                const item = document.createElement("div");
                item.className = "point-color-legend-item";

                const swatch = document.createElement("span");
                swatch.className = "point-color-legend-swatch";
                swatch.style.backgroundColor =
                    `#${getCategoryColor(category, categories)
                        .getHexString()}`;

                const label = document.createElement("span");
                const description =
                    attributeName === "classification"
                        ? ` - ${lasClassificationNames[Number(category)] ?? "Unknown"}`
                        : "";
                label.textContent = `${category}${description}`;

                item.appendChild(swatch);
                item.appendChild(label);
                categoryItems.appendChild(item);
            }

            bar.style.display = "none";
            if (minimumLabel) {
                minimumLabel.style.display = "none";
            }
            if (maximumLabel) {
                maximumLabel.style.display = "none";
            }

            categoryItems.style.display = "flex";
            legend.style.display = "flex";
            return;
        }
    }

    bar.style.display = "block";
    if (minimumLabel) {
        minimumLabel.style.display = "inline";
    }
    if (maximumLabel) {
        maximumLabel.style.display = "inline";
    }
    categoryItems.style.display = "none";

    let minimum: number;
    let maximum: number;

    if (mode === "elevation") {
        if (currentPointElevationRange) {
            minimum = currentPointElevationRange[0];
            maximum = currentPointElevationRange[1];
        } else {
        const positions = Array.from(
            currentPointGeometry.getAttribute("position").array
        ) as number[];
        const elevationAxis =
            currentPointSource?.elevationAxis ?? 2;
        minimum = Infinity;
        maximum = -Infinity;
        for (let index = 2; index < positions.length; index += 3) {
            const elevation = positions[
                index - 2 + elevationAxis
            ];
            minimum = Math.min(minimum, elevation);
            maximum = Math.max(maximum, elevation);
        }
        }
    } else if (mode.startsWith("attribute:")) {
        const attribute = currentPointAttributes[
            mode.replace("attribute:", "")
        ];

        if (
            !attribute ||
            attribute.type !== "scalar" ||
            !attribute.values.every(
                (value): value is number => typeof value === "number"
            )
        ) {
            legend.style.display = "none";
            return;
        }

        minimum = attribute.min ?? Infinity;
        maximum = attribute.max ?? -Infinity;

        if (
            attribute.min === undefined ||
            attribute.max === undefined
        ) {
            for (const value of attribute.values) {
                if (typeof value !== "number") {
                    continue;
                }

                minimum = Math.min(minimum, value);
                maximum = Math.max(maximum, value);
            }
        }
    } else {
        legend.style.display = "none";
        return;
    }

    const ramp = colorRamps[settings.colorRamp];
    const rampColors = ramp.map(
        (color) => `#${color.toString(16).padStart(6, "0")}`
    );

    bar.style.background =
        `linear-gradient(to right, ${rampColors.join(", ")})`;

    if (minimumLabel) {
        minimumLabel.textContent = minimum.toFixed(2);
    }

    if (maximumLabel) {
        maximumLabel.textContent = maximum.toFixed(2);
    }

    legend.style.display = "flex";
}

function applyPointColorMode(
    mode: PointColorMode
): void {
    if (
        !currentPointGeometry ||
        !currentPointMaterial
    ){
        return;
    }

    const positionAttribute = 
        currentPointGeometry.getAttribute(
            "position"
        );

    const positions = Array.from(
        positionAttribute.array
    );

    const colors = mode === "rgb" && currentPointRgbColors
        ? currentPointRgbColors
        : mode === "elevation"
            ? createElevationColors(
                positions,
                settings.colorRamp,
                currentPointSource?.elevationAxis ?? 2
            )
            : createAttributeColors(mode);

    currentPointGeometry.setAttribute(
        "color",
        new THREE.Float32BufferAttribute(
            colors,
            3
        )
    );

    currentPointMaterial.vertexColors = true;
    currentPointMaterial.color.set(0xffffff);
    currentPointMaterial.needsUpdate = true;

    updatePointColorLegend(mode);
}





function displayPointGeometry(
    geometryData: ModelGeometry
): void {
    if (
        geometryData.type === "points" &&
        currentPointSource !== geometryData
    ) {
        currentPointSource = geometryData;
        currentPointSourceCount =
            geometryData.source?.pointCount ??
            geometryData.positions.length / 3;
        visibleClassifications = new Set(
            geometryData.attributes?.classification?.values
                .map(String) ?? []
        );
    }

    const filteredGeometry = filterPointGeometry(geometryData);

    if (
        filteredGeometry.type === "points" &&
        filteredGeometry.positions.length === 0
    ) {
        removeAndDisposeCurrentModel();

        currentModel = undefined;
        updateClassificationControls(
            settings.pointColorMode
        );
        return;
    }

    renderPointGeometry(filteredGeometry);
    updatePointCountDetail(
        filteredGeometry.positions.length / 3,
        currentPointSourceCount
    );
    updateClassificationControls(
        settings.pointColorMode
    );
}

function updatePointCountDetail(
    displayedCount: number,
    sourceCount = displayedCount
): void {
    const pointsDetail = document.getElementById("detail-points");

    if (pointsDetail) {
        pointsDetail.textContent =
            `${displayedCount.toLocaleString()} of ` +
            `${sourceCount.toLocaleString()} (preview)`;
    }
}

function renderPointGeometry(
    geometryData: ModelGeometry
): void {
    if (
        geometryData.type !== "points" ||
        geometryData.positions.length === 0
    ) {
        console.log("Point cloud has no renderable data");
        return;
    }

    setPointControlsVisible(true);

    const emptyState = document.getElementById("empty-state");
    if (emptyState) {
        emptyState.style.display = "none";
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
        "position",
        new THREE.Float32BufferAttribute(
            geometryData.positions,
            3
        )
    );

    const colors = geometryData.colors;
    const hasColors =
        colors !== undefined &&
        colors.length === geometryData.positions.length;

    

    const material = new THREE.PointsMaterial({
        color: 0xffffff,
        size: settings.pointSize,
        vertexColors: true
    });

    const points = new THREE.Points(geometry, material);

    removeAndDisposeCurrentModel();

    currentModel = points;
    currentEdges = undefined;
    currentMaterials = [];
    currentUsesSemanticMaterials = false;
    currentPointMaterial = material;

    currentPointGeometry = geometry;
    currentPointRgbColors = hasColors
        ? colors
        : undefined;
    currentPointAttributes = geometryData.attributes ?? {};

    updatePointColorModeOptions(
        currentPointAttributes
    );

    if (
        settings.pointColorMode === "rgb" &&
        !hasColors
    ) {
        settings.pointColorMode = "elevation";
    }

    applyPointColorMode(
        settings.pointColorMode
    );



    scene.add(points);
    fitObject(points);

    cube.visible = false;
    placeholderActive = false;
}

function displayGeometry(
    geometryData: ModelGeometry
) {
    if (geometryData.type === "points") {
        displayPointGeometry(geometryData);
        return;
    }

    setPointControlsVisible(false);

    if (
        geometryData.positions.length === 0 ||
        geometryData.indices.length === 0
    ) {
        console.log("Geometry has no renderable data");
        return;
    }

    const emptyState = document.getElementById("empty-state");
    if (emptyState) {
        emptyState.style.display = "none";
    }

    const geometry = new THREE.BufferGeometry();

    geometry.setAttribute(
        "position",
        new THREE.Float32BufferAttribute(
            geometryData.positions,
            3
        )
    );

    geometry.setIndex(geometryData.indices);
    geometry.computeVertexNormals();

    const semanticNames = [
        ...new Set(
            (geometryData.materialGroups ?? [])
                .map((group) => group.semantic)
                .filter(
                    (semantic): semantic is string =>
                        semantic !== undefined
                )
        )
    ];

    console.log(
    "Semantic groups:",
    geometryData.materialGroups);

    const materials = semanticNames.map(
        (semantic) =>
            new THREE.MeshStandardMaterial({
                color: semanticColors[semantic] ?? settings.surfaceColor,
                side: THREE.FrontSide
            })
    );

    const fallbackMaterial = new THREE.MeshStandardMaterial({
        color: settings.surfaceColor,
        side: THREE.FrontSide
    });

    const renderMaterials = [
        ...materials,
        fallbackMaterial
    ];

    geometry.clearGroups();

    for (const group of geometryData.materialGroups ?? []) {
        const materialIndex = group.semantic
            ? semanticNames.indexOf(group.semantic)
            : materials.length;

        geometry.addGroup(
            group.start,
            group.count,
            materialIndex >= 0
                ? materialIndex
                : materials.length
        );
    }

    const material =
        renderMaterials.length === 1
            ? renderMaterials[0]
            : renderMaterials;

    const model = new THREE.Mesh(
        geometry,
        material
    );

    const edgeGeometry = new THREE.EdgesGeometry(
        geometry,
        15
    );

    const edgeMaterial = new THREE.LineBasicMaterial({
        color: 0x222222
    });

    const edges = new THREE.LineSegments(
        edgeGeometry,
        edgeMaterial
    );
    edges.visible = settings.showEdges;

    const modelGroup = new THREE.Group();
    
    modelGroup.add(model);
    modelGroup.add(edges);

    removeAndDisposeCurrentModel();

    currentModel = modelGroup;
    currentEdges = edges;
    currentMaterials = renderMaterials;
    currentUsesSemanticMaterials = semanticNames.length > 0;
    currentPointRgbColors = undefined;
    currentPointGeometry = undefined;
    currentPointMaterial = undefined;
    currentPointAttributes = {};
    currentPointSource = undefined;
    currentPointSourceCount = undefined;
    currentPointElevationRange = undefined;
    visibleClassifications.clear();

    scene.add(modelGroup);

    fitObject(modelGroup);

    cube.visible = false;
    placeholderActive = false;
}


const camera = new THREE.PerspectiveCamera(
    60,
    container.clientWidth / container.clientHeight,
    0.1,
    1000
);

camera.position.set(3, 3, 5);

const renderer = new THREE.WebGLRenderer({
    antialias:true
});

renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(
    container.clientWidth,
    container.clientHeight,
);

container.appendChild(renderer.domElement);

const controls = new OrbitControls(
    camera,
    renderer.domElement
);

controls.target.set(0, 0, 0);
controls.update();

const ambientLight = new THREE.AmbientLight(
    0xffffff,
    2
);

scene.add(ambientLight);

const directionalLight = new THREE.DirectionalLight(
    0xffffff,
    3
);


directionalLight.position.set(5, 5, 5);
scene.add(directionalLight);

const grid = new THREE.GridHelper(10, 10);
scene.add(grid);

const axes = new THREE.AxesHelper(3);
scene.add(axes);

function deactivateSceneHelpers(): void {
    settings.showGrid = false;
    settings.showAxes = false;
    settings.showEdges = false;

    grid.visible = false;
    axes.visible = false;
    if (currentEdges) {
        currentEdges.visible = false;
    }

    gridButton?.setAttribute("aria-pressed", "false");
    axesButton?.setAttribute("aria-pressed", "false");
    edgesButton?.setAttribute("aria-pressed", "false");
}

const cubeGeometry = new THREE.BoxGeometry(1, 1, 1);

const cubeMaterial = new THREE.MeshStandardMaterial({
    color: 0x44aa88,
});

const cube = new THREE.Mesh(
    cubeGeometry,
    cubeMaterial,
);

scene.add(cube);

vscodeApi.postMessage({
    type: "ready"
});

function getNumericRange(values: number[]): [number, number] {
    let minimum = Infinity;
    let maximum = -Infinity;

    for (const value of values) {
        minimum = Math.min(minimum, value);
        maximum = Math.max(maximum, value);
    }

    return [minimum, maximum];
}

function displayPointCloudPreview(message: {
    fileName: string;
    format: "las" | "laz" | "copc";
    positions: ArrayBuffer;
    intensity: ArrayBuffer;
    classification: ArrayBuffer;
    returnNumber: ArrayBuffer;
    numberOfReturns: ArrayBuffer;
    pointCount: number;
    sourcePointCount: number;
    elevationRange: [number, number];
    availableAttributes: string[];
}): void {
    deactivateSceneHelpers();

    const intensity = Array.from(new Uint16Array(message.intensity));
    const classification = Array.from(
        new Uint8Array(message.classification)
    );
    const returnNumber = Array.from(
        new Uint8Array(message.returnNumber)
    );
    const numberOfReturns = Array.from(
        new Uint8Array(message.numberOfReturns)
    );

    const geometryData: ModelGeometry = {
        type: "points",
        positions: Array.from(new Float32Array(message.positions)),
        indices: [],
        elevationAxis: 1,
        attributes: {
            intensity: {
                type: "scalar",
                values: intensity,
                ...rangeToObject(getNumericRange(intensity))
            },
            returnNumber: {
                type: "scalar",
                values: returnNumber,
                ...rangeToObject(getNumericRange(returnNumber))
            },
            numberOfReturns: {
                type: "scalar",
                values: numberOfReturns,
                ...rangeToObject(getNumericRange(numberOfReturns))
            },
            classification: {
                type: "category",
                values: classification
            }
        },
        source: {
            format: message.format,
            pointCount: message.sourcePointCount
        }
    };

    setPropertiesForFormat("points");
    setDetailVisible("detail-attributes", true);
    currentCityDocument = undefined;
    selectedLod = undefined;
    disableLodSelector();
    updateValidationPanel(undefined);
    currentPointElevationRange = message.elevationRange;
    displayGeometry(geometryData);
    updateStatisticsPanel({
        format: message.format,
        objectCount: 1,
        pointCount: message.pointCount
    });
    updatePointCountDetail(
        message.pointCount,
        message.sourcePointCount
    );

    const fileDetail = document.getElementById("detail-file");
    const formatDetail = document.getElementById("detail-format");
    const lodsDetail = document.getElementById("detail-lods");

    if (fileDetail) {
        fileDetail.textContent = message.fileName;
    }
    if (formatDetail) {
        formatDetail.textContent = `${message.format} preview`;
    }
    if (lodsDetail) {
        lodsDetail.textContent = "Not applicable";
    }

    const attributesDetail = document.getElementById("detail-attributes");
    if (attributesDetail) {
        attributesDetail.textContent = message.availableAttributes.join(", ");
    }

    console.log(
        `Displaying ${message.pointCount.toLocaleString()} of ` +
        `${message.sourcePointCount.toLocaleString()} source points`
    );
}

function rangeToObject(
    range: [number, number]
): Pick<PointAttribute, "min" | "max"> {
    return { min: range[0], max: range[1] };
}

function showModelLoading(
    fileName: string,
    format: string
): void {
    const lowerFormat = format.toLowerCase();
    const propertiesFormat =
        lowerFormat === "las" ||
        lowerFormat === "laz" ||
        lowerFormat === "copc" ||
        lowerFormat === "ply"
            ? "points"
            : lowerFormat === "json"
                ? "cityjson"
                : "mesh";

    setPropertiesForFormat(propertiesFormat);
    setDetailVisible(
        "detail-attributes",
        lowerFormat === "las" ||
        lowerFormat === "laz" ||
        lowerFormat === "copc"
    );
    setPointControlsVisible(false);
    currentCityDocument = undefined;
    selectedLod = undefined;
    disableLodSelector();
    updateValidationPanel(undefined);

    const details: Array<[string, string]> = [
        ["detail-file", fileName],
        ["detail-format", lowerFormat],
        ["detail-objects", "Loading…"],
        ["detail-points", "Loading preview…"],
        ["detail-vertices", "Loading…"],
        ["detail-triangles", "Loading…"],
        ["detail-lods", "Loading…"],
        ["detail-selected-lod", "Loading…"],
        ["detail-semantics", "Loading…"],
        ["detail-attributes", "Loading…"]
    ];

    for (const [detailId, text] of details) {
        const detail = document.getElementById(detailId);
        if (detail) {
            detail.textContent = text;
        }
    }
}

window.addEventListener("message", async (event) => {
    const message = event.data;

    if (
        message.type !== "modelLoading" &&
        message.type !== "modelLoaded" &&
        message.type !== "pointCloudPreviewLoaded"
    ){
        return;
    }

    if (message.type === "modelLoading") {
        showModelLoading(message.fileName, message.format);
        return;
    }

    console.log("Model received:", message.fileName);

    if (message.type === "pointCloudPreviewLoaded") {
        displayPointCloudPreview(message);
        return;
    }

    const fileName = message.fileName.toLowerCase();
    if(fileName.endsWith(".json")){
        deactivateSceneHelpers();
        setPropertiesForFormat("cityjson");
        let cityDocument: ModelDocument;

        try {
            cityDocument = cityJsonToModel(
                message.fileName,
                message.content
            );

            updateValidationPanel(
                cityDocument.validation
            );

        } catch (error) {
            console.error(
                "CityJSON conversion failed:",
                error
            );

            return;
        }

        console.log( "Available LoDs:", cityDocument.availableLods);

        for (const object of cityDocument.objects){
            for (const geometry of object.geometries) {
                console.log(object.id, geometry.lod, 
                    "vertices:", geometry.positions.length /3,
                    "triangles:",geometry.indices.length / 3
                );
            }
        }

        const fileDetail = document.getElementById("detail-file");
        const formatDetail = document.getElementById("detail-format");
        const objectsDetail = document.getElementById("detail-objects");
        const verticesDetail = document.getElementById("detail-vertices");
        const lodsDetail = document.getElementById("detail-lods");
        const lodSelect = document.getElementById("lod-select") as HTMLSelectElement | null;
        
        function updateLodSelector(
            lods:string[],
            activeLod: string
        ){
            if(!lodSelect){
                return;
            }

            lodSelect.innerHTML = "";

            for (const lod of lods) {
                const option = document.createElement(
                    "option"
                );

                option.value = lod;
                option.textContent = `LoD ${lod}`;
                option.selected = lod === activeLod;

                lodSelect.appendChild(option);
            }

            lodSelect.disabled = lods.length === 0;
        }

        lodSelect?.addEventListener("change", () => {
            if(
                !currentCityDocument ||
                !lodSelect.value
            ) {
                return;
            }

            selectedLod = lodSelect.value;

            renderCityJsonLoD(
                currentCityDocument,
                selectedLod
            );
        });



        if (fileDetail) {
            fileDetail.textContent = cityDocument.filename;
        }

        if (formatDetail) {
            formatDetail.textContent = cityDocument.format;
        }

        if (objectsDetail) {
            objectsDetail.textContent = String(
                cityDocument.objects.length
            );
        }

        if (lodsDetail) {
            lodsDetail.textContent =
                cityDocument.availableLods.join(", ") || "None";
        }

        console.log(
            "CityJSON objects:",
            cityDocument.objects.length
        );

        console.log(
            "Available LoDs:",
            cityDocument.availableLods
        );

        const defaultLod = 
        cityDocument.availableLods[
            cityDocument.availableLods.length - 1
        ];

        if(!defaultLod){
            console.log("CityJSON contains no LoDs");
            return;
        }

        currentCityDocument = cityDocument;
        selectedLod = defaultLod;

        updateLodSelector(
            cityDocument.availableLods,
            defaultLod
        );

        renderCityJsonLoD(
            cityDocument,
            defaultLod
        );
        console.log("Selected LoD:", selectedLod);
        return;
    }

    if (fileName.endsWith(".ply")) {
        deactivateSceneHelpers();
        setPropertiesForFormat("points");
        currentCityDocument = undefined;
        selectedLod = undefined;
        disableLodSelector();
        updateValidationPanel(undefined);

        try {
            const modelDocument = plyToModel(
                message.fileName,
                message.content
            );
            const geometryData =
                modelDocument.objects[0].geometries[0];

            displayGeometry(geometryData);
            updateStatisticsPanel(
                calculateMeshStatistics(
                    modelDocument,
                    geometryData
                )
            );

            const fileDetail = document.getElementById("detail-file");
            const formatDetail = document.getElementById("detail-format");
            const lodsDetail = document.getElementById("detail-lods");

            if (fileDetail) {
                fileDetail.textContent = modelDocument.filename;
            }

            if (formatDetail) {
                formatDetail.textContent = modelDocument.format;
            }

            if (lodsDetail) {
                lodsDetail.textContent = "Not applicable";
            }
        } catch (error) {
            console.error("PLY conversion failed:", error);
        }

        return;
    }

    const isGltf =
        fileName.endsWith(".gltf") ||
        fileName.endsWith(".glb");

    if (isGltf) {
        setPropertiesForFormat("mesh");
        currentCityDocument = undefined;
        selectedLod = undefined;
        disableLodSelector();

        try {
            const modelDocument = await gltfToModel(
                message.fileName,
                message.content,
                message.resources ?? {}
            );

            const geometryData =
                modelDocument.objects[0].geometries[0];

            displayGeometry(geometryData);
            updateStatisticsPanel(
                calculateMeshStatistics(
                    modelDocument,
                    geometryData
                )
            );

            const fileDetail = document.getElementById("detail-file");
            const formatDetail = document.getElementById("detail-format");
            const lodsDetail = document.getElementById("detail-lods");

            if (fileDetail) {
                fileDetail.textContent = modelDocument.filename;
            }

            if (formatDetail) {
                formatDetail.textContent = modelDocument.format;
            }

            if (lodsDetail) {
                lodsDetail.textContent = "Not applicable";
            }
        } catch (error) {
            console.error("glTF conversion failed:", error);
        }

        return;
    }

    if (!fileName.endsWith(".obj")) {
        console.log("Unsupported model format");
        return;
    }

    currentCityDocument = undefined;
    selectedLod = undefined;

    disableLodSelector();
    setPropertiesForFormat("mesh");

    const modelDocument = objToModel(
        message.fileName,
        message.content
    );
    const geometryData = modelDocument.objects[0].geometries[0];

    displayGeometry(geometryData);

    const statistics = calculateMeshStatistics(
        modelDocument,
        geometryData
    );

    updateStatisticsPanel(statistics);

    console.log("Vertices:", geometryData.positions.length / 3);
    console.log("Triangles:", geometryData.indices.length / 3);

    const fileDetail = document.getElementById("detail-file");
    const formatDetail = document.getElementById("detail-format");
    const objectsDetail = document.getElementById("detail-objects");
    const verticesDetail = document.getElementById("detail-vertices");
    const trianglesDetail = document.getElementById("detail-triangles");
    const lodsDetail = document.getElementById("detail-lods");

    if (fileDetail) {
        fileDetail.textContent = modelDocument.filename;
    }

    if (formatDetail) {
        formatDetail.textContent = modelDocument.format;
    }

    if (objectsDetail) {
        objectsDetail.textContent = String(
            modelDocument.objects.length
        );
    }

    if (verticesDetail) {
        verticesDetail.textContent = String(
            geometryData.positions.length / 3
        );
    }

    if (trianglesDetail) {
        trianglesDetail.textContent = String(
            geometryData.indices.length / 3
        );
    }

    if (lodsDetail) {
        lodsDetail.textContent = "Not applicable";
    }
});

const toolbar = document.getElementById("toolbar");
const toolbarToggle = document.getElementById("toolbar-toggle");

const inspector = document.getElementById("inspector");
const inspectorToggle = document.getElementById("inspector-toggle");

const openModelButton = document.getElementById("open-model");
const gridButton = document.getElementById("toggle-grid");
const axesButton = document.getElementById("toggle-axes");
const edgesButton = document.getElementById("toggle-edges");
const fitViewButton = document.getElementById("fit-view");


const colorInput = document.getElementById(
    "surface-color"
) as HTMLInputElement | null;
const nightModeButton = document.getElementById(
    "toggle-night-mode"
);
const pointSizeInput = document.getElementById(
    "point-size"
) as HTMLInputElement | null;
const pointLimitSelect = document.getElementById(
    "point-limit"
) as HTMLSelectElement | null;
const pointColorModeSelect = document.getElementById(
    "point-color-mode"
) as HTMLSelectElement | null;
const pointColorRampSelect = document.getElementById(
    "point-color-ramp"
) as HTMLSelectElement | null;

setPointControlsVisible(false);
setPropertiesForFormat("none");

toolbarToggle?.addEventListener("click", () => {
    const collapsed = toolbar?.classList.toggle("collapsed") ?? false;

    toolbarToggle.setAttribute(
        "aria-expanded",
        String(!collapsed)
    );

    toolbarToggle.setAttribute(
        "aria-label",
        collapsed
        ? "Expand toolbar"
        : "Collapse toolbar" 
    );
});

inspectorToggle?.addEventListener("click", () => {
    const collapsed = inspector?.classList.toggle("collapsed") ?? false;

    inspectorToggle.setAttribute(
        "aria-expanded",
        String(!collapsed)
    );

    inspectorToggle.setAttribute(
        "aria-label",
        collapsed
        ? "Expand properties"
        : "Collapse properties"
    );
});

openModelButton?.addEventListener("click", () => {
    vscodeApi.postMessage({
        type: "openModel",
        maxPoints: settings.pointLimit
    });
});

gridButton?.addEventListener("click", () => {
    settings.showGrid = !settings.showGrid;
    grid.visible = settings.showGrid;

    gridButton.setAttribute(
        "aria-pressed",
        String(settings.showGrid)
    );
});

axesButton?.addEventListener("click", () => {
    settings.showAxes = !settings.showAxes;
    axes.visible = settings.showAxes;

    axesButton.setAttribute(
        "aria-pressed",
        String(settings.showAxes)
    );
});

edgesButton?.addEventListener("click", () => {
  settings.showEdges = !settings.showEdges;

  if (currentEdges) {
    currentEdges.visible = settings.showEdges;
  }

  edgesButton.setAttribute(
    "aria-pressed",
    String(settings.showEdges)
  );
});

colorInput?.addEventListener("input", () => {
  settings.surfaceColor = colorInput.value;

  if (!currentUsesSemanticMaterials) {
    for (const material of currentMaterials) {
      material.color.set(settings.surfaceColor);
    }
  }

});

nightModeButton?.addEventListener("click", () => {
    const nightModeEnabled =
        nightModeButton.getAttribute("aria-pressed") === "true";

    scene.background = new THREE.Color(
        nightModeEnabled
            ? 0xF7F4ED
            : 0x000000
    );

    nightModeButton.setAttribute(
        "aria-pressed",
        String(!nightModeEnabled)
    );
});

pointSizeInput?.addEventListener("input", () => {
  settings.pointSize = Number(pointSizeInput.value);

  if (currentPointMaterial) {
    currentPointMaterial.size = settings.pointSize;
    currentPointMaterial.needsUpdate = true;
  }
});

pointLimitSelect?.addEventListener("change", () => {
  settings.pointLimit = Number(pointLimitSelect.value);

  if (currentPointSource) {
    const loadedCount = currentPointSource.positions.length / 3;
    const sourceCount = currentPointSourceCount ?? loadedCount;

    if (
        settings.pointLimit > loadedCount &&
        sourceCount > loadedCount
    ) {
      vscodeApi.postMessage({
        type: "reloadPointCloud",
        maxPoints: settings.pointLimit
      });
      return;
    }

    displayPointGeometry(currentPointSource);
  }
});

pointColorModeSelect?.addEventListener("change", () => {
  settings.pointColorMode =
    pointColorModeSelect.value as PointColorMode;

  updateClassificationControls(
    settings.pointColorMode
  );

  if (currentPointSource) {
    displayPointGeometry(currentPointSource);
  } else {
    applyPointColorMode(settings.pointColorMode);
  }
});

pointColorRampSelect?.addEventListener("change", () => {
  settings.colorRamp =
    pointColorRampSelect.value as ColorRampName;

  if (
    settings.pointColorMode === "elevation" ||
    settings.pointColorMode.startsWith("attribute:")
  ) {
    applyPointColorMode(
      settings.pointColorMode
    );
  }
});


fitViewButton?.addEventListener("click", () => {
    if (currentModel){
        fitObject(currentModel);
    }
    else{
        fitObject(cube);
    }
});



function resize(){
    const width = viewer.clientWidth;
    const height = viewer.clientHeight;

    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    
    renderer.setSize(width, height);
}

window.addEventListener("resize", resize);

const viewerResizeObserver = new ResizeObserver(() => {
    resize();
});

viewerResizeObserver.observe(viewer);

function animate() {
    requestAnimationFrame(animate);

    if (placeholderActive) {
    cube.rotation.y += 0.005;
    cube.rotation.x += 0.005;
    }

    controls.update();
    renderer.render(scene, camera);
}



function fitObject(object: THREE.Object3D) {
    const bounds = new THREE.Box3().setFromObject(object);

    if (bounds.isEmpty()){
        return;
    }

    const center = bounds.getCenter(
        new THREE.Vector3()
    );

    const size = bounds.getSize(
        new THREE.Vector3()
    );

    const maxDimension = Math.max(
        size.x,
        size.y,
        size.z
    );

    const fieldOfView = THREE.MathUtils.degToRad(
        camera.fov
    );

    const distance = (maxDimension / 2) / Math.tan(fieldOfView / 2);

    const paddedDistance = distance * 1.5;
    const viewDirection = new THREE.Vector3(
        1,
        1,
        1
    ).normalize();

    camera.position.copy(center).add(
        viewDirection.multiplyScalar(paddedDistance)
    );

    camera.near = Math.max(
        paddedDistance / 100,
        0.01
    );

    camera.far = Math.max(
        paddedDistance * 100,
        1000
    );

    camera.updateProjectionMatrix();

    controls.target.copy(center);
    controls.update();
}




animate();

