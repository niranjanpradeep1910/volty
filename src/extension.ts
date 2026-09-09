import * as path from "node:path";
import * as vscode from "vscode";
import * as fs from "node:fs/promises";
import { Worker } from "node:worker_threads";

type GltfResources = Record<string, string>;

const DEFAULT_POINT_PREVIEW_LIMIT = 1_000_000;
const MAX_POINT_PREVIEW_LIMIT = 5_000_000;
const activePointCloudFiles = new WeakMap<
  vscode.WebviewPanel,
  vscode.Uri
>();

const SUPPORTED_MODEL_EXTENSIONS = [
  ".obj",
  ".json",
  ".gltf",
  ".glb",
  ".ply",
  ".las",
  ".laz"
] as const;

const MODEL_FILE_FILTERS: Record<string, string[]> = {
  "3D Models": ["obj", "json", "gltf", "glb", "ply", "las", "laz"],
  "OBJ Files": ["obj"],
  "CityJSON Files": ["json"],
  "glTF Files": ["gltf", "glb"],
  "PLY Files": ["ply"],
  "LAS/LAZ Files": ["las", "laz"]
};

interface PointCloudPreview {
  positions: ArrayBuffer;
  intensity: ArrayBuffer;
  classification: ArrayBuffer;
  returnNumber: ArrayBuffer;
  numberOfReturns: ArrayBuffer;
  pointCount: number;
  sourcePointCount: number;
  elevationRange: [number, number];
  availableAttributes: string[];
}

function loadPointCloudPreviewWithWorker(
  workerFile: string,
  filePath: string,
  maxPoints = DEFAULT_POINT_PREVIEW_LIMIT
): Promise<PointCloudPreview> {
  const workerPath = path.join(
    __dirname,
    "pointcloud",
    workerFile
  );

  return new Promise((resolve, reject) => {
    const worker = new Worker(workerPath, {
      workerData: { filePath, maxPoints }
    });

    worker.once("message", (message: PointCloudPreview) => {
      resolve(message);
    });
    worker.once("error", reject);
    worker.once("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`Point-cloud preview worker stopped with code ${code}`));
      }
    });
  });
}

function loadPointCloudPreview(
  filePath: string,
  maxPoints: number
): Promise<PointCloudPreview> {
  return loadPointCloudPreviewWithWorker(
    "lazPreviewWorker.js",
    filePath,
    maxPoints
  );
}

function loadCopcPreview(
  filePath: string,
  maxPoints: number
): Promise<PointCloudPreview> {
  return loadPointCloudPreviewWithWorker(
    "copcPreviewWorker.js",
    filePath,
    maxPoints
  );
}

async function sendPointCloudToPanel(
  panel: vscode.WebviewPanel,
  fileUri: vscode.Uri,
  maxPoints: number
): Promise<void> {
  const isCopc = isCopcFile(fileUri.fsPath);
  const preview = isCopc
    ? await loadCopcPreview(fileUri.fsPath, maxPoints)
    : await loadPointCloudPreview(fileUri.fsPath, maxPoints);

  await panel.webview.postMessage({
    type: "pointCloudPreviewLoaded",
    fileName: path.basename(fileUri.fsPath),
    format: isCopc
      ? "copc"
      : path.extname(fileUri.fsPath).slice(1).toLowerCase(),
    ...preview
  });
}

function isGltfFile(filePath: string): boolean {
  const lowerPath = filePath.toLowerCase();
  return lowerPath.endsWith(".gltf") || lowerPath.endsWith(".glb");
}

function isPointCloudFile(filePath: string): boolean {
  const extension = path.extname(filePath).toLowerCase();
  return extension === ".las" || extension === ".laz";
}

function isCopcFile(filePath: string): boolean {
  return filePath.toLowerCase().endsWith(".copc.laz");
}

function isBinaryModelFile(filePath: string): boolean {
  const extension = path.extname(filePath).toLowerCase();
  return extension === ".glb" || extension === ".ply";
}

