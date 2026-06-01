import exifr from "exifr";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";

type ImageItem = {
  id: string;
  file?: File;
  name: string;
  path: string;
  size: number;
  modifiedAt: number;
  url: string;
  width?: number;
  height?: number;
  cacheLoaded: boolean;
  cachePromise?: Promise<void>;
  exif?: ExifSummary | null;
  exifLoaded: boolean;
  rawExtensions: string[];
};

type ExifSummary = {
  line: string;
  capturedAt?: Date;
  camera?: string;
  lens?: string;
  focalLength?: string;
  aperture?: string;
  shutterSpeed?: string;
  iso?: string;
  gps?: {
    latitude: number;
    longitude: number;
  };
};

type ViewState = {
  zoom: number;
  offsetX: number;
  offsetY: number;
};

type PickedFile = {
  file: File;
  path: string;
};

type NativeImageFile = {
  path: string;
  name: string;
  size: number;
  modified_at: number;
  kind?: "image" | "raw";
};

type CropRect = {
  left: number;
  top: number;
  width: number;
  height: number;
};

type SavedCrop = {
  blob: Blob;
  bytes: Uint8Array;
  path?: string;
};

declare global {
  interface FileSystemDirectoryHandle {
    entries(): AsyncIterableIterator<[string, FileSystemDirectoryHandle | FileSystemFileHandle]>;
  }

  interface FileSystemFileHandle {
    getFile(): Promise<File>;
    readonly kind: "file";
    name: string;
  }

  interface FileSystemDirectoryHandle {
    readonly kind: "directory";
    name: string;
  }

  interface Window {
    showDirectoryPicker?: () => Promise<FileSystemDirectoryHandle>;
    showOpenFilePicker?: (options?: {
      multiple?: boolean;
      types?: Array<{
        description: string;
        accept: Record<string, string[]>;
      }>;
    }) => Promise<FileSystemFileHandle[]>;
  }
}

const supportedExtensions = new Set([
  "jpg",
  "jpeg",
  "png",
  "webp",
  "gif",
  "avif",
  "heic",
  "heif",
]);

const rawExtensions = new Set([
  "cr2",
  "cr3",
  "nef",
  "nrw",
  "arw",
  "orf",
  "raf",
  "rw2",
  "pef",
  "dng",
]);

function isTauriRuntime() {
  return "__TAURI_INTERNALS__" in window;
}

const state = {
  images: [] as ImageItem[],
  activeIndex: 0,
  compareCount: 1,
  compareSlots: [0, null, null, null] as Array<number | null>,
  preloadRadius: Number(localStorage.getItem("digiviewer.preloadRadius") ?? 6),
  fitMode: true,
  syncView: true,
  activeSlot: 0,
  isDragging: false,
  isSelecting: false,
  selectionStartX: 0,
  selectionStartY: 0,
  selectionRect: null as CropRect | null,
  dragStartX: 0,
  dragStartY: 0,
  dragBaseX: 0,
  dragBaseY: 0,
  mapOpen: false,
  view: {
    zoom: 1,
    offsetX: 0,
    offsetY: 0,
  } satisfies ViewState,
  slotViews: Array.from({ length: 4 }, () => ({
    zoom: 1,
    offsetX: 0,
    offsetY: 0,
  })) as ViewState[],
};

const elements = {
  chooseFolderButton: document.querySelector<HTMLButtonElement>("#choose-folder"),
  chooseFilesButton: document.querySelector<HTMLButtonElement>("#choose-files"),
  openInput: document.querySelector<HTMLInputElement>("#open-folder"),
  fileInput: document.querySelector<HTMLInputElement>("#open-files"),
  viewport: document.querySelector<HTMLElement>("#viewer"),
  compareGrid: document.querySelector<HTMLElement>("#compare-grid"),
  selectionBox: document.querySelector<HTMLElement>("#selection-box"),
  cropActions: document.querySelector<HTMLElement>("#crop-actions"),
  cropStatus: document.querySelector<HTMLElement>("#crop-status"),
  cropLensButton: document.querySelector<HTMLButtonElement>("#crop-lens"),
  cropAiButton: document.querySelector<HTMLButtonElement>("#crop-ai"),
  cropCopyButton: document.querySelector<HTMLButtonElement>("#crop-copy"),
  cropRevealButton: document.querySelector<HTMLButtonElement>("#crop-reveal"),
  cropCancelButton: document.querySelector<HTMLButtonElement>("#crop-cancel"),
  thumbs: document.querySelector<HTMLElement>("#thumbs"),
  emptyState: document.querySelector<HTMLElement>("#empty-state"),
  imageCount: document.querySelector<HTMLElement>("#image-count"),
  activeName: document.querySelector<HTMLElement>("#active-name"),
  activeMeta: document.querySelector<HTMLElement>("#active-meta"),
  zoomValue: document.querySelector<HTMLElement>("#zoom-value"),
  preloadRadiusInput: document.querySelector<HTMLInputElement>("#preload-radius"),
  exifText: document.querySelector<HTMLElement>("#exif-text"),
  gpsText: document.querySelector<HTMLElement>("#gps-text"),
  mapButton: document.querySelector<HTMLButtonElement>("#map-button"),
  mapPanel: document.querySelector<HTMLElement>("#map-panel"),
  mapFrame: document.querySelector<HTMLIFrameElement>("#map-frame"),
  mapCloseButton: document.querySelector<HTMLButtonElement>("#map-close"),
  modeButtons: document.querySelectorAll<HTMLButtonElement>("[data-compare-count]"),
  syncButton: document.querySelector<HTMLButtonElement>("#sync-toggle"),
  fitButton: document.querySelector<HTMLButtonElement>("#fit-button"),
  actualButton: document.querySelector<HTMLButtonElement>("#actual-button"),
  prevButton: document.querySelector<HTMLButtonElement>("#prev-button"),
  nextButton: document.querySelector<HTMLButtonElement>("#next-button"),
};

