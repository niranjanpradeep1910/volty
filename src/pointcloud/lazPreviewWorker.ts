import * as fs from "node:fs/promises";
import { parentPort, workerData } from "node:worker_threads";
import { createLazPerf } from "laz-perf";

interface PreviewRequest {
  filePath: string;
  maxPoints: number;
}

interface LasHeader {
  pointCount: number;
  pointRecordLength: number;
  scale: [number, number, number];
  offset: [number, number, number];
  minimum: [number, number, number];
  maximum: [number, number, number];
}

function readLasHeader(file: Uint8Array): LasHeader {
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength);

  if (
    file.byteLength < 227 ||
    String.fromCharCode(...file.subarray(0, 4)) !== "LASF"
  ) {
    throw new Error("This file does not have a valid LAS header");
  }

  const headerSize = view.getUint16(94, true);
  let pointCount = view.getUint32(107, true);

  if (pointCount === 0 && headerSize >= 375 && file.byteLength >= 255) {
    const extendedPointCount = view.getBigUint64(247, true);
    if (extendedPointCount > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error("Point count is too large to preview safely");
    }
    pointCount = Number(extendedPointCount);
  }

  return {
    pointCount,
    pointRecordLength: view.getUint16(105, true),
    scale: [
      view.getFloat64(131, true),
      view.getFloat64(139, true),
      view.getFloat64(147, true)
    ],
    offset: [
      view.getFloat64(155, true),
      view.getFloat64(163, true),
      view.getFloat64(171, true)
    ],
    minimum: [
      view.getFloat64(187, true),
      view.getFloat64(203, true),
      view.getFloat64(219, true)
    ],
    maximum: [
      view.getFloat64(179, true),
      view.getFloat64(195, true),
      view.getFloat64(211, true)
    ]
  };
}

function getClassificationOffset(pointFormat: number): number {
  return pointFormat >= 6 ? 16 : 15;
}

function getClassification(point: DataView, pointFormat: number): number {
  const rawClassification = point.getUint8(
    getClassificationOffset(pointFormat)
  );

  return pointFormat >= 6
    ? rawClassification
    : rawClassification & 0x1f;
}

function getReturnNumbers(
  point: DataView,
  pointFormat: number
): [number, number] {
  const returnByte = point.getUint8(14);

  return pointFormat >= 6
    ? [returnByte & 0x0f, returnByte >> 4]
    : [returnByte & 0x07, (returnByte >> 3) & 0x07];
}

async function createPreview(request: PreviewRequest): Promise<void> {
  const file = await fs.readFile(request.filePath);
  const header = readLasHeader(file);
  const LazPerf = await createLazPerf();
  const inputPointer = LazPerf._malloc(file.byteLength);
  const pointPointer = LazPerf._malloc(header.pointRecordLength);
  const reader = new LazPerf.LASZip();

  try {
    LazPerf.HEAPU8.set(file, inputPointer);
    reader.open(inputPointer, file.byteLength);

    const pointCount = reader.getCount() || header.pointCount;
    const pointLength = reader.getPointLength();
    const pointFormat = reader.getPointFormat() & 0x3f;

    if (pointCount <= 0 || pointLength < 20) {
      throw new Error("The LAS/LAZ file contains no readable points");
    }

    const sampleStride = Math.max(
      1,
      Math.ceil(pointCount / request.maxPoints)
    );
    const sampleCapacity = Math.ceil(pointCount / sampleStride);
    const positions = new Float32Array(sampleCapacity * 3);
    const intensity = new Uint16Array(sampleCapacity);
    const classification = new Uint8Array(sampleCapacity);
    const returnNumber = new Uint8Array(sampleCapacity);
    const numberOfReturns = new Uint8Array(sampleCapacity);
    let sampleCount = 0;

    for (let pointIndex = 0; pointIndex < pointCount; pointIndex++) {
      reader.getPoint(pointPointer);

      if (pointIndex % sampleStride !== 0) {
        continue;
      }

      const point = new DataView(
        LazPerf.HEAPU8.buffer,
        pointPointer,
        pointLength
      );
      const x = point.getInt32(0, true) * header.scale[0] +
        header.offset[0];
      const y = point.getInt32(4, true) * header.scale[1] +
        header.offset[1];
      const z = point.getInt32(8, true) * header.scale[2] +
        header.offset[2];

      positions[sampleCount * 3] = x - header.minimum[0];
      positions[sampleCount * 3 + 1] = z - header.minimum[2];
      positions[sampleCount * 3 + 2] = -(y - header.minimum[1]);
      intensity[sampleCount] = point.getUint16(12, true);
      classification[sampleCount] = getClassification(point, pointFormat);
      const [pointReturnNumber, pointNumberOfReturns] = getReturnNumbers(
        point,
        pointFormat
      );
      returnNumber[sampleCount] = pointReturnNumber;
      numberOfReturns[sampleCount] = pointNumberOfReturns;
      sampleCount++;
    }

    const positionBuffer = positions.buffer.slice(0, sampleCount * 3 * 4);
    const intensityBuffer = intensity.buffer.slice(0, sampleCount * 2);
    const classificationBuffer = classification.buffer.slice(0, sampleCount);
    const returnNumberBuffer = returnNumber.buffer.slice(0, sampleCount);
    const numberOfReturnsBuffer = numberOfReturns.buffer.slice(
      0,
      sampleCount
    );

    parentPort?.postMessage(
      {
        positions: positionBuffer,
        intensity: intensityBuffer,
        classification: classificationBuffer,
        returnNumber: returnNumberBuffer,
        numberOfReturns: numberOfReturnsBuffer,
        pointCount: sampleCount,
        sourcePointCount: pointCount,
        elevationRange: [header.minimum[2], header.maximum[2]],
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
  } finally {
    reader.delete();
    LazPerf._free(pointPointer);
    LazPerf._free(inputPointer);
  }
}

void createPreview(workerData as PreviewRequest).catch((error) => {
  throw error;
});