async function readGltfResources(
  filePath: string,
  content: string | Uint8Array
): Promise<GltfResources> {
  if (typeof content !== "string") {
    return {};
  }

  const gltf = JSON.parse(content) as {
    buffers?: Array<{ uri?: string }>;
    images?: Array<{ uri?: string }>;
  };

  const uris = [
    ...(gltf.buffers ?? []).map((buffer) => buffer.uri),
    ...(gltf.images ?? []).map((image) => image.uri)
  ].filter(
    (uri): uri is string =>
      typeof uri === "string" && !uri.startsWith("data:")
  );

  const resources: GltfResources = {};
  const baseDirectory = path.dirname(filePath);

  for (const uri of new Set(uris)) {
    const resourcePath = path.resolve(
      baseDirectory,
      decodeURIComponent(uri)
    );
    const resource = await fs.readFile(resourcePath);
    const extension = path.extname(resourcePath).toLowerCase();
    const mimeType = extension === ".jpg" || extension === ".jpeg"
      ? "image/jpeg"
      : extension === ".png"
        ? "image/png"
        : extension === ".bin"
          ? "application/octet-stream"
          : "application/octet-stream";
    const dataUrl = `data:${mimeType};base64,${resource.toString("base64")}`;

    resources[uri] = dataUrl;
    resources[decodeURIComponent(uri)] = dataUrl;
  }

  return resources;
}

class VoltyFileItem extends vscode.TreeItem {
  constructor(
    public readonly resourceUri: vscode.Uri,
    public readonly isDirectory: boolean
  ) {
    super(
      resourceUri.path.split("/").pop() ?? resourceUri.fsPath,
      isDirectory
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None
    );

    this.tooltip = resourceUri.fsPath;
    this.iconPath = new vscode.ThemeIcon(
      isDirectory ? "folder" : "file"
    );

    if (!isDirectory) {
      this.command = {
        command: "volty.openWorkspaceFile",
        title: "Open in Volty",
        arguments: [resourceUri]
      };
    }
  }
}

class VoltyFileTreeProvider
  implements vscode.TreeDataProvider<VoltyFileItem> {
  private readonly changeEmitter =
    new vscode.EventEmitter<VoltyFileItem | undefined>();

  readonly onDidChangeTreeData =
    this.changeEmitter.event;

  private readonly ignoredDirectories = new Set([
    ".git",
    "node_modules",
    "dist",
    "media"
  ]);

  getTreeItem(element: VoltyFileItem): VoltyFileItem {
    return element;
  }

  async getChildren(
    element?: VoltyFileItem
  ): Promise<VoltyFileItem[]> {
    const workspaceFolder =
      vscode.workspace.workspaceFolders?.[0];

    if (!workspaceFolder) {
      return [];
    }

    const directory =
      element?.resourceUri ?? workspaceFolder.uri;

    const entries = await vscode.workspace.fs.readDirectory(
      directory
    );

    const items: VoltyFileItem[] = [];

    for (const [name, fileType] of entries) {
      if (
        fileType === vscode.FileType.Directory &&
        this.ignoredDirectories.has(name)
      ) {
        continue;
      }

      if (fileType === vscode.FileType.Directory) {
        items.push(
          new VoltyFileItem(
            vscode.Uri.joinPath(directory, name),
            true
          )
        );
        continue;
      }

      const lowerName = name.toLowerCase();
      const supported =
        SUPPORTED_MODEL_EXTENSIONS.some(
          (extension) => lowerName.endsWith(extension)
        );

      if (supported) {
        items.push(
          new VoltyFileItem(
            vscode.Uri.joinPath(directory, name),
            false
          )
        );
      }
    }

    return items.sort((left, right) => {
      if (left.isDirectory !== right.isDirectory) {
        return left.isDirectory ? -1 : 1;
      }

      return String(left.label).localeCompare(
        String(right.label)
      );
    });
  }

  refresh(): void {
    this.changeEmitter.fire(undefined);
  }

  dispose(): void {
    this.changeEmitter.dispose();
  }
}