window.addEventListener("DOMContentLoaded", () => {
  ensureCropDirectory();
  elements.chooseFolderButton?.addEventListener("click", openFolder);
  elements.chooseFilesButton?.addEventListener("click", openFiles);
  elements.openInput?.addEventListener("change", handleFileSelection);
  elements.fileInput?.addEventListener("change", handleFileSelection);
  if (elements.preloadRadiusInput) {
    elements.preloadRadiusInput.value = String(state.preloadRadius);
    elements.preloadRadiusInput.addEventListener("change", () => {
      state.preloadRadius = clamp(Number(elements.preloadRadiusInput?.value ?? 0), 0, 50);
      localStorage.setItem("digiviewer.preloadRadius", String(state.preloadRadius));
      preloadAroundActive();
    });
  }
  elements.viewport?.addEventListener("wheel", handleWheel, { passive: false });
  elements.viewport?.addEventListener("pointerdown", handlePointerDown);
  elements.viewport?.addEventListener("pointermove", handlePointerMove);
  elements.viewport?.addEventListener("pointerup", endDrag);
  elements.viewport?.addEventListener("pointercancel", endDrag);
  elements.cropActions?.addEventListener("pointerdown", (event) => event.stopPropagation());
  elements.cropLensButton?.addEventListener("click", (event) => {
    event.stopPropagation();
    openCropSearch("lens");
  });
  elements.cropAiButton?.addEventListener("click", (event) => {
    event.stopPropagation();
    openCropSearch("ai");
  });
  elements.cropCopyButton?.addEventListener("click", (event) => {
    event.stopPropagation();
    copyCropToClipboard();
  });
  elements.cropRevealButton?.addEventListener("click", (event) => {
    event.stopPropagation();
    revealCropInFinder();
  });
  elements.cropCancelButton?.addEventListener("click", (event) => {
    event.stopPropagation();
    clearSelection();
  });
  window.addEventListener("keydown", handleGlobalKeyChange);
  window.addEventListener("keyup", handleGlobalKeyChange);

  elements.prevButton?.addEventListener("click", () => moveActive(-1));
  elements.nextButton?.addEventListener("click", () => moveActive(1));
  elements.fitButton?.addEventListener("click", () => {
    fitView();
    renderViewTransform();
    renderMeta();
  });
  elements.actualButton?.addEventListener("click", () => setZoom(1));
  elements.mapButton?.addEventListener("click", () => {
    state.mapOpen = !state.mapOpen;
    renderMap();
  });
  elements.mapCloseButton?.addEventListener("click", () => {
    state.mapOpen = false;
    renderMap();
  });
  elements.syncButton?.addEventListener("click", () => {
    toggleSyncView();
    render();
  });

  for (const button of elements.modeButtons) {
    button.addEventListener("click", () => {
      state.compareCount = Number(button.dataset.compareCount ?? 1);
      state.activeSlot = Math.min(state.activeSlot, state.compareCount - 1);
      refillEmptySlots();
      fitView();
      render();
    });
  }

  window.addEventListener("keydown", handleKeyDown);
  render();
});

async function ensureCropDirectory() {
  if (!isTauriRuntime()) return;
  try {
    const directory = await invoke<string>("ensure_crop_directory");
    console.info(`Crop directory: ${directory}`);
  } catch (error) {
    console.warn("Failed to create crop directory", error);
  }
}

async function openFolder() {
  if (isTauriRuntime()) {
    try {
      const selected = await openDialog({
        directory: true,
        multiple: false,
        title: "画像フォルダを選択",
      });
      if (typeof selected !== "string") return;
      const images = await invoke<NativeImageFile[]>("scan_images", { directory: selected });
      loadNativeImages(images);
    } catch (error) {
      console.error(error);
    }
    return;
  }

  if (!window.showDirectoryPicker) {
    elements.openInput?.click();
    return;
  }

  try {
    const directory = await window.showDirectoryPicker();
    loadPickedFiles(await collectImageFiles(directory));
  } catch (error) {
    if (!isAbortError(error)) console.error(error);
  }
}

async function openFiles() {
  if (isTauriRuntime()) {
    try {
      const selected = await openDialog({
        multiple: true,
        title: "画像を選択",
        filters: [
          {
            name: "Images",
            extensions: ["jpg", "jpeg", "png", "webp", "gif", "avif", "heic", "heif"],
          },
        ],
      });
      const paths = Array.isArray(selected) ? selected : selected ? [selected] : [];
      loadNativeImages(paths.map((path) => nativeFileFromPath(path)));
    } catch (error) {
      console.error(error);
    }
    return;
  }

  if (!window.showOpenFilePicker) {
    elements.fileInput?.click();
    return;
  }

  try {
    const handles = await window.showOpenFilePicker({
      multiple: true,
      types: [
        {
          description: "Images",
          accept: {
            "image/*": [".jpg", ".jpeg", ".png", ".webp", ".gif", ".avif", ".heic", ".heif"],
          },
        },
      ],
    });
    const files = await Promise.all(handles.map(async (handle) => ({
      file: await handle.getFile(),
      path: handle.name,
    })));
    loadPickedFiles(files);
  } catch (error) {
    if (!isAbortError(error)) console.error(error);
  }
}

