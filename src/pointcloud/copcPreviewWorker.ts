import { parentPort, workerData } from "node:worker_threads";

interface PreviewRequest {
  filePath: string;
  maxPoints: number;
}

interface CopcNode {
  pointCount: number;
  pointDataOffset: number;
  pointDataLength: number;
}

interface CopcPage {
  pageOffset: number;
  pageLength: number;
}

interface CopcHierarchyPage {
  nodes: Record<string, CopcNode | undefined>;
  pages: Record<string, CopcPage | undefined>;
}

interface CopcPointView {
  pointCount: number;
  getter(name: string): (index: number) => number;
}

interface CopcDataset {
  header: {
    min: [number, number, number];
    max: [number, number, number];
    pointCount: number;
  };
  info: {
    rootHierarchyPage: CopcPage;
  };
}

interface CopcApi {
  Copc: {
    create(source: string): Promise<CopcDataset>;
    loadHierarchyPage(
      source: string,
      page: CopcPage
    ): Promise<CopcHierarchyPage>;
    loadPointDataView(
      source: string,
      dataset: CopcDataset,
      node: CopcNode,
      options?: { include?: string[] }
    ): Promise<CopcPointView>;
  };
}

function getNativeModule(moduleName: string): Promise<CopcApi> {
  return Function("name", "return import(name)")(moduleName) as Promise<CopcApi>;
}

function getNodeDepth(nodeId: string): number {
  return Number(nodeId.split("-")[0]);
}

async function loadNodes(
  copc: CopcApi["Copc"],
  filePath: string,
  rootPage: CopcPage
): Promise<CopcNode[]> {
  const pages = [rootPage];
  const nodes: Array<{ id: string; node: CopcNode }> = [];

  while (pages.length > 0) {
    const page = pages.shift();
    if (!page) {
      continue;
    }

    const subtree = await copc.loadHierarchyPage(filePath, page);

    for (const [id, node] of Object.entries(subtree.nodes)) {
      if (node && node.pointCount > 0) {
        nodes.push({ id, node });
      }
    }

    for (const childPage of Object.values(subtree.pages)) {
      if (childPage) {
        pages.push(childPage);
      }
    }
  }

  return nodes
    .sort((left, right) => getNodeDepth(left.id) - getNodeDepth(right.id))
    .map(({ node }) => node);
}

async function createPreview(request: PreviewRequest): Promise<void> {
  const { Copc } = await getNativeModule("copc");
  const dataset = await Copc.create(request.filePath);
  const nodes = await loadNodes(
    Copc,
    request.filePath,
    dataset.info.rootHierarchyPage
  );

  if (nodes.length === 0) {
    throw new Error("COPC hierarchy contains no point-data nodes");
  }

  const positions = new Float32Array(request.maxPoints * 3);
  const intensity = new Uint16Array(request.maxPoints);
  const classification = new Uint8Array(request.maxPoints);
  const returnNumber = new Uint8Array(request.maxPoints);
  const numberOfReturns = new Uint8Array(request.maxPoints);
  let sampleCount = 0;

  for (const node of nodes) {
    const remaining = request.maxPoints - sampleCount;
    if (remaining === 0) {
      break;
    }

    const view = await Copc.loadPointDataView(
      request.filePath,
      dataset,
      node,
      {
        include: [
          "X", "Y", "Z", "Intensity", "Classification",
          "ReturnNumber", "NumberOfReturns"
        ]
      }
    );
    const takeCount = Math.min(remaining, view.pointCount);
    const stride = Math.max(1, Math.ceil(view.pointCount / takeCount));
    const getX = view.getter("X");
    const getY = view.getter("Y");
    const getZ = view.getter("Z");
    const getIntensity = view.getter("Intensity");
    const getClassification = view.getter("Classification");
    const getReturnNumber = view.getter("ReturnNumber");
    const getNumberOfReturns = view.getter("NumberOfReturns");

    for (
      let pointIndex = 0;
      pointIndex < view.pointCount && sampleCount < request.maxPoints;
      pointIndex += stride
    ) {
      positions[sampleCount * 3] = getX(pointIndex) - dataset.header.min[0];
      positions[sampleCount * 3 + 1] =
        getZ(pointIndex) - dataset.header.min[2];
      positions[sampleCount * 3 + 2] =
        -(getY(pointIndex) - dataset.header.min[1]);
      intensity[sampleCount] = getIntensity(pointIndex);
      classification[sampleCount] = getClassification(pointIndex);
      returnNumber[sampleCount] = getReturnNumber(pointIndex);
      numberOfReturns[sampleCount] = getNumberOfReturns(pointIndex);
      sampleCount++;
    }
  }

  const positionBuffer = positions.buffer.slice(0, sampleCount * 3 * 4);
  const intensityBuffer = intensity.buffer.slice(0, sampleCount * 2);
  const classificationBuffer = classification.buffer.slice(0, sampleCount);
  const returnNumberBuffer = returnNumber.buffer.slice(0, sampleCount);
  const numberOfReturnsBuffer = numberOfReturns.buffer.slice(0, sampleCount);

  parentPort?.postMessage(
    {
      positions: positionBuffer,
      intensity: intensityBuffer,
      classification: classificationBuffer,
      returnNumber: returnNumberBuffer,
      numberOfReturns: numberOfReturnsBuffer,
      pointCount: sampleCount,
      sourcePointCount: dataset.header.pointCount,
      elevationRange: [dataset.header.min[2], dataset.header.max[2]],
      availableAttributes: [
        "Position (X, Y, Z)",
        "Intensity",
        "Classification",
        "Return number",
        "Number of returns"
      ]
    },
    [
      positionBuffer,
      intensityBuffer,
      classificationBuffer,
      returnNumberBuffer,
      numberOfReturnsBuffer
    ]
  );
}

void createPreview(workerData as PreviewRequest).catch((error) => {
  throw error;
});