async function selectModelFile(): Promise<vscode.Uri | undefined> {
  const selectedFiles = await vscode.window.showOpenDialog({
    canSelectMany: false,
    openLabel: "Open Model",
    filters: MODEL_FILE_FILTERS
  });

  return selectedFiles?.[0];
}

async function sendModelToPanel(
  panel: vscode.WebviewPanel,
  fileUri: vscode.Uri,
  fileName = path.basename(fileUri.fsPath),
  maxPoints = DEFAULT_POINT_PREVIEW_LIMIT
): Promise<void> {
  const format = isCopcFile(fileUri.fsPath)
    ? "copc"
    : path.extname(fileUri.fsPath).slice(1).toLowerCase();

  await panel.webview.postMessage({
    type: "modelLoading",
    fileName,
    format
  });

  if (isPointCloudFile(fileUri.fsPath)) {
    await sendPointCloudToPanel(panel, fileUri, maxPoints);
    activePointCloudFiles.set(panel, fileUri);
    return;
  }

  const content = isBinaryModelFile(fileUri.fsPath)
    ? new Uint8Array(await fs.readFile(fileUri.fsPath))
    : await fs.readFile(fileUri.fsPath, "utf8");
  const resources = isGltfFile(fileUri.fsPath)
    ? await readGltfResources(fileUri.fsPath, content)
    : undefined;

  await panel.webview.postMessage({
    type: "modelLoaded",
    fileName,
    content,
    resources
  });
  activePointCloudFiles.delete(panel);
}

function showOpenModelError(error: unknown): void {
  const message = error instanceof Error ? error.message : "Unknown error";
  vscode.window.showErrorMessage(`Could not open model: ${message}`);
}

function getPointPreviewLimit(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_POINT_PREVIEW_LIMIT;
  }

  return Math.min(
    MAX_POINT_PREVIEW_LIMIT,
    Math.max(1, Math.floor(value))
  );
}

async function selectAndSendModel(
  panel: vscode.WebviewPanel,
  maxPoints: number
): Promise<void> {
  try {
    const fileUri = await selectModelFile();
    if (fileUri) {
      await sendModelToPanel(panel, fileUri, fileUri.fsPath, maxPoints);
    }
  } catch (error) {
    showOpenModelError(error);
  }
}