function handleFileSelection(event: Event) {
  const input = event.currentTarget;
  if (!(input instanceof HTMLInputElement) || !input.files) return;

  loadPickedFiles([...input.files].map((file) => ({
    file,
    path: file.webkitRelativePath || file.name,
  })));
  input.value = "";
}

function loadPickedFiles(pickedFiles: PickedFile[]) {
  clearObjectUrls();
  const rawByBase = rawExtensionsByBase(pickedFiles.map(({ path }) => path));
  const files = pickedFiles.filter(({ file }) => isSupportedImage(file));
  files.sort(comparePickedFiles);

  state.images = files.map(({ file, path }, index) => ({
    id: `${path}-${file.size}-${file.lastModified}-${index}`,
    file,
    name: file.name,
    path,
    size: file.size,
    modifiedAt: file.lastModified,
    url: URL.createObjectURL(file),
    cacheLoaded: false,
    exifLoaded: false,
    rawExtensions: rawByBase.get(baseKeyForPath(path)) ?? [],
  }));
  state.activeIndex = 0;
  state.activeSlot = 0;
  state.compareSlots = [0, null, null, null];
  refillEmptySlots();
  fitView();
  render();
}

function loadNativeImages(nativeImages: NativeImageFile[]) {
  clearObjectUrls();
  const rawByBase = rawExtensionsByBase(nativeImages.map((image) => image.path));
  const images = nativeImages.filter((image) => (image.kind ?? "image") === "image" && isSupportedImagePath(image.path));
  images.sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true, sensitivity: "base" }));

  state.images = images.map((image, index) => ({
    id: `${image.path}-${image.size}-${image.modified_at}-${index}`,
    name: image.name,
    path: image.path,
    size: image.size,
    modifiedAt: image.modified_at,
    url: convertFileSrc(image.path),
    cacheLoaded: false,
    exifLoaded: false,
    rawExtensions: rawByBase.get(baseKeyForPath(image.path)) ?? [],
  }));
  state.activeIndex = 0;
  state.activeSlot = 0;
  state.compareSlots = [0, null, null, null];
  refillEmptySlots();
  fitView();
  render();
}

function nativeFileFromPath(path: string): NativeImageFile {
  return {
    path,
    name: path.split(/[\\/]/).pop() ?? path,
    size: 0,
    modified_at: 0,
  };
}

function clearObjectUrls() {
  for (const image of state.images) URL.revokeObjectURL(image.url);
}

function isSupportedImage(file: File) {
  const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
  return supportedExtensions.has(extension) || file.type.startsWith("image/");
}

function isSupportedImagePath(path: string) {
  const extension = path.split(".").pop()?.toLowerCase() ?? "";
  return supportedExtensions.has(extension);
}

function isRawImagePath(path: string) {
  const extension = path.split(".").pop()?.toLowerCase() ?? "";
  return rawExtensions.has(extension);
}

function rawExtensionsByBase(paths: string[]) {
  const map = new Map<string, string[]>();
  for (const path of paths) {
    if (!isRawImagePath(path)) continue;
    const key = baseKeyForPath(path);
    const extension = path.split(".").pop()?.toUpperCase();
    if (!extension) continue;
    const values = map.get(key) ?? [];
    if (!values.includes(extension)) values.push(extension);
    map.set(key, values);
  }
  return map;
}

function baseKeyForPath(path: string) {
  const separatorIndex = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  const directory = separatorIndex >= 0 ? path.slice(0, separatorIndex + 1) : "";
  const filename = separatorIndex >= 0 ? path.slice(separatorIndex + 1) : path;
  const dotIndex = filename.lastIndexOf(".");
  const basename = dotIndex >= 0 ? filename.slice(0, dotIndex) : filename;
  return `${directory}${basename}`.toLowerCase();
}

function comparePickedFiles(a: PickedFile, b: PickedFile) {
  return a.path.localeCompare(b.path, undefined, { numeric: true, sensitivity: "base" });
}

async function collectImageFiles(
  directory: FileSystemDirectoryHandle,
  prefix = "",
): Promise<PickedFile[]> {
  const files: PickedFile[] = [];

  for await (const [name, handle] of directory.entries()) {
    const path = prefix ? `${prefix}/${name}` : name;
    if (handle.kind === "directory") {
      files.push(...await collectImageFiles(handle, path));
    } else if (handle.kind === "file") {
      const file = await handle.getFile();
      if (isSupportedImage(file)) files.push({ file, path });
    }
  }

  return files;
}

function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === "AbortError";
}

function handleKeyDown(event: KeyboardEvent) {
  if (
    event.target instanceof HTMLInputElement ||
    event.target instanceof HTMLButtonElement
  ) return;

  if (event.key === "ArrowRight") {
    event.preventDefault();
    moveActive(1);
  } else if (event.key === "ArrowLeft") {
    event.preventDefault();
    moveActive(-1);
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    moveActive(-10);
  } else if (event.key === "ArrowDown") {
    event.preventDefault();
    moveActive(10);
  } else if (["1", "2", "3", "4"].includes(event.key)) {
    event.preventDefault();
    state.compareCount = Number(event.key);
    state.activeSlot = Math.min(state.activeSlot, state.compareCount - 1);
    refillEmptySlots();
    fitView();
    render();
  } else if (event.key.toLowerCase() === "f") {
    event.preventDefault();
    fitView();
    renderViewTransform();
    renderMeta();
  } else if (event.key === "0") {
    event.preventDefault();
    setZoom(1);
  } else if (event.key === "+" || event.key === "=") {
    event.preventDefault();
    setZoom(currentView().zoom * 1.16);
  } else if (event.key === "-" || event.key === "_") {
    event.preventDefault();
    setZoom(currentView().zoom / 1.16);
  } else if (event.key.toLowerCase() === "l") {
    event.preventDefault();
    toggleSyncView();
    render();
  } else if (event.key === "Escape") {
    state.mapOpen = false;
    clearSelection();
    renderMap();
  }
}