function createViewerPanel(
    context: vscode.ExtensionContext,
    onReady?: (panel: vscode.WebviewPanel) => void | Promise<void>
) {
    const panel = vscode.window.createWebviewPanel(
        "voltyViewer",
        "Volty",
        vscode.ViewColumn.One,
        {
            enableScripts: true,
            localResourceRoots: [
                vscode.Uri.file(context.extensionPath),
                ...(vscode.workspace.workspaceFolders ?? [])
                  .map((folder) => folder.uri)
            ]
        }
    );

    panel.webview.onDidReceiveMessage(
      async (message) => {
        if (message.type === "ready" && onReady) {
          await onReady(panel);
        }

        if(message.type === "openModel") {
          await selectAndSendModel(
            panel,
            getPointPreviewLimit(message.maxPoints)
          );
        }

        if (message.type === "reloadPointCloud") {
          const fileUri = activePointCloudFiles.get(panel);

          if (!fileUri) {
            return;
          }

          try {
            await panel.webview.postMessage({
              type: "modelLoading",
              fileName: path.basename(fileUri.fsPath),
              format: isCopcFile(fileUri.fsPath)
                ? "copc"
                : path.extname(fileUri.fsPath).slice(1).toLowerCase()
            });
            await sendPointCloudToPanel(
              panel,
              fileUri,
              getPointPreviewLimit(message.maxPoints)
            );
          } catch (error) {
            showOpenModelError(error);
          }
        }

      }
    );

    const scriptUri = panel.webview.asWebviewUri(
        vscode.Uri.file(
            path.join(context.extensionPath, "media", "main.js")
        )
    );

  panel.webview.html = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">

      <meta
        http-equiv="Content-Security-Policy"
        content="
          default-src 'none';
          script-src ${panel.webview.cspSource};
          connect-src ${panel.webview.cspSource} data:;
          img-src ${panel.webview.cspSource} data:;
          style-src ${panel.webview.cspSource} 'unsafe-inline';
        "
      >

      <meta
        name="viewport"
        content="width=device-width, initial-scale=1.0"
      >

      <title>Volty</title>

      <style>
        :root {
          --volty-radius: 6px;
          --volty-spacing: 8px;
          --volty-border: var(--vscode-panel-border);
          --volty-surface: var(--vscode-sideBar-background);
          --volty-hover: var(--vscode-toolbar-hoverBackground);
        }

        * {
          box-sizing: border-box;
        }

        html,
        body {
          width: 100%;
          height: 100%;
          margin: 0;
          overflow: hidden;

          color: var(--vscode-foreground);
          background: var(--vscode-editor-background);
          font-family: var(--vscode-font-family);
          font-size: var(--vscode-font-size);
        }

        button,
        input {
          font: inherit;
        }

        #app {
          display: flex;
          flex-direction: column;
          width: 100%;
          height: 100%;
        }

        #toolbar {
          display: flex;
          align-items: center;
          min-height: 46px;
          padding: 0 12px;

          background: var(--vscode-titleBar-activeBackground);
          border-bottom: 1px solid var(--volty-border);
          box-shadow: 0 1px 6px rgba(0, 0, 0, 0.16);

          transition:
            min-height 160ms ease,
            padding 160ms ease;
        }

        #toolbar.collapsed {
          min-height: 34px;
          padding: 0 8px;
        }

        #toolbar-content {
          display: flex;
          align-items: center;
          flex: 1;
          gap: var(--volty-spacing);
          min-width: 0;
          margin-left: 10px;

          transition:
            opacity 120ms ease,
            transform 160ms ease;
        }

        .toolbar-actions {
          display: flex;
          align-items: center;
          gap: var(--volty-spacing);
          margin-left: auto;
        }

        #toolbar.collapsed #toolbar-content {
          opacity: 0;
          pointer-events: none;
          transform: translateX(-8px);
        }

        .brand {
          display: flex;
          align-items: center;
          gap: 7px;
          white-space: nowrap;
          font-weight: 600;
        }

        .brand-mark {
          display: grid;
          place-items: center;
          width: 24px;
          height: 24px;

          color: var(--vscode-button-foreground);
          background: var(--vscode-button-background);
          border-radius: 6px;
          font-size: 13px;
        }

        .brand-name {
          letter-spacing: 0.2px;
        }

        .toolbar-divider {
          width: 1px;
          height: 22px;
          margin: 0 4px;
          background: var(--volty-border);
        }

        .toolbar-group {
          display: flex;
          gap: 4px;
        }

        .tool-button,
        .icon-button {
          border: 1px solid transparent;
          border-radius: var(--volty-radius);
          cursor: pointer;

          transition:
            background-color 120ms ease,
            border-color 120ms ease,
            transform 120ms ease;
        }

        .tool-button {
          min-height: 29px;
          padding: 0 10px;

          color: var(--vscode-button-secondaryForeground);
          background: var(--vscode-button-secondaryBackground);
          border-color: var(--vscode-button-border);
          font-size: 12px;
        }

        .tool-button:hover {
          background: var(--vscode-button-secondaryHoverBackground);
          border-color: var(--vscode-focusBorder);
        }

        .tool-button:active {
          transform: translateY(1px);
        }

        .tool-button.primary {
          color: var(--vscode-button-foreground);
          background: var(--vscode-button-background);
          border-color: var(--vscode-button-background);
          font-weight: 600;
        }

        .tool-button.primary:hover {
          background: var(--vscode-button-hoverBackground);
        }

        .tool-button[aria-pressed="false"] {
          opacity: 0.55;
        }

        .icon-button {
          display: grid;
          place-items: center;
          width: 28px;
          height: 28px;
          padding: 0;

          color: var(--vscode-foreground);
          background: transparent;
          font-size: 17px;
        }

        .icon-button:hover {
          background: var(--volty-hover);
        }

        .icon-button:focus-visible,
        .tool-button:focus-visible,
        input:focus-visible {
          outline: 1px solid var(--vscode-focusBorder);
          outline-offset: 2px;
        }

        .color-control {
          display: flex;
          align-items: center;
          gap: 6px;
          margin-left: 4px;

          color: var(--vscode-descriptionForeground);
          font-size: 12px;
          white-space: nowrap;
        }

        .color-control input {
          width: 28px;
          height: 26px;
          padding: 2px;
          border: 1px solid var(--volty-border);
          border-radius: var(--volty-radius);
          background: transparent;
          cursor: pointer;
        }

        #workspace {
          display: flex;
          flex: 1;
          min-height: 0;
        }

        #viewport {
          position: relative;
          flex: 1;
          min-width: 0;
          min-height: 0;
        }

        #viewer {
          position: absolute;
          inset: 0;
        }

        #inspector {
          display: flex;
          flex: 0 0 290px;
          flex-direction: column;
          width: 290px;

          background: var(--volty-surface);
          border-left: 1px solid var(--volty-border);
          box-shadow: -2px 0 8px rgba(0, 0, 0, 0.12);

          transition:
            width 160ms ease,
            flex-basis 160ms ease;
        }

        #inspector.collapsed {
          flex-basis: 36px;
          width: 36px;
        }

        #inspector-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          height: 44px;
          padding: 0 8px;

          border-bottom: 1px solid var(--volty-border);
          font-weight: 600;
        }

        #inspector.collapsed #inspector-title,
        #inspector.collapsed #inspector-content {
          display: none;
        }

        #inspector.collapsed #inspector-toggle {
          transform: rotate(180deg);
        }

        #inspector-content {
          padding: 16px;
          overflow: auto;
        }

        .empty-state {
          padding: 20px 4px;
          color: var(--vscode-descriptionForeground);
        }

        .empty-state-title {
          margin: 0 0 6px;
          color: var(--vscode-foreground);
          font-weight: 600;
        }

        .empty-state-text {
          margin: 0;
          line-height: 1.5;
          font-size: 12px;
        }

        #model-details {
          margin: 0;
        }

        #model-details dt {
          margin-top: 16px;
          color: var(--vscode-descriptionForeground);
          font-size: 11px;
          text-transform: uppercase;
          letter-spacing: 0.04em;
        }

        #model-details dd {
          margin: 4px 0 0;
          overflow-wrap: anywhere;
        }

        #detail-semantics {
          display: flex;
          flex-direction: column;
          gap: 3px;
        }

        .semantic-swatch {
          width: 12px;
          height: 12px;
          flex: 0 0 12px;
          border: 1px solid var(--vscode-foreground);
          border-radius: 2px;
        }


        #lod-control {
            display: flex;
            flex-direction: column;
            gap: 6px;
            margin-bottom: 16px;
          }

          #lod-control label {
            color: var(--vscode-descriptionForeground);
            font-size: 11px;
            text-transform: uppercase;
            letter-spacing: 0.04em;
          }

          #lod-select {
            width: 100%;
            min-height: 30px;
            padding: 4px 8px;

            color: var(--vscode-dropdown-foreground);
            background: var(--vscode-dropdown-background);
            border: 1px solid var(--vscode-dropdown-border);
            border-radius: 5px;
          }

          #lod-select:focus-visible {
            outline: 1px solid var(--vscode-focusBorder);
            outline-offset: 2px;
          }

          #point-controls {
            display: flex;
            flex-direction: column;
            gap: 8px;
            margin-bottom: 16px;
          }

          #point-controls h3 {
            margin: 0;
            font-size: 12px;
            font-weight: 600;
          }

          #point-controls label {
            color: var(--vscode-descriptionForeground);
            font-size: 11px;
            text-transform: uppercase;
            letter-spacing: 0.04em;
          }

          #point-size {
            width: 100%;
            accent-color: var(--vscode-focusBorder);
          }

          #point-limit,
          #point-color-mode,
          #point-color-ramp {
            width: 100%;
            min-height: 30px;
            padding: 4px 8px;

            color: var(--vscode-dropdown-foreground);
            background: var(--vscode-dropdown-background);
            border: 1px solid var(--vscode-dropdown-border);
            border-radius: 5px;
          }

          #point-color-legend {
            display: flex;
            flex-direction: column;
            gap: 4px;
          }

          #point-color-legend-bar {
            height: 12px;
            border: 1px solid var(--volty-border);
            border-radius: 3px;
          }

          #point-color-legend-labels {
            display: flex;
            justify-content: space-between;
            color: var(--vscode-descriptionForeground);
            font-size: 11px;
          }

          #point-color-legend-items {
            display: none;
            flex-direction: column;
            gap: 4px;
            color: var(--vscode-descriptionForeground);
            font-size: 11px;
          }

          .point-color-legend-item {
            display: flex;
            align-items: center;
            gap: 6px;
          }

          .point-color-legend-swatch {
            width: 12px;
            height: 12px;
            border: 1px solid var(--volty-border);
            border-radius: 2px;
            flex: 0 0 12px;
          }

          #classification-controls {
            display: none;
            flex-direction: column;
            gap: 5px;
            padding-top: 4px;
          }

          #classification-controls label {
            display: flex;
            align-items: center;
            gap: 6px;
            color: var(--vscode-foreground);
            font-size: 12px;
            text-transform: none;
            letter-spacing: normal;
          }

          #toggle-point-colors {
            width: 100%;
          }
      </style>
    </head>

    <body>
      <div id="app">
        <header id="toolbar">
          <button
            id="toolbar-toggle"
            class="icon-button"
            type="button"
            aria-label="Collapse toolbar"
            aria-expanded="true"
            title="Collapse toolbar"
          >
            ☰
          </button>

          <div id="toolbar-content">
            <div class="brand">
              <span class="brand-name">Volty</span>
            </div>

            <div class="toolbar-divider"></div>

            <div class="toolbar-actions">
            <button
              id="open-model"
              class="tool-button primary"
              type="button"
            >
              Open Model
            </button>

            <button
              id="fit-view"
              class="tool-button"
              type="button"
            >
              Fit
            </button>

            <div class="toolbar-group">
              <button
                id="toggle-grid"
                class="tool-button"
                type="button"
                aria-pressed="true"
              >
                Grid
              </button>

              <button
                id="toggle-axes"
                class="tool-button"
                type="button"
                aria-pressed="true"
              >
                Axes
              </button>

              <button
                id="toggle-edges"
                class="tool-button"
                type="button"
                aria-pressed="true"
              >
                Edges
              </button>

            </div>

            <label class="color-control">
              <span>Surface</span>
              <input
                id="surface-color"
                type="color"
                value="#6699cc"
                aria-label="Surface color"
              >
            </label>

            <button
              id="toggle-night-mode"
              class="tool-button"
              type="button"
              aria-pressed="false"
              title="Toggle black background"
            >
              Night mode
            </button>

            </div>
          </div>
        </header>

        <main id="workspace">
          <section id="viewport">
            <div id="viewer"></div>
          </section>

          <aside id="inspector">
            <header id="inspector-header">
              <span id="inspector-title">Properties</span>

              <button
                id="inspector-toggle"
                class="icon-button"
                type="button"
                aria-label="Collapse properties"
                aria-expanded="true"
                title="Collapse properties"
              >
                ›
              </button>
            </header>

            <div id="inspector-content">
              <div id="empty-state" class="empty-state">
                <p class="empty-state-title">No model loaded</p>
                <p class="empty-state-text">
                  Open a file to inspect it.
                </p>
              </div>

              <div id="lod-control">
                <label for="lod-select">
                  Level of Detail
                </label>

                <select id="lod-select" disabled>
                  <option>No LoD available</option>
                </select>
              </div>

              <section id="point-controls">
                <h3>Point cloud</h3>

                <label for="point-size">
                  Point size
                </label>
                <input
                  id="point-size"
                  type="range"
                  min="0.005"
                  max="2"
                  step="0.005"
                  value="0.04"
                  aria-label="Point size"
                >

                <label for="point-limit">
                  Display points
                </label>
                <select id="point-limit">
                  <option value="100000">100k points</option>
                  <option value="500000">500k points</option>
                  <option value="1000000" selected>1M points</option>
                  <option value="2000000">2M points</option>
                  <option value="5000000">5M points</option>
                </select>

                <label for="point-color-mode">
                  Color by
                </label>
                <select id="point-color-mode">
                  <option value="rgb">RGB</option>
                  <option value="elevation">Elevation</option>
                </select>

                <label for="point-color-ramp">
                  Color ramp
                </label>
                <select id="point-color-ramp">
                  <option value="viridis">Viridis</option>
                  <option value="turbo">Turbo</option>
                  <option value="grayscale">Grayscale</option>
                  <option value="terrain">Terrain</option>
                </select>

                <div id="classification-controls"></div>

                <div id="point-color-legend">
                  <div id="point-color-legend-bar"></div>
                  <div id="point-color-legend-labels">
                    <span id="point-color-legend-min">Low</span>
                    <span id="point-color-legend-max">High</span>
                  </div>
                  <div id="point-color-legend-items"></div>
                </div>
              </section>

              <section id="validation-panel">
               <h3>Validation</h3>
               <p id="validation-summary">
                  No validation issues
                </p>
                <ul id="validation-issues"></ul>
              </section>

              <dl id="model-details">
                <dt>File</dt>
                <dd id="detail-file">—</dd>

                <dt>Format</dt>
                <dd id="detail-format">—</dd>

                <dt>Objects</dt>
                <dd id="detail-objects">—</dd>

                <dt>Vertices</dt>
                <dd id="detail-vertices">—</dd>

            <dt>Points</dt>
            <dd id="detail-points">Not available</dd>

            <dt>Available attributes</dt>
            <dd id="detail-attributes">Not available</dd>

            <dt>Triangles</dt>
            <dd id="detail-triangles">—</dd>

            <dt>LoDs</dt>
            <dd id="detail-lods">—</dd>
            <dt>Selected LoD</dt>
            <dd id="detail-selected-lod">Not available</dd>

            <dt>Semantic surfaces</dt>
            <dd id="detail-semantics">Not available</dd>
          </dl>
            </div>
          </aside>
        </main>
      </div>

      <script type="module" src="${scriptUri}"></script>
    </body>


    </html>
  `;

  return panel;


}

function openModelInViewer(
  context: vscode.ExtensionContext,
  fileUri: vscode.Uri
): void {
  createViewerPanel(context, async (panel) => {
    try {
      await sendModelToPanel(panel, fileUri);
    } catch (error) {
      showOpenModelError(error);
    }
  });
}


export function activate(context: vscode.ExtensionContext) {
  const openViewerCommand = vscode.commands.registerCommand(
    "volty.openViewer",
    () => {
      createViewerPanel(context);
    }
  );

  const openModelCommand = vscode.commands.registerCommand(
    "volty.openModel",
    async () => {
      try {
        const fileUri = await selectModelFile();
        if (fileUri) {
          openModelInViewer(context, fileUri);
        }
      } catch (error) {
        showOpenModelError(error);
      }
    }
  );

  const fileTreeProvider =
    new VoltyFileTreeProvider();

  const activityBarView =
    vscode.window.registerTreeDataProvider(
      "volty.viewer",
      fileTreeProvider
    );

  const openWorkspaceFile =
    vscode.commands.registerCommand(
      "volty.openWorkspaceFile",
      async (fileUri: vscode.Uri) => {
        openModelInViewer(context, fileUri);
      }
    );
  

  context.subscriptions.push(
    openViewerCommand,
    openModelCommand,
    activityBarView,
    openWorkspaceFile,
    fileTreeProvider
  );
}

export function deactivate() {}