function handleGlobalKeyChange(event: KeyboardEvent) {
  if (event.key !== "Shift") return;
  elements.viewport?.classList.toggle("is-shift-select", event.type === "keydown");
}

function moveActive(delta: number) {
  if (!state.images.length) return;
  const nextIndex = Math.max(0, Math.min(state.images.length - 1, state.activeIndex + delta));
  if (nextIndex === state.activeIndex) return;
  state.activeIndex = nextIndex;
  state.activeSlot = 0;
  state.compareSlots[0] = nextIndex;
  fitView();
  render();
}

function handleWheel(event: WheelEvent) {
  if (!state.images.length) return;
  event.preventDefault();
  const direction = event.deltaY > 0 ? -1 : 1;
  const multiplier = direction > 0 ? 1.12 : 1 / 1.12;
  setZoom(currentView().zoom * multiplier);
}

function handlePointerDown(event: PointerEvent) {
  if (!state.images.length || !elements.viewport) return;
  const pane = (event.target as Element | null)?.closest<HTMLElement>(".image-pane");
  if (!pane || pane.classList.contains("is-empty")) return;

  state.activeSlot = Number(pane.dataset.slot ?? 0);
  const imageIndex = state.compareSlots[state.activeSlot];
  if (imageIndex !== null) state.activeIndex = imageIndex;
  if (event.shiftKey) {
    startSelection(event);
    return;
  }

  const view = currentView();
  state.isDragging = true;
  state.dragStartX = event.clientX;
  state.dragStartY = event.clientY;
  state.dragBaseX = view.offsetX;
  state.dragBaseY = view.offsetY;
  elements.viewport.setPointerCapture(event.pointerId);
  elements.viewport.classList.add("is-dragging");
  renderPaneSelection();
}

function handlePointerMove(event: PointerEvent) {
  if (state.isSelecting) {
    updateSelection(event);
    return;
  }
  if (!state.isDragging) return;
  updateCurrentView({
    ...currentView(),
    offsetX: state.dragBaseX + event.clientX - state.dragStartX,
    offsetY: state.dragBaseY + event.clientY - state.dragStartY,
  });
  renderViewTransform();
}

function endDrag(event: PointerEvent) {
  if (state.isSelecting) {
    finishSelection(event);
    return;
  }
  if (!state.isDragging || !elements.viewport) return;
  state.isDragging = false;
  if (elements.viewport.hasPointerCapture(event.pointerId)) {
    elements.viewport.releasePointerCapture(event.pointerId);
  }
  elements.viewport.classList.remove("is-dragging");
}

function startSelection(event: PointerEvent) {
  if (!elements.viewport) return;
  clearSelection();
  const bounds = elements.viewport.getBoundingClientRect();
  state.isSelecting = true;
  state.selectionStartX = event.clientX - bounds.left;
  state.selectionStartY = event.clientY - bounds.top;
  state.selectionRect = {
    left: state.selectionStartX,
    top: state.selectionStartY,
    width: 0,
    height: 0,
  };
  elements.viewport.setPointerCapture(event.pointerId);
  elements.viewport.classList.add("is-selecting");
  renderSelection();
}

function updateSelection(event: PointerEvent) {
  if (!elements.viewport) return;
  const bounds = elements.viewport.getBoundingClientRect();
  const currentX = clamp(event.clientX - bounds.left, 0, bounds.width);
  const currentY = clamp(event.clientY - bounds.top, 0, bounds.height);
  const left = Math.min(state.selectionStartX, currentX);
  const top = Math.min(state.selectionStartY, currentY);
  state.selectionRect = {
    left,
    top,
    width: Math.abs(currentX - state.selectionStartX),
    height: Math.abs(currentY - state.selectionStartY),
  };
  renderSelection();
}

function finishSelection(event: PointerEvent) {
  if (!elements.viewport) return;
  state.isSelecting = false;
  if (elements.viewport.hasPointerCapture(event.pointerId)) {
    elements.viewport.releasePointerCapture(event.pointerId);
  }
  elements.viewport.classList.remove("is-selecting");
  if (!state.selectionRect || state.selectionRect.width < 8 || state.selectionRect.height < 8) {
    clearSelection();
    return;
  }
  renderSelection();
}

function renderSelection() {
  const rect = state.selectionRect;
  if (!rect || !elements.selectionBox || !elements.cropActions) return;

  Object.assign(elements.selectionBox.style, {
    left: `${rect.left}px`,
    top: `${rect.top}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
  });
  elements.selectionBox.hidden = false;

  const actionLeft = Math.max(8, rect.left);
  const actionTop = Math.max(8, rect.top - 44);
  Object.assign(elements.cropActions.style, {
    left: `${actionLeft}px`,
    top: `${actionTop}px`,
  });
  elements.cropActions.hidden = state.isSelecting || rect.width < 8 || rect.height < 8;
}

function clearSelection() {
  state.isSelecting = false;
  state.selectionRect = null;
  elements.viewport?.classList.remove("is-selecting");
  if (elements.selectionBox) elements.selectionBox.hidden = true;
  if (elements.cropActions) elements.cropActions.hidden = true;
  setCropStatus("");
}

async function openCropSearch(target: "lens" | "ai") {
  const url = target === "lens"
    ? "https://lens.google.com/upload"
    : "https://www.google.com/search?udm=50&q=%E3%81%93%E3%81%AE%E7%94%9F%E3%81%8D%E7%89%A9%E3%81%AE%E7%A8%AE%E5%90%8D%E3%82%92%E5%90%8C%E5%AE%9A%E3%81%97%E3%81%A6%E3%80%81%E5%80%99%E8%A3%9C%E3%81%A8%E6%A0%B9%E6%8B%A0%E3%82%92%E6%97%A5%E6%9C%AC%E8%AA%9E%E3%81%A7%E8%AA%AC%E6%98%8E%E3%81%97%E3%81%A6";
  setCropStatus(target === "lens" ? "Lensを開きます" : "AI Modeを開きます");
  openExternalUrl(url).catch((error) => {
    console.error(error);
    setCropStatus("ブラウザ起動失敗");
  });

  try {
    setCropStatus("切り出し中");
    const crop = await createCropImage();
    const copied = await tryCopyBlobToClipboard(crop.blob);
    setCropStatus(copied ? "コピー済み。⌘Vで貼付" : "一時保存済み。手動で選択");
    if (!copied && crop.path) await revealSavedCrop(crop.path);
    if (crop.path) console.info(`Saved crop: ${crop.path}`);
  } catch (error) {
    console.error(error);
    setCropStatus("失敗");
  }
}

async function revealCropInFinder() {
  try {
    setCropStatus("切り出し中");
    const crop = await createCropImage();
    if (!crop.path) {
      setCropStatus("Tauri版のみ");
      return;
    }
    const directory = await openCropDirectory();
    setCropStatus(`保存先を表示: ${directory}`);
  } catch (error) {
    console.error(error);
    setCropStatus("Finder表示失敗");
  }
}

async function copyCropToClipboard() {
  try {
    setCropStatus("切り出し中");
    const crop = await createCropImage();
    await copyBlobToClipboard(crop.blob);
    setCropStatus("コピー済み");
    if (crop.path) console.info(`Saved crop: ${crop.path}`);
  } catch (error) {
    console.error(error);
    setCropStatus("コピー失敗");
  }
}

async function createCropImage(): Promise<SavedCrop> {
  const image = activeImage();
  const rect = state.selectionRect;
  const pane = document.querySelector<HTMLElement>(`.image-pane[data-slot="${state.activeSlot}"]`);
  const img = pane?.querySelector<HTMLImageElement>(".view-image");
  if (!image || !image.width || !image.height) {
    throw new Error("切り出す画像がありません。");
  }

  const source = await loadCanvasImage(image.url);
  const crop = rect && pane && img
    ? selectionToImageRect(rect, pane, image)
    : { left: 0, top: 0, width: image.width, height: image.height };
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(crop.width));
  canvas.height = Math.max(1, Math.round(crop.height));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvasを作成できません。");
  context.drawImage(
    source,
    crop.left,
    crop.top,
    crop.width,
    crop.height,
    0,
    0,
    canvas.width,
    canvas.height,
  );

  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((value) => value ? resolve(value) : reject(new Error("画像の切り出しに失敗しました。")), "image/png");
  });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const path = isTauriRuntime()
    ? await invoke<string>("save_crop_image", { image: { bytes: Array.from(bytes) } })
    : undefined;
  if (path) setCropStatus(`保存済み: ${path}`);
  return { blob, bytes, path };
}

function selectionToImageRect(rect: CropRect, pane: HTMLElement, image: ImageItem) {
  const paneBounds = pane.getBoundingClientRect();
  const viewerBounds = elements.viewport?.getBoundingClientRect();
  if (!viewerBounds) throw new Error("ビューアー領域がありません。");
  const view = currentView();
  const paneLeft = paneBounds.left - viewerBounds.left;
  const paneTop = paneBounds.top - viewerBounds.top;
  const centerX = paneLeft + paneBounds.width / 2 + view.offsetX;
  const centerY = paneTop + paneBounds.height / 2 + view.offsetY;
  const imageLeft = centerX - (image.width! * view.zoom) / 2;
  const imageTop = centerY - (image.height! * view.zoom) / 2;

  const left = clamp((rect.left - imageLeft) / view.zoom, 0, image.width!);
  const top = clamp((rect.top - imageTop) / view.zoom, 0, image.height!);
  const right = clamp((rect.left + rect.width - imageLeft) / view.zoom, 0, image.width!);
  const bottom = clamp((rect.top + rect.height - imageTop) / view.zoom, 0, image.height!);

  return {
    left,
    top,
    width: Math.max(1, right - left),
    height: Math.max(1, bottom - top),
  };
}

function loadCanvasImage(url: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("画像を読み込めません。"));
    img.src = url;
  });
}

async function copyBlobToClipboard(blob: Blob) {
  if (!navigator.clipboard || typeof ClipboardItem === "undefined") {
    throw new Error("この環境では画像のクリップボードコピーに対応していません。");
  }
  await navigator.clipboard.write([
    new ClipboardItem({ [blob.type]: blob }),
  ]);
}

async function tryCopyBlobToClipboard(blob: Blob) {
  try {
    await copyBlobToClipboard(blob);
    return true;
  } catch (error) {
    console.warn("Clipboard copy failed", error);
    return false;
  }
}

function setCropStatus(message: string) {
  if (elements.cropStatus) elements.cropStatus.textContent = message;
}

async function openExternalUrl(url: string) {
  if (isTauriRuntime()) {
    await invoke("open_external_url", { url });
  } else {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}

async function revealSavedCrop(path: string) {
  if (isTauriRuntime()) {
    await invoke("reveal_file", { path });
  }
}

async function openCropDirectory() {
  if (isTauriRuntime()) {
    return invoke<string>("open_crop_directory");
  }
  return "";
}

function setZoom(value: number) {
  state.fitMode = false;
  updateCurrentView({
    ...currentView(),
    zoom: Math.max(0.08, Math.min(12, value)),
  });
  renderViewTransform();
  renderMeta();
}

function fitView() {
  state.fitMode = true;
  const scale = fitScaleForActiveSlot();
  state.view.zoom = scale;
  state.view.offsetX = 0;
  state.view.offsetY = 0;
  state.slotViews = state.slotViews.map(() => ({
    zoom: scale,
    offsetX: 0,
    offsetY: 0,
  }));
}

function currentView() {
  return state.syncView ? state.view : state.slotViews[state.activeSlot] ?? state.slotViews[0];
}

function updateCurrentView(view: ViewState) {
  if (state.syncView) {
    state.view = view;
  } else {
    state.slotViews[state.activeSlot] = view;
  }
}

function toggleSyncView() {
  state.syncView = !state.syncView;
  if (state.syncView) {
    state.view = { ...currentView() };
  } else {
    state.slotViews = state.slotViews.map(() => ({ ...state.view }));
  }
}

function refillEmptySlots() {
  for (let slotIndex = 0; slotIndex < state.compareCount; slotIndex += 1) {
    const current = state.compareSlots[slotIndex];
    if (current !== null && current >= 0 && current < state.images.length) continue;
    const nextIndex = state.activeIndex + slotIndex;
    state.compareSlots[slotIndex] = nextIndex < state.images.length ? nextIndex : null;
  }
  for (let slotIndex = state.compareCount; slotIndex < state.compareSlots.length; slotIndex += 1) {
    state.compareSlots[slotIndex] = null;
  }
}

function activeImage() {
  return state.images[state.activeIndex];
}

function slotImage(slotIndex: number) {
  const imageIndex = state.compareSlots[slotIndex];
  return imageIndex === null ? null : state.images[imageIndex] ?? null;
}

function fitScaleForActiveSlot() {
  const image = slotImage(state.activeSlot) ?? activeImage();
  const pane = document.querySelector<HTMLElement>(`.image-pane[data-slot="${state.activeSlot}"]`)
    ?? elements.viewport;
  if (!image?.width || !image.height || !pane) return 1;

  const bounds = pane.getBoundingClientRect();
  const scale = Math.min(
    bounds.width / image.width,
    bounds.height / image.height,
  );
  return clamp(scale, 0.01, 12);
}

function preloadAroundActive() {
  if (!state.images.length) return;
  const radius = Math.max(0, Math.floor(state.preloadRadius));
  const start = Math.max(0, state.activeIndex - radius);
  const end = Math.min(state.images.length - 1, state.activeIndex + radius);
  for (let index = start; index <= end; index += 1) {
    loadImageInfo(state.images[index]);
  }
}

function loadImageInfo(image: ImageItem) {
  if (image.cacheLoaded) return image.cachePromise ?? Promise.resolve();
  if (image.cachePromise) return image.cachePromise;

  image.cachePromise = new Promise<void>((resolve) => {
    const img = new Image();
    img.decoding = "async";
    img.onload = async () => {
      image.width = img.naturalWidth;
      image.height = img.naturalHeight;
      try {
        await img.decode();
      } catch {
        // The image can still be usable even when decode() rejects for a browser-specific reason.
      }
      image.cacheLoaded = true;
      if (image === activeImage()) {
        if (state.fitMode) fitView();
        renderMeta();
        renderViewTransform();
      }
      resolve();
    };
    img.onerror = () => {
      image.cacheLoaded = true;
      resolve();
    };
    img.src = image.url;
  });

  return image.cachePromise;
}

function render() {
  renderChrome();
  renderCompareGrid();
  renderThumbs();
  renderMeta();
  renderMap();
  preloadAroundActive();
  loadExifForActiveImage();
}

function renderChrome() {
  const hasImages = state.images.length > 0;
  elements.emptyState?.toggleAttribute("hidden", hasImages);
  elements.compareGrid?.toggleAttribute("hidden", !hasImages);
  elements.prevButton?.toggleAttribute("disabled", !hasImages || state.activeIndex <= 0);
  elements.nextButton?.toggleAttribute("disabled", !hasImages || state.activeIndex >= state.images.length - 1);

  for (const button of elements.modeButtons) {
    const count = Number(button.dataset.compareCount ?? 1);
    button.setAttribute("aria-pressed", String(count === state.compareCount));
  }

  if (elements.syncButton) {
    elements.syncButton.setAttribute("aria-pressed", String(state.syncView));
    elements.syncButton.textContent = state.syncView ? "同期 ON" : "同期 OFF";
  }
}

function renderCompareGrid() {
  if (!elements.compareGrid) return;
  elements.compareGrid.className = `compare-grid compare-${state.compareCount}`;
  const panes = Array.from({ length: state.compareCount }, (_, slotIndex) => createPane(slotIndex));
  elements.compareGrid.replaceChildren(...panes);
  renderViewTransform();
  renderPaneSelection();
}

function createPane(slotIndex: number) {
  const image = slotImage(slotIndex);
  const pane = document.createElement("section");
  pane.className = image ? "image-pane" : "image-pane is-empty";
  pane.dataset.slot = String(slotIndex);
  pane.setAttribute("aria-label", `${slotIndex + 1}枚目`);
  pane.addEventListener("dragover", (event) => {
    event.preventDefault();
    pane.classList.add("is-drop-target");
  });
  pane.addEventListener("dragleave", () => pane.classList.remove("is-drop-target"));
  pane.addEventListener("drop", (event) => handlePaneDrop(event, slotIndex));
  pane.addEventListener("click", () => {
    state.activeSlot = slotIndex;
    const imageIndex = state.compareSlots[slotIndex];
    if (imageIndex !== null) state.activeIndex = imageIndex;
    renderPaneSelection();
    renderMeta();
    loadExifForActiveImage();
  });

  if (!image) {
    const empty = document.createElement("div");
    empty.className = "slot-empty";
    empty.textContent = "ここに画像をドロップ";
    pane.append(empty);
    return pane;
  }

  const img = document.createElement("img");
  img.className = "view-image";
  img.src = image.url;
  img.alt = image.name;
  img.draggable = false;
  if (image.width && image.height) {
    img.width = image.width;
    img.height = image.height;
  }
  img.addEventListener("load", () => {
    if (!image.width || !image.height) {
      image.width = img.naturalWidth;
      image.height = img.naturalHeight;
      if (state.fitMode) {
        fitView();
        renderViewTransform();
        renderMeta();
      }
    }
  }, { once: true });

  const badge = document.createElement("div");
  badge.className = "pane-badge";
  badge.textContent = `${state.compareSlots[slotIndex]! + 1} / ${state.images.length}`;

  const name = document.createElement("div");
  name.className = "pane-name";
  name.textContent = image.name;

  pane.append(img, badge, name);
  return pane;
}

function handlePaneDrop(event: DragEvent, slotIndex: number) {
  event.preventDefault();
  const index = Number(event.dataTransfer?.getData("text/plain") ?? Number.NaN);
  document.querySelectorAll(".image-pane").forEach((pane) => pane.classList.remove("is-drop-target"));
  if (!Number.isInteger(index) || index < 0 || index >= state.images.length) return;

  state.compareSlots[slotIndex] = index;
  state.activeSlot = slotIndex;
  state.activeIndex = index;
  fitView();
  render();
}

function renderThumbs() {
  if (!elements.thumbs) return;
  const fragment = document.createDocumentFragment();
  const preloadRadius = 120;

  state.images.forEach((image, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "thumb";
    button.draggable = true;
    button.dataset.index = String(index);
    button.setAttribute("aria-current", String(index === state.activeIndex));
    button.title = image.path;
    button.addEventListener("click", () => {
      state.activeIndex = index;
      state.activeSlot = 0;
      state.compareSlots[0] = index;
      fitView();
      render();
    });
    button.addEventListener("dragstart", (event) => {
      event.dataTransfer?.setData("text/plain", String(index));
      event.dataTransfer?.setDragImage(button, 48, 36);
    });

    if (Math.abs(index - state.activeIndex) <= preloadRadius) {
      const img = document.createElement("img");
      img.src = image.url;
      img.alt = "";
      img.loading = "lazy";
      img.draggable = false;
      button.append(img);
    }

    const indexLabel = document.createElement("span");
    indexLabel.textContent = String(index + 1);
    button.append(indexLabel);
    fragment.append(button);
  });

  elements.thumbs.replaceChildren(fragment);
  const activeThumb = elements.thumbs.querySelector<HTMLElement>('[aria-current="true"]');
  activeThumb?.scrollIntoView({ block: "nearest", inline: "nearest" });
}

function renderPaneSelection() {
  document.querySelectorAll<HTMLElement>(".image-pane").forEach((pane) => {
    pane.setAttribute("aria-current", String(Number(pane.dataset.slot ?? -1) === state.activeSlot));
  });
}

function renderViewTransform() {
  document.querySelectorAll<HTMLElement>(".view-image").forEach((image) => {
    const slotIndex = Number(image.closest<HTMLElement>(".image-pane")?.dataset.slot ?? 0);
    const view = state.syncView ? state.view : state.slotViews[slotIndex] ?? state.view;
    const transform = `translate(-50%, -50%) translate3d(${view.offsetX}px, ${view.offsetY}px, 0) scale(${view.zoom})`;
    image.style.transform = transform;
  });
  if (elements.zoomValue) {
    elements.zoomValue.textContent = `${Math.round(currentView().zoom * 100)}%`;
  }
}

function renderMeta() {
  const active = activeImage();
  if (elements.imageCount) {
    elements.imageCount.textContent = state.images.length
      ? `${state.activeIndex + 1} / ${state.images.length}`
      : "0 / 0";
  }
  if (elements.activeName) {
    elements.activeName.textContent = active?.name ?? "フォルダまたは画像を選択";
  }
  if (elements.activeMeta) {
    elements.activeMeta.textContent = active
      ? `${formatBytes(active.size)} / ${new Date(active.modifiedAt).toLocaleString()}`
      : "画像を読み込むとここにファイル情報が表示されます。";
  }
  if (elements.zoomValue) {
    elements.zoomValue.textContent = `${Math.round(currentView().zoom * 100)}%`;
  }
  if (elements.exifText) {
    elements.exifText.textContent = active
      ? exifLineForImage(active)
      : "EXIF情報";
  }
  renderGps(active?.exif ?? null);
}

function exifLineForImage(image: ImageItem) {
  const dimensions = formatImageDimensions(image);
  const raw = image.rawExtensions.length ? `RAWあり: ${image.rawExtensions.join(", ")}` : null;
  const exifLine = image.exifLoaded ? image.exif?.line ?? "EXIFなし" : "EXIF読み込み中";
  return [dimensions, raw, exifLine].filter(Boolean).join(" / ");
}

function formatImageDimensions(image: ImageItem) {
  return image.width && image.height ? `${image.width} x ${image.height}px` : "ピクセル数読み込み中";
}

function renderGps(exif: ExifSummary | null) {
  const gps = exif?.gps;
  if (elements.gpsText) {
    elements.gpsText.textContent = gps
      ? `撮影場所 ${gps.latitude.toFixed(6)}, ${gps.longitude.toFixed(6)}`
      : "GPSなし";
  }
  elements.mapButton?.toggleAttribute("hidden", !gps);
  if (!gps) state.mapOpen = false;
}

function renderMap() {
  const gps = activeImage()?.exif?.gps;
  const showMap = Boolean(state.mapOpen && gps);
  elements.mapPanel?.toggleAttribute("hidden", !showMap);
  if (elements.mapButton) {
    elements.mapButton.setAttribute("aria-pressed", String(showMap));
  }
  if (showMap && gps && elements.mapFrame) {
    const delta = 0.006;
    const bbox = [
      gps.longitude - delta,
      gps.latitude - delta,
      gps.longitude + delta,
      gps.latitude + delta,
    ].join(",");
    elements.mapFrame.src =
      `https://www.openstreetmap.org/export/embed.html?bbox=${bbox}&layer=mapnik&marker=${gps.latitude},${gps.longitude}`;
  } else if (elements.mapFrame) {
    elements.mapFrame.removeAttribute("src");
  }
}

async function loadExifForActiveImage() {
  const image = activeImage();
  if (!image || image.exifLoaded) return;

  try {
    const source = image.file ?? await fetchImageBlob(image.url);
    const metadata = await exifr.parse(source, {
      tiff: true,
      exif: true,
      gps: true,
      mergeOutput: true,
      translateValues: false,
    });
    image.exif = summarizeExif(metadata);
  } catch {
    image.exif = null;
  } finally {
    image.exifLoaded = true;
    if (image === activeImage()) {
      renderMeta();
      renderMap();
    }
  }
}

async function fetchImageBlob(url: string) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to read image: ${response.status}`);
  return response.blob();
}

function summarizeExif(metadata: Record<string, unknown> | undefined): ExifSummary | null {
  if (!metadata) return null;

  const capturedAt = asDate(metadata.DateTimeOriginal) ?? asDate(metadata.CreateDate) ?? asDate(metadata.ModifyDate);
  const make = asString(metadata.Make);
  const model = asString(metadata.Model);
  const camera = [make, model].filter(Boolean).join(" ");
  const lens = asString(metadata.LensModel) ?? asString(metadata.Lens);
  const focalLength = formatFocalLength(metadata.FocalLength);
  const aperture = formatAperture(metadata.FNumber ?? metadata.ApertureValue);
  const shutterSpeed = formatShutterSpeed(metadata.ExposureTime ?? metadata.ShutterSpeedValue);
  const iso = asNumber(metadata.ISO) ?? asNumber(metadata.ISOSpeedRatings);
  const latitude = asNumber(metadata.latitude ?? metadata.GPSLatitude);
  const longitude = asNumber(metadata.longitude ?? metadata.GPSLongitude);

  const parts = [
    capturedAt ? formatDateTime(capturedAt) : null,
    camera || null,
    lens,
    focalLength,
    aperture,
    shutterSpeed,
    iso ? `ISO ${iso}` : null,
  ].filter(Boolean) as string[];

  return {
    line: parts.length ? parts.join(" / ") : "EXIFなし",
    capturedAt,
    camera: camera || undefined,
    lens: lens || undefined,
    focalLength: focalLength || undefined,
    aperture: aperture || undefined,
    shutterSpeed: shutterSpeed || undefined,
    iso: iso ? `ISO ${iso}` : undefined,
    gps: latitude !== undefined && longitude !== undefined ? { latitude, longitude } : undefined,
  };
}

function asString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asDate(value: unknown) {
  return value instanceof Date && !Number.isNaN(value.getTime()) ? value : undefined;
}

function formatDateTime(date: Date) {
  return new Intl.DateTimeFormat("ja-JP", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(date);
}

function formatFocalLength(value: unknown) {
  const number = asNumber(value);
  return number ? `${trimNumber(number)}mm` : undefined;
}

function formatAperture(value: unknown) {
  const number = asNumber(value);
  return number ? `F${trimNumber(number)}` : undefined;
}

function formatShutterSpeed(value: unknown) {
  const number = asNumber(value);
  if (!number) return undefined;
  if (number >= 1) return `${trimNumber(number)}s`;
  return `1/${Math.round(1 / number)}`;
}

function trimNumber(value: number) {
  return Number.isInteger(value) ? String(value) : value.toFixed(1).replace(/\.0$/, "");
}

function clamp(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function formatBytes(bytes: number) {
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}
