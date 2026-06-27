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
  thumbnailUrl?: string;
  thumbnailLoaded: boolean;
  thumbnailRequested: boolean;
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

type RenameResult = {
  old_path: string;
  path: string;
  name: string;
  size: number;
  modified_at: number;
};

type MoveToDeletedResult = {
  old_path: string;
  deleted_path: string;
};

type ThumbnailCacheResult = {
  total: number;
  created: number;
  reused: number;
  failed: number;
  deleted: number;
};

type FontSizeMode = "small" | "medium" | "large";

type CropRect = {
  left: number;
  top: number;
  width: number;
  height: number;
};

type CropAspect = "free" | "1:1" | "3:2" | "4:3";
type SelectionResizeHandle = "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | "nw";

type PerfStats = {
  scanMs: number | null;
  listMs: number | null;
  renderMs: number | null;
  imageMs: number | null;
  exifMs: number | null;
  thumbLastMs: number | null;
  thumbAvgMs: number | null;
  thumbCount: number;
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

const thumbnailMaxEdge = 192;
const thumbnailConcurrency = 1;
const thumbnailBackgroundDelayMs = 900;
const thumbnailPruneInterval = 64;
const maxInitialImagePreloadRadius = 1;
const maxInitialThumbnailPreloadRadius = 24;
const visibleThumbnailBuffer = 4;
const thumbnailBackgroundBatchLimit = 12;
const exifDelayMs = 900;
const thumbItemWidth = 102;
let thumbnailQueue: number[] = [];
let activeThumbnailJobs = 0;
let thumbnailScrollFrame = 0;
let thumbnailPreloadTimer = 0;
let thumbnailRequestsSincePrune = 0;
let exifTimer = 0;
const perf: PerfStats = {
  scanMs: null,
  listMs: null,
  renderMs: null,
  imageMs: null,
  exifMs: null,
  thumbLastMs: null,
  thumbAvgMs: null,
  thumbCount: 0,
};

function isTauriRuntime() {
  return "__TAURI_INTERNALS__" in window;
}

function normalizeFontSizeMode(value: string | undefined): FontSizeMode {
  return value === "medium" || value === "large" ? value : "small";
}

function normalizeCropAspect(value: string | undefined): CropAspect {
  return value === "1:1" || value === "3:2" || value === "4:3" ? value : "free";
}

function cropAspectRatio() {
  switch (state.cropAspect) {
    case "1:1":
      return 1;
    case "3:2":
      return 3 / 2;
    case "4:3":
      return 4 / 3;
    default:
      return null;
  }
}

function applyFontSizeMode() {
  const addPx = state.fontSizeMode === "large"
    ? 6
    : state.fontSizeMode === "medium"
      ? 3
      : 0;
  document.documentElement.style.setProperty("--font-size-add", `${addPx}px`);
}

const state = {
  images: [] as ImageItem[],
  filteredIndexes: [] as number[],
  filenameFilter: "",
  activeIndex: 0,
  compareCount: 1,
  compareSlots: [0, null, null, null] as Array<number | null>,
  preloadRadius: Math.min(
    Number(localStorage.getItem("digiviewer.preloadRadius") ?? 1),
    maxInitialImagePreloadRadius,
  ),
  thumbPreloadRadius: Math.min(
    Number(localStorage.getItem("digiviewer.thumbPreloadRadius") ?? 12),
    maxInitialThumbnailPreloadRadius,
  ),
  thumbCacheLimitMb: Number(localStorage.getItem("digiviewer.thumbCacheLimitMb") ?? 1024),
  perfVisible: localStorage.getItem("digiviewer.perfVisible") !== "false",
  fontSizeMode: normalizeFontSizeMode(localStorage.getItem("digiviewer.fontSizeMode") ?? "small"),
  fitMode: true,
  syncView: true,
  activeSlot: 0,
  isDragging: false,
  isSelecting: false,
  isMovingSelection: false,
  isResizingSelection: false,
  selectionStartX: 0,
  selectionStartY: 0,
  selectionRect: null as CropRect | null,
  selectionMoveStartRect: null as CropRect | null,
  selectionMoveStartX: 0,
  selectionMoveStartY: 0,
  selectionResizeHandle: null as SelectionResizeHandle | null,
  selectionResizeStartRect: null as CropRect | null,
  selectionResizeStartX: 0,
  selectionResizeStartY: 0,
  cropAspect: "free" as CropAspect,
  cropUpscale2x: false,
  dragStartX: 0,
  dragStartY: 0,
  dragBaseX: 0,
  dragBaseY: 0,
  mapOpen: false,
  checkedIndexes: new Set<number>(),
  lastCheckedIndex: null as number | null,
  currentDirectory: "",
  isBuildingThumbCache: false,
  thumbCacheStatus: "",
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
  cropSaveButton: document.querySelector<HTMLButtonElement>("#crop-save"),
  cropAspectSelect: document.querySelector<HTMLSelectElement>("#crop-aspect"),
  cropUpscaleInput: document.querySelector<HTMLInputElement>("#crop-upscale"),
  cropCancelButton: document.querySelector<HTMLButtonElement>("#crop-cancel"),
  thumbs: document.querySelector<HTMLElement>("#thumbs"),
  emptyState: document.querySelector<HTMLElement>("#empty-state"),
  appVersion: document.querySelector<HTMLElement>("#app-version"),
  imageCount: document.querySelector<HTMLElement>("#image-count"),
  activeName: document.querySelector<HTMLElement>("#active-name"),
  activeMeta: document.querySelector<HTMLElement>("#active-meta"),
  perfMeter: document.querySelector<HTMLElement>("#perf-meter"),
  zoomValue: document.querySelector<HTMLElement>("#zoom-value"),
  filenameFilterInput: document.querySelector<HTMLInputElement>("#filename-filter"),
  preloadRadiusInput: document.querySelector<HTMLInputElement>("#preload-radius"),
  thumbPreloadRadiusInput: document.querySelector<HTMLInputElement>("#thumb-preload-radius"),
  thumbCacheLimitInput: document.querySelector<HTMLInputElement>("#thumb-cache-limit"),
  perfVisibleInput: document.querySelector<HTMLInputElement>("#perf-visible"),
  fontSizeModeSelect: document.querySelector<HTMLSelectElement>("#font-size-mode"),
  exifText: document.querySelector<HTMLElement>("#exif-text"),
  gpsText: document.querySelector<HTMLElement>("#gps-text"),
  mapButton: document.querySelector<HTMLButtonElement>("#map-button"),
  selectionCount: document.querySelector<HTMLElement>("#selection-count"),
  appendSpeciesButton: document.querySelector<HTMLButtonElement>("#append-species"),
  copyFilesButton: document.querySelector<HTMLButtonElement>("#copy-files"),
  moveDeletedButton: document.querySelector<HTMLButtonElement>("#move-deleted"),
  clearSelectionButton: document.querySelector<HTMLButtonElement>("#clear-file-selection"),
  buildThumbCacheButton: document.querySelector<HTMLButtonElement>("#build-thumb-cache"),
  cleanThumbCacheButton: document.querySelector<HTMLButtonElement>("#clean-thumb-cache"),
  clearThumbCacheButton: document.querySelector<HTMLButtonElement>("#clear-thumb-cache"),
  thumbCacheStatus: document.querySelector<HTMLElement>("#thumb-cache-status"),
  settingsButton: document.querySelector<HTMLButtonElement>("#settings-button"),
  settingsDialog: document.querySelector<HTMLElement>("#settings-dialog"),
  settingsCloseButton: document.querySelector<HTMLButtonElement>("#settings-close"),
  speciesDialog: document.querySelector<HTMLElement>("#species-dialog"),
  speciesDialogMessage: document.querySelector<HTMLElement>("#species-dialog-message"),
  speciesNameInput: document.querySelector<HTMLInputElement>("#species-name-input"),
  speciesOkButton: document.querySelector<HTMLButtonElement>("#species-ok"),
  speciesCancelButton: document.querySelector<HTMLButtonElement>("#species-cancel"),
  mapPanel: document.querySelector<HTMLElement>("#map-panel"),
  mapFrame: document.querySelector<HTMLIFrameElement>("#map-frame"),
  mapCloseButton: document.querySelector<HTMLButtonElement>("#map-close"),
  modeButtons: document.querySelectorAll<HTMLButtonElement>("[data-compare-count]"),
  syncButton: document.querySelector<HTMLButtonElement>("#sync-toggle"),
  fitButton: document.querySelector<HTMLButtonElement>("#fit-button"),
  actualButton: document.querySelector<HTMLButtonElement>("#actual-button"),
  prevButton: document.querySelector<HTMLButtonElement>("#prev-button"),
  nextButton: document.querySelector<HTMLButtonElement>("#next-button"),
  viewerPrevButton: document.querySelector<HTMLButtonElement>("#viewer-prev-button"),
  viewerNextButton: document.querySelector<HTMLButtonElement>("#viewer-next-button"),
};

window.addEventListener("DOMContentLoaded", () => {
  applyFontSizeMode();
  ensureCropDirectory();
  loadAppVersion();
  elements.chooseFolderButton?.addEventListener("click", openFolder);
  elements.chooseFilesButton?.addEventListener("click", openFiles);
  elements.openInput?.addEventListener("change", handleFileSelection);
  elements.fileInput?.addEventListener("change", handleFileSelection);
  elements.filenameFilterInput?.addEventListener("input", () => {
    state.filenameFilter = elements.filenameFilterInput?.value ?? "";
    applyFilenameFilter();
  });
  if (elements.preloadRadiusInput) {
    elements.preloadRadiusInput.value = String(state.preloadRadius);
    elements.preloadRadiusInput.addEventListener("change", () => {
      state.preloadRadius = clamp(Number(elements.preloadRadiusInput?.value ?? 0), 0, 50);
      localStorage.setItem("digiviewer.preloadRadius", String(state.preloadRadius));
      preloadAroundActive();
    });
  }
  if (elements.thumbPreloadRadiusInput) {
    elements.thumbPreloadRadiusInput.value = String(state.thumbPreloadRadius);
    elements.thumbPreloadRadiusInput.addEventListener("change", () => {
      state.thumbPreloadRadius = clamp(Number(elements.thumbPreloadRadiusInput?.value ?? 0), 0, 1000);
      localStorage.setItem("digiviewer.thumbPreloadRadius", String(state.thumbPreloadRadius));
      preloadVisibleThumbnails();
      scheduleThumbnailPreload();
      renderThumbs();
    });
  }
  if (elements.thumbCacheLimitInput) {
    elements.thumbCacheLimitInput.value = String(state.thumbCacheLimitMb);
    elements.thumbCacheLimitInput.addEventListener("change", () => {
      state.thumbCacheLimitMb = clamp(Number(elements.thumbCacheLimitInput?.value ?? 0), 64, 10240);
      localStorage.setItem("digiviewer.thumbCacheLimitMb", String(state.thumbCacheLimitMb));
      scheduleThumbnailPreload();
    });
  }
  if (elements.perfVisibleInput) {
    elements.perfVisibleInput.checked = state.perfVisible;
    elements.perfVisibleInput.addEventListener("change", () => {
      state.perfVisible = Boolean(elements.perfVisibleInput?.checked);
      localStorage.setItem("digiviewer.perfVisible", String(state.perfVisible));
      renderPerfMeter();
    });
  }
  if (elements.fontSizeModeSelect) {
    elements.fontSizeModeSelect.value = state.fontSizeMode;
    elements.fontSizeModeSelect.addEventListener("change", () => {
      state.fontSizeMode = normalizeFontSizeMode(elements.fontSizeModeSelect?.value);
      localStorage.setItem("digiviewer.fontSizeMode", state.fontSizeMode);
      applyFontSizeMode();
    });
  }
  elements.viewport?.addEventListener("wheel", handleWheel, { passive: false });
  elements.viewport?.addEventListener("pointerdown", handlePointerDown);
  elements.viewport?.addEventListener("pointermove", handlePointerMove);
  elements.viewport?.addEventListener("pointerup", endDrag);
  elements.viewport?.addEventListener("pointercancel", endDrag);
  elements.selectionBox?.addEventListener("pointerdown", startSelectionMove);
  elements.cropActions?.addEventListener("pointerdown", (event) => event.stopPropagation());
  elements.cropSaveButton?.addEventListener("click", (event) => {
    event.stopPropagation();
    saveCropToSourceFolder();
  });
  elements.cropAspectSelect?.addEventListener("change", () => {
    state.cropAspect = normalizeCropAspect(elements.cropAspectSelect?.value);
    if (state.selectionRect && !state.isSelecting) {
      applyCropAspectToSelection();
      renderSelection();
    }
  });
  elements.cropUpscaleInput?.addEventListener("change", () => {
    state.cropUpscale2x = Boolean(elements.cropUpscaleInput?.checked);
  });
  elements.cropCancelButton?.addEventListener("click", (event) => {
    event.stopPropagation();
    clearSelection();
  });
  window.addEventListener("keydown", handleGlobalKeyChange);
  window.addEventListener("keyup", handleGlobalKeyChange);

  elements.prevButton?.addEventListener("click", () => moveActive(-1));
  elements.nextButton?.addEventListener("click", () => moveActive(1));
  elements.viewerPrevButton?.addEventListener("click", () => moveActive(-1));
  elements.viewerNextButton?.addEventListener("click", () => moveActive(1));
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
  elements.appendSpeciesButton?.addEventListener("click", appendSpeciesNameToCheckedImages);
  elements.copyFilesButton?.addEventListener("click", copyCheckedFiles);
  elements.moveDeletedButton?.addEventListener("click", moveCheckedImagesToDeleted);
  elements.buildThumbCacheButton?.addEventListener("click", buildAllThumbnailCache);
  elements.cleanThumbCacheButton?.addEventListener("click", cleanThumbnailCache);
  elements.clearThumbCacheButton?.addEventListener("click", clearThumbnailCache);
  elements.settingsButton?.addEventListener("click", openSettings);
  elements.settingsCloseButton?.addEventListener("click", closeSettings);
  elements.settingsDialog?.addEventListener("click", (event) => {
    if (event.target === elements.settingsDialog) closeSettings();
  });
  elements.clearSelectionButton?.addEventListener("click", () => {
    clearCheckedImages();
    renderThumbs();
    renderChrome();
  });
  elements.mapCloseButton?.addEventListener("click", () => {
    state.mapOpen = false;
    renderMap();
  });
  elements.thumbs?.parentElement?.addEventListener("scroll", () => {
    if (thumbnailScrollFrame) return;
    thumbnailScrollFrame = window.requestAnimationFrame(() => {
      thumbnailScrollFrame = 0;
      preloadVisibleThumbnails();
    });
  });
  elements.syncButton?.addEventListener("click", () => {
    toggleSyncView();
    render();
  });

  for (const button of elements.modeButtons) {
    button.addEventListener("click", () => {
      setCompareCount(Number(button.dataset.compareCount ?? 1));
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

async function loadAppVersion() {
  if (!elements.appVersion || !isTauriRuntime()) return;
  try {
    const version = await invoke<string>("app_version");
    elements.appVersion.textContent = `v${version}`;
  } catch (error) {
    console.warn("Failed to load app version", error);
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
      const scanStart = performance.now();
      const images = await invoke<NativeImageFile[]>("scan_images", { directory: selected });
      perf.scanMs = performance.now() - scanStart;
      state.currentDirectory = selected;
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
  const listStart = performance.now();
  perf.scanMs = null;
  state.currentDirectory = "";
  state.thumbCacheStatus = "";
  state.filenameFilter = "";
  if (elements.filenameFilterInput) elements.filenameFilterInput.value = "";
  resetThumbnailPerf();
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
    thumbnailUrl: URL.createObjectURL(file),
    thumbnailLoaded: true,
    thumbnailRequested: true,
    cacheLoaded: false,
    exifLoaded: false,
    rawExtensions: rawByBase.get(baseKeyForPath(path)) ?? [],
  }));
  updateFilteredIndexes();
  state.activeIndex = 0;
  state.activeSlot = 0;
  state.compareSlots = [0, null, null, null];
  clearCheckedImages();
  resetThumbnailQueue();
  refillEmptySlots();
  fitView();
  perf.listMs = performance.now() - listStart;
  render();
}

function loadNativeImages(nativeImages: NativeImageFile[]) {
  const listStart = performance.now();
  resetThumbnailPerf();
  state.filenameFilter = "";
  if (elements.filenameFilterInput) elements.filenameFilterInput.value = "";
  clearObjectUrls();
  const rawByBase = rawExtensionsByBase(nativeImages.map((image) => image.path));
  const images = nativeImages.filter((image) =>
    (image.kind ?? "image") === "image"
    && isSupportedImagePath(image.path)
    && !isDigiViewerCachePath(image.path)
  );
  images.sort((a, b) => compareImagePaths(a.path, b.path));

  state.images = images.map((image, index) => ({
    id: `${image.path}-${image.size}-${image.modified_at}-${index}`,
    name: image.name,
    path: image.path,
    size: image.size,
    modifiedAt: image.modified_at,
    url: convertFileSrc(image.path),
    thumbnailLoaded: false,
    thumbnailRequested: false,
    cacheLoaded: false,
    exifLoaded: false,
    rawExtensions: rawByBase.get(baseKeyForPath(image.path)) ?? [],
  }));
  updateFilteredIndexes();
  state.activeIndex = 0;
  state.activeSlot = 0;
  state.compareSlots = [0, null, null, null];
  clearCheckedImages();
  resetThumbnailQueue();
  refillEmptySlots();
  fitView();
  perf.listMs = performance.now() - listStart;
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
  for (const image of state.images) {
    if (image.file) {
      URL.revokeObjectURL(image.url);
      if (image.thumbnailUrl && image.thumbnailUrl !== image.url) {
        URL.revokeObjectURL(image.thumbnailUrl);
      }
    }
  }
}

function resetThumbnailQueue() {
  thumbnailQueue = [];
  activeThumbnailJobs = 0;
  thumbnailRequestsSincePrune = 0;
  if (exifTimer) {
    window.clearTimeout(exifTimer);
    exifTimer = 0;
  }
  if (thumbnailPreloadTimer) {
    window.clearTimeout(thumbnailPreloadTimer);
    thumbnailPreloadTimer = 0;
  }
}

function resetThumbnailPerf() {
  perf.thumbLastMs = null;
  perf.thumbAvgMs = null;
  perf.thumbCount = 0;
}

function clearCheckedImages() {
  state.checkedIndexes.clear();
  state.lastCheckedIndex = null;
}

function checkedImages() {
  return [...state.checkedIndexes]
    .sort((a, b) => a - b)
    .map((index) => state.images[index])
    .filter(Boolean);
}

function isSupportedImage(file: File) {
  const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
  return supportedExtensions.has(extension) || file.type.startsWith("image/");
}

function isSupportedImagePath(path: string) {
  const extension = path.split(".").pop()?.toLowerCase() ?? "";
  return supportedExtensions.has(extension);
}

function isDigiViewerCachePath(path: string) {
  return path.split(/[\\/]/).includes(".digiviewer");
}

function updateFilteredIndexes() {
  const needle = state.filenameFilter.trim().toLocaleLowerCase();
  state.filteredIndexes = state.images
    .map((_, index) => index)
    .filter((index) => {
      if (!needle) return true;
      return state.images[index].name.toLocaleLowerCase().includes(needle);
    });
}

function visibleIndexes() {
  return state.filteredIndexes.length || state.filenameFilter.trim()
    ? state.filteredIndexes
    : state.images.map((_, index) => index);
}

function visiblePositionForIndex(imageIndex: number) {
  return visibleIndexes().indexOf(imageIndex);
}

function applyFilenameFilter() {
  updateFilteredIndexes();
  const indexes = visibleIndexes();
  const currentVisible = indexes.includes(state.activeIndex);
  state.activeIndex = currentVisible ? state.activeIndex : indexes[0] ?? 0;
  state.activeSlot = 0;
  state.compareSlots = [indexes.includes(state.activeIndex) ? state.activeIndex : null, null, null, null];
  resetThumbnailQueue();
  refillEmptySlots();
  fitView();
  render();
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

function imageSortKey(path: string) {
  const separatorIndex = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  const directory = separatorIndex >= 0 ? path.slice(0, separatorIndex + 1) : "";
  const filename = separatorIndex >= 0 ? path.slice(separatorIndex + 1) : path;
  const dotIndex = filename.lastIndexOf(".");
  const basename = dotIndex >= 0 ? filename.slice(0, dotIndex) : filename;
  const cropMatch = basename.match(/^(.*)_crop(?:_(\d+))?$/i);
  return {
    group: `${directory}${cropMatch?.[1] ?? basename}`.toLowerCase(),
    cropRank: cropMatch ? 1 : 0,
    cropIndex: cropMatch?.[2] ? Number(cropMatch[2]) : 0,
    path,
  };
}

function compareImagePaths(a: string, b: string) {
  const left = imageSortKey(a);
  const right = imageSortKey(b);
  const groupCompare = left.group.localeCompare(right.group, undefined, { numeric: true, sensitivity: "base" });
  if (groupCompare !== 0) return groupCompare;
  if (left.cropRank !== right.cropRank) return left.cropRank - right.cropRank;
  if (left.cropIndex !== right.cropIndex) return left.cropIndex - right.cropIndex;
  return left.path.localeCompare(right.path, undefined, { numeric: true, sensitivity: "base" });
}

function comparePickedFiles(a: PickedFile, b: PickedFile) {
  return compareImagePaths(a.path, b.path);
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
  const target = event.target instanceof Element ? event.target : null;
  if (isTextInputTarget(target)) return;

  if (event.key.toLowerCase() === "m") {
    event.preventDefault();
    event.stopPropagation();
    if (event.repeat) return;
    toggleActiveCheck();
    return;
  }

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
    setCompareCount(Number(event.key));
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
    closeSettings();
    state.mapOpen = false;
    clearSelection();
    renderMap();
  }
}

function isTextInputTarget(target: Element | null) {
  return target instanceof HTMLInputElement ||
    target instanceof HTMLSelectElement ||
    target instanceof HTMLTextAreaElement ||
    Boolean(target?.closest("[contenteditable='true']"));
}

function handleGlobalKeyChange(event: KeyboardEvent) {
  if (event.key !== "Shift") return;
  elements.viewport?.classList.toggle("is-shift-select", event.type === "keydown");
}

function moveActive(delta: number) {
  const indexes = visibleIndexes();
  if (!indexes.length) return;
  const slotIndex = Math.min(state.activeSlot, state.compareCount - 1);
  const currentIndex = state.compareSlots[slotIndex] ?? state.activeIndex;
  const currentPosition = Math.max(0, indexes.indexOf(currentIndex));
  const nextPosition = Math.max(0, Math.min(indexes.length - 1, currentPosition + delta));
  const nextIndex = indexes[nextPosition];
  if (nextIndex === currentIndex) return;
  state.activeIndex = nextIndex;
  state.activeSlot = slotIndex;
  state.compareSlots[slotIndex] = nextIndex;
  state.fitMode = false;
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
  if (state.isResizingSelection) {
    updateSelectionResize(event);
    return;
  }
  if (state.isMovingSelection) {
    updateSelectionMove(event);
    return;
  }
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
  if (state.isResizingSelection) {
    finishSelectionResize(event);
    return;
  }
  if (state.isMovingSelection) {
    finishSelectionMove(event);
    return;
  }
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
  state.selectionRect = selectionRectFromDrag(
    state.selectionStartX,
    state.selectionStartY,
    currentX,
    currentY,
    bounds.width,
    bounds.height,
    cropAspectRatio(),
  );
  renderSelection();
}

function selectionRectFromDrag(
  startX: number,
  startY: number,
  currentX: number,
  currentY: number,
  maxWidth: number,
  maxHeight: number,
  aspectRatio: number | null,
): CropRect {
  if (!aspectRatio) {
    return {
      left: Math.min(startX, currentX),
      top: Math.min(startY, currentY),
      width: Math.abs(currentX - startX),
      height: Math.abs(currentY - startY),
    };
  }

  const directionX = currentX >= startX ? 1 : -1;
  const directionY = currentY >= startY ? 1 : -1;
  const maxDragWidth = directionX > 0 ? maxWidth - startX : startX;
  const maxDragHeight = directionY > 0 ? maxHeight - startY : startY;
  let width = Math.abs(currentX - startX);
  let height = Math.abs(currentY - startY);

  if (width / Math.max(1, height) > aspectRatio) {
    height = width / aspectRatio;
  } else {
    width = height * aspectRatio;
  }

  if (width > maxDragWidth) {
    width = maxDragWidth;
    height = width / aspectRatio;
  }
  if (height > maxDragHeight) {
    height = maxDragHeight;
    width = height * aspectRatio;
  }

  const endX = startX + width * directionX;
  const endY = startY + height * directionY;
  return {
    left: Math.min(startX, endX),
    top: Math.min(startY, endY),
    width,
    height,
  };
}

function selectionRectFromResize(
  rect: CropRect,
  handle: SelectionResizeHandle,
  deltaX: number,
  deltaY: number,
  maxWidth: number,
  maxHeight: number,
  aspectRatio: number | null,
): CropRect {
  if (!aspectRatio) {
    let left = rect.left;
    let top = rect.top;
    let right = rect.left + rect.width;
    let bottom = rect.top + rect.height;

    if (handle.includes("w")) left += deltaX;
    if (handle.includes("e")) right += deltaX;
    if (handle.includes("n")) top += deltaY;
    if (handle.includes("s")) bottom += deltaY;

    left = clamp(left, 0, right - 8);
    top = clamp(top, 0, bottom - 8);
    right = clamp(right, left + 8, maxWidth);
    bottom = clamp(bottom, top + 8, maxHeight);
    return { left, top, width: right - left, height: bottom - top };
  }

  return resizeAspectRect(rect, handle, deltaX, deltaY, maxWidth, maxHeight, aspectRatio);
}

function resizeAspectRect(
  rect: CropRect,
  handle: SelectionResizeHandle,
  deltaX: number,
  deltaY: number,
  maxWidth: number,
  maxHeight: number,
  aspectRatio: number,
): CropRect {
  const minSize = 8;
  const right = rect.left + rect.width;
  const bottom = rect.top + rect.height;
  const centerX = rect.left + rect.width / 2;
  const centerY = rect.top + rect.height / 2;
  let width = rect.width;
  let height = rect.height;
  let left = rect.left;
  let top = rect.top;

  if (handle === "e" || handle === "w") {
    width = handle === "e" ? rect.width + deltaX : rect.width - deltaX;
    width = Math.max(minSize, width);
    height = width / aspectRatio;
    left = handle === "e" ? rect.left : right - width;
    top = centerY - height / 2;
  } else if (handle === "s" || handle === "n") {
    height = handle === "s" ? rect.height + deltaY : rect.height - deltaY;
    height = Math.max(minSize, height);
    width = height * aspectRatio;
    top = handle === "s" ? rect.top : bottom - height;
    left = centerX - width / 2;
  } else {
    const anchorX = handle.includes("w") ? right : rect.left;
    const anchorY = handle.includes("n") ? bottom : rect.top;
    const pointerX = handle.includes("e") ? right + deltaX : rect.left + deltaX;
    const pointerY = handle.includes("s") ? bottom + deltaY : rect.top + deltaY;
    const directionX = handle.includes("e") ? 1 : -1;
    const directionY = handle.includes("s") ? 1 : -1;
    width = Math.max(minSize, Math.abs(pointerX - anchorX));
    height = Math.max(minSize, Math.abs(pointerY - anchorY));
    if (width / height > aspectRatio) {
      height = width / aspectRatio;
    } else {
      width = height * aspectRatio;
    }
    left = directionX > 0 ? anchorX : anchorX - width;
    top = directionY > 0 ? anchorY : anchorY - height;
  }

  return fitAspectRectToBounds({ left, top, width, height }, maxWidth, maxHeight, aspectRatio);
}

function fitAspectRectToBounds(
  rect: CropRect,
  maxWidth: number,
  maxHeight: number,
  aspectRatio: number,
): CropRect {
  let { left, top, width, height } = rect;
  const minSize = 8;
  width = Math.max(minSize, width);
  height = Math.max(minSize, height);

  if (left < 0) left = 0;
  if (top < 0) top = 0;
  if (left + width > maxWidth) {
    width = Math.max(minSize, maxWidth - left);
    height = width / aspectRatio;
  }
  if (top + height > maxHeight) {
    height = Math.max(minSize, maxHeight - top);
    width = height * aspectRatio;
  }
  if (left + width > maxWidth) left = Math.max(0, maxWidth - width);
  if (top + height > maxHeight) top = Math.max(0, maxHeight - height);

  return { left, top, width, height };
}

function applyCropAspectToSelection() {
  const aspectRatio = cropAspectRatio();
  if (!aspectRatio || !state.selectionRect || !elements.viewport) return;
  const bounds = elements.viewport.getBoundingClientRect();
  const rect = state.selectionRect;
  let width = rect.height * aspectRatio;
  let height = rect.height;
  if (rect.left + width > bounds.width) {
    width = Math.max(8, bounds.width - rect.left);
    height = width / aspectRatio;
  }
  state.selectionRect = fitAspectRectToBounds(
    { left: rect.left, top: rect.top, width, height },
    bounds.width,
    bounds.height,
    aspectRatio,
  );
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

function startSelectionMove(event: PointerEvent) {
  if (!elements.viewport || !state.selectionRect) return;
  if ((event.target as Element | null)?.closest(".selection-handle")) return;
  event.preventDefault();
  event.stopPropagation();
  const bounds = elements.viewport.getBoundingClientRect();
  state.isMovingSelection = true;
  state.selectionMoveStartRect = { ...state.selectionRect };
  state.selectionMoveStartX = event.clientX - bounds.left;
  state.selectionMoveStartY = event.clientY - bounds.top;
  elements.viewport.setPointerCapture(event.pointerId);
}

function updateSelectionMove(event: PointerEvent) {
  if (!elements.viewport || !state.selectionMoveStartRect) return;
  const bounds = elements.viewport.getBoundingClientRect();
  const currentX = clamp(event.clientX - bounds.left, 0, bounds.width);
  const currentY = clamp(event.clientY - bounds.top, 0, bounds.height);
  state.selectionRect = selectionRectFromMove(
    state.selectionMoveStartRect,
    currentX - state.selectionMoveStartX,
    currentY - state.selectionMoveStartY,
    bounds.width,
    bounds.height,
  );
  renderSelection();
}

function selectionRectFromMove(
  rect: CropRect,
  deltaX: number,
  deltaY: number,
  maxWidth: number,
  maxHeight: number,
): CropRect {
  return {
    left: clamp(rect.left + deltaX, 0, Math.max(0, maxWidth - rect.width)),
    top: clamp(rect.top + deltaY, 0, Math.max(0, maxHeight - rect.height)),
    width: rect.width,
    height: rect.height,
  };
}

function finishSelectionMove(event: PointerEvent) {
  if (!elements.viewport) return;
  state.isMovingSelection = false;
  state.selectionMoveStartRect = null;
  if (elements.viewport.hasPointerCapture(event.pointerId)) {
    elements.viewport.releasePointerCapture(event.pointerId);
  }
  renderSelection();
}

function startSelectionResize(event: PointerEvent, handle: SelectionResizeHandle) {
  if (!elements.viewport || !state.selectionRect) return;
  event.preventDefault();
  event.stopPropagation();
  const bounds = elements.viewport.getBoundingClientRect();
  state.isResizingSelection = true;
  state.selectionResizeHandle = handle;
  state.selectionResizeStartRect = { ...state.selectionRect };
  state.selectionResizeStartX = event.clientX - bounds.left;
  state.selectionResizeStartY = event.clientY - bounds.top;
  elements.viewport.setPointerCapture(event.pointerId);
}

function updateSelectionResize(event: PointerEvent) {
  if (!elements.viewport || !state.selectionResizeStartRect || !state.selectionResizeHandle) return;
  const bounds = elements.viewport.getBoundingClientRect();
  const currentX = clamp(event.clientX - bounds.left, 0, bounds.width);
  const currentY = clamp(event.clientY - bounds.top, 0, bounds.height);
  state.selectionRect = selectionRectFromResize(
    state.selectionResizeStartRect,
    state.selectionResizeHandle,
    currentX - state.selectionResizeStartX,
    currentY - state.selectionResizeStartY,
    bounds.width,
    bounds.height,
    cropAspectRatio(),
  );
  renderSelection();
}

function finishSelectionResize(event: PointerEvent) {
  if (!elements.viewport) return;
  state.isResizingSelection = false;
  state.selectionResizeHandle = null;
  state.selectionResizeStartRect = null;
  if (elements.viewport.hasPointerCapture(event.pointerId)) {
    elements.viewport.releasePointerCapture(event.pointerId);
  }
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
  renderSelectionHandles();
  elements.selectionBox.hidden = false;

  const viewportWidth = elements.viewport?.getBoundingClientRect().width ?? window.innerWidth;
  const actionLeft = Math.max(8, rect.left);
  const actionTop = Math.max(8, rect.top - 44);
  Object.assign(elements.cropActions.style, {
    left: `${actionLeft}px`,
    top: `${actionTop}px`,
  });
  elements.cropActions.hidden = state.isSelecting || rect.width < 8 || rect.height < 8;
  if (!elements.cropActions.hidden) {
    const maxLeft = Math.max(8, viewportWidth - elements.cropActions.offsetWidth - 8);
    elements.cropActions.style.left = `${Math.min(actionLeft, maxLeft)}px`;
  }
}

function renderSelectionHandles() {
  if (!elements.selectionBox) return;
  const handles: SelectionResizeHandle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
  elements.selectionBox.replaceChildren(...handles.map((handle) => {
    const node = document.createElement("button");
    node.type = "button";
    node.className = `selection-handle selection-handle-${handle}`;
    node.dataset.handle = handle;
    node.title = "範囲を調整";
    node.addEventListener("pointerdown", (event) => startSelectionResize(event, handle));
    return node;
  }));
}

function clearSelection() {
  state.isSelecting = false;
  state.isMovingSelection = false;
  state.isResizingSelection = false;
  state.selectionRect = null;
  state.selectionMoveStartRect = null;
  state.selectionResizeHandle = null;
  state.selectionResizeStartRect = null;
  elements.viewport?.classList.remove("is-selecting");
  if (elements.selectionBox) elements.selectionBox.hidden = true;
  if (elements.cropActions) elements.cropActions.hidden = true;
  setCropStatus("");
}

async function saveCropToSourceFolder() {
  const image = activeImage();
  if (!image) return;
  if (!isTauriRuntime() || !image.path) {
    window.alert("crop保存はTauri版のみ対応です。");
    return;
  }

  try {
    setCropStatus("JPEG保存中");
    const crop = cropRectForActiveImage();
    const saved = await invoke<NativeImageFile>("save_crop_to_source_folder", {
      request: {
        sourcePath: image.path,
        left: Math.round(crop.left),
        top: Math.round(crop.top),
        width: Math.max(1, Math.round(crop.width)),
        height: Math.max(1, Math.round(crop.height)),
        upscale2x: state.cropUpscale2x,
      },
    });
    addNativeImage(saved);
    setCropStatus(`保存済み: ${saved.name}`);
    clearSelection();
  } catch (error) {
    console.error(error);
    setCropStatus("保存失敗");
    window.alert(`crop保存に失敗しました。\n${String(error)}`);
  }
}

function cropRectForActiveImage() {
  const image = activeImage();
  const rect = state.selectionRect;
  const pane = document.querySelector<HTMLElement>(`.image-pane[data-slot="${state.activeSlot}"]`);
  const img = pane?.querySelector<HTMLImageElement>(".view-image");
  if (!image || !image.width || !image.height) {
    throw new Error("切り出す画像がありません。");
  }
  return rect && pane && img
    ? selectionToImageRect(rect, pane, image)
    : { left: 0, top: 0, width: image.width, height: image.height };
}

function addNativeImage(nativeImage: NativeImageFile) {
  const image = {
    id: `${nativeImage.path}-${nativeImage.size}-${nativeImage.modified_at}`,
    name: nativeImage.name,
    path: nativeImage.path,
    size: nativeImage.size,
    modifiedAt: nativeImage.modified_at,
    url: convertFileSrc(nativeImage.path),
    thumbnailLoaded: false,
    thumbnailRequested: false,
    cacheLoaded: false,
    exifLoaded: false,
    rawExtensions: [],
  } satisfies ImageItem;

  state.images = state.images
    .filter((current) => current.path !== nativeImage.path)
    .concat(image)
    .sort((a, b) => compareImagePaths(a.path, b.path));
  updateFilteredIndexes();
  const savedIndex = state.images.findIndex((current) => current.path === nativeImage.path);
  if (savedIndex >= 0) {
    const slotIndex = Math.min(state.activeSlot, state.compareCount - 1);
    state.activeIndex = savedIndex;
    state.activeSlot = slotIndex;
    state.compareSlots[slotIndex] = savedIndex;
  }
  resetThumbnailQueue();
  fitView();
  render();
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

function setCropStatus(message: string) {
  if (elements.cropStatus) elements.cropStatus.textContent = message;
}

function openSettings() {
  if (!elements.settingsDialog) return;
  elements.settingsDialog.hidden = false;
  elements.preloadRadiusInput?.focus();
}

function closeSettings() {
  if (elements.settingsDialog) elements.settingsDialog.hidden = true;
}

async function appendSpeciesNameToCheckedImages() {
  const images = checkedImages();
  if (!images.length) return;
  if (!isTauriRuntime()) {
    window.alert("ファイル名変更はTauri版のみ対応です。");
    return;
  }

  const speciesName = await requestSpeciesName(images.length);
  if (speciesName === null) return;
  const trimmedName = speciesName.trim();
  if (!trimmedName) return;

  try {
    const results = await invoke<RenameResult[]>("rename_images", {
      request: {
        paths: images.map((image) => image.path),
        speciesName: trimmedName,
      },
    });
    applyRenameResults(results);
    clearCheckedImages();
    render();
  } catch (error) {
    console.error(error);
    window.alert(`ファイル名変更に失敗しました。\n${String(error)}`);
  }
}

function requestSpeciesName(count: number) {
  return new Promise<string | null>((resolve) => {
    if (!elements.speciesDialog || !elements.speciesNameInput) {
      resolve(window.prompt(`${count}枚のファイル名に追加する種名を入力してください。`));
      return;
    }

    if (elements.speciesDialogMessage) {
      elements.speciesDialogMessage.textContent = `${count}枚のファイル名の最後に種名を追加します。`;
    }
    elements.speciesNameInput.value = "";
    elements.speciesDialog.hidden = false;
    elements.speciesNameInput.focus();

    const cleanup = () => {
      elements.speciesDialog!.hidden = true;
      elements.speciesOkButton?.removeEventListener("click", handleOk);
      elements.speciesCancelButton?.removeEventListener("click", handleCancel);
      elements.speciesNameInput?.removeEventListener("keydown", handleKeyDown);
    };
    const handleOk = () => {
      const value = elements.speciesNameInput?.value ?? "";
      cleanup();
      resolve(value);
    };
    const handleCancel = () => {
      cleanup();
      resolve(null);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Enter") {
        event.preventDefault();
        handleOk();
      } else if (event.key === "Escape") {
        event.preventDefault();
        handleCancel();
      }
    };

    elements.speciesOkButton?.addEventListener("click", handleOk);
    elements.speciesCancelButton?.addEventListener("click", handleCancel);
    elements.speciesNameInput.addEventListener("keydown", handleKeyDown);
  });
}

function applyRenameResults(results: RenameResult[]) {
  const byOldPath = new Map(results.map((result) => [result.old_path, result]));
  for (const image of state.images) {
    const result = byOldPath.get(image.path);
    if (!result) continue;

    image.id = `${result.path}-${result.size}-${result.modified_at}`;
    image.path = result.path;
    image.name = result.name;
    image.size = result.size;
    image.modifiedAt = result.modified_at;
    image.url = convertFileSrc(result.path);
    image.thumbnailUrl = undefined;
    image.thumbnailLoaded = false;
    image.thumbnailRequested = false;
  }
  updateFilteredIndexes();
  if (!visibleIndexes().includes(state.activeIndex)) {
    state.activeIndex = visibleIndexes()[0] ?? 0;
    state.compareSlots = [visibleIndexes()[0] ?? null, null, null, null];
  }
  resetThumbnailQueue();
}

function applyMoveToDeletedResults(results: MoveToDeletedResult[]) {
  const removedPaths = new Set(results.map((result) => result.old_path));
  if (!removedPaths.size) return;
  const activePath = state.images[state.activeIndex]?.path ?? "";

  for (const image of state.images) {
    if (removedPaths.has(image.path) && image.file && image.url.startsWith("blob:")) {
      URL.revokeObjectURL(image.url);
    }
  }

  state.images = state.images.filter((image) => !removedPaths.has(image.path));
  clearCheckedImages();
  updateFilteredIndexes();
  const visible = visibleIndexes();
  const activeByPath = activePath
    ? state.images.findIndex((image) => image.path === activePath)
    : -1;
  const nextActive = activeByPath >= 0 ? activeByPath : (visible[0] ?? 0);
  state.activeIndex = nextActive;
  state.compareSlots = [visible.length ? nextActive : null, null, null, null];
  state.activeSlot = 0;
  resetThumbnailQueue();
}

async function copyCheckedFiles() {
  const images = checkedImages();
  if (!images.length) return;
  if (!isTauriRuntime()) {
    window.alert("ファイルコピーはTauri版のみ対応です。");
    return;
  }

  try {
    await invoke("copy_files_to_clipboard", {
      paths: images.map((image) => image.path),
    });
    if (elements.selectionCount) {
      elements.selectionCount.textContent = `${images.length}枚コピー済み`;
    }
  } catch (error) {
    console.error(error);
    window.alert(`ファイルコピーに失敗しました。\n${String(error)}`);
  }
}

async function moveCheckedImagesToDeleted() {
  const images = checkedImages();
  if (!images.length) return;
  if (!isTauriRuntime() || !state.currentDirectory) {
    window.alert("画像の除外はフォルダを開いたTauri版のみ対応です。");
    return;
  }

  const ok = window.confirm(
    `${images.length}枚の画像を現在のフォルダ内の deleted フォルダへ移動し、一覧から除外します。`,
  );
  if (!ok) return;

  try {
    const results = await invoke<MoveToDeletedResult[]>("move_images_to_deleted", {
      request: {
        directory: state.currentDirectory,
        paths: images.map((image) => image.path),
      },
    });
    applyMoveToDeletedResults(results);
    render();
  } catch (error) {
    console.error(error);
    window.alert(`画像の除外に失敗しました。\n${String(error)}`);
  }
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

function setCompareCount(count: number) {
  const indexes = visibleIndexes();
  const currentImageIndex = state.compareSlots[state.activeSlot] ?? state.activeIndex;
  const nextActiveIndex = indexes.includes(currentImageIndex)
    ? currentImageIndex
    : (indexes[0] ?? 0);

  state.compareCount = clamp(count, 1, 4);
  state.activeIndex = nextActiveIndex;

  if (state.compareCount === 1) {
    state.activeSlot = 0;
    state.compareSlots = [indexes.length ? nextActiveIndex : null, null, null, null];
    return;
  }

  state.activeSlot = Math.min(state.activeSlot, state.compareCount - 1);
  if (!indexes.includes(state.compareSlots[state.activeSlot] ?? -1)) {
    state.compareSlots[state.activeSlot] = nextActiveIndex;
  }
  refillEmptySlots();
}

function refillEmptySlots() {
  const indexes = visibleIndexes();
  const activePosition = Math.max(0, indexes.indexOf(state.activeIndex));
  for (let slotIndex = 0; slotIndex < state.compareCount; slotIndex += 1) {
    const current = state.compareSlots[slotIndex];
    if (current !== null && indexes.includes(current)) continue;
    state.compareSlots[slotIndex] = indexes[activePosition + slotIndex] ?? null;
  }
  for (let slotIndex = state.compareCount; slotIndex < state.compareSlots.length; slotIndex += 1) {
    state.compareSlots[slotIndex] = null;
  }
}

function activeImage() {
  if (state.filenameFilter.trim() && !visibleIndexes().length) return null;
  return slotImage(state.activeSlot) ?? state.images[state.activeIndex];
}

function slotImage(slotIndex: number) {
  const imageIndex = state.compareSlots[slotIndex];
  if (imageIndex !== null && state.filenameFilter.trim() && !visibleIndexes().includes(imageIndex)) return null;
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
  if (state.isBuildingThumbCache) return;
  const indexes = visibleIndexes();
  if (!indexes.length) return;
  const radius = Math.min(maxInitialImagePreloadRadius, Math.max(0, Math.floor(state.preloadRadius)));
  const activePosition = Math.max(0, indexes.indexOf(state.activeIndex));
  const start = Math.max(0, activePosition - radius);
  const end = Math.min(indexes.length - 1, activePosition + radius);
  const activeIndex = state.activeIndex;
  loadImageInfo(state.images[activeIndex]);
  window.setTimeout(() => {
    if (state.activeIndex !== activeIndex) return;
    for (let position = start; position <= end; position += 1) {
      const index = indexes[position];
      if (index !== activeIndex) loadImageInfo(state.images[index]);
    }
  }, 250);
}

function loadImageInfo(image: ImageItem) {
  if (image.cacheLoaded) return image.cachePromise ?? Promise.resolve();
  if (image.cachePromise) return image.cachePromise;

  image.cachePromise = new Promise<void>((resolve) => {
    const start = performance.now();
    const img = new Image();
    img.decoding = "async";
    img.onload = async () => {
      image.width = img.naturalWidth;
      image.height = img.naturalHeight;
      perf.imageMs = performance.now() - start;
      image.cacheLoaded = true;
      if (image === activeImage()) {
        if (state.fitMode) fitView();
        renderMeta();
        renderViewTransform();
        renderPerfMeter();
      }
      resolve();
    };
    img.onerror = () => {
      perf.imageMs = performance.now() - start;
      image.cacheLoaded = true;
      renderPerfMeter();
      resolve();
    };
    img.src = image.url;
  });

  return image.cachePromise;
}

function scheduleThumbnailPreload() {
  if (state.isBuildingThumbCache) return;
  if (!state.images.length) return;
  if (thumbnailPreloadTimer) window.clearTimeout(thumbnailPreloadTimer);
  thumbnailPreloadTimer = window.setTimeout(() => {
    thumbnailPreloadTimer = 0;
    preloadThumbnailsAroundActive();
  }, thumbnailBackgroundDelayMs);
}

function preloadThumbnailsAroundActive() {
  const visible = visibleIndexes();
  if (!visible.length) return;

  const radius = Math.min(maxInitialThumbnailPreloadRadius, Math.max(0, Math.floor(state.thumbPreloadRadius)));
  const activePosition = Math.max(0, visible.indexOf(state.activeIndex));
  const start = Math.max(0, activePosition - radius);
  const end = Math.min(visible.length - 1, activePosition + radius);
  const indexes = [];
  for (let position = start; position <= end; position += 1) indexes.push(visible[position]);
  indexes.sort((a, b) => Math.abs(a - state.activeIndex) - Math.abs(b - state.activeIndex));
  const keepIndexes = new Set(indexes);
  keepQueuedThumbnails((index) => keepIndexes.has(index));
  for (const index of indexes.slice(0, thumbnailBackgroundBatchLimit)) queueThumbnail(index, false);
}

function preloadVisibleThumbnails() {
  if (state.isBuildingThumbCache) return;
  const rail = elements.thumbs?.parentElement;
  const visible = visibleIndexes();
  if (!rail || !visible.length) return;

  const visibleStart = Math.max(0, Math.floor(rail.scrollLeft / thumbItemWidth) - visibleThumbnailBuffer);
  const visibleEnd = Math.min(
    visible.length - 1,
    Math.ceil((rail.scrollLeft + rail.clientWidth) / thumbItemWidth) + visibleThumbnailBuffer,
  );
  const indexes = visible.slice(visibleStart, visibleEnd + 1);
  const keepIndexes = new Set(indexes);
  keepQueuedThumbnails((index) => keepIndexes.has(index));
  for (const index of indexes) {
    queueThumbnail(index, true);
  }
}

function keepQueuedThumbnails(keep: (index: number) => boolean) {
  thumbnailQueue = thumbnailQueue.filter((index) => {
    if (keep(index)) return true;
    const image = state.images[index];
    if (image && !image.thumbnailLoaded) image.thumbnailRequested = false;
    return false;
  });
}

function queueThumbnail(index: number, priority: boolean) {
  const image = state.images[index];
  if (!image || image.thumbnailLoaded) return;
  if (!isTauriRuntime()) return;

  if (image.thumbnailRequested) {
    if (priority) {
      const queuedIndex = thumbnailQueue.indexOf(index);
      if (queuedIndex >= 0) {
        thumbnailQueue.splice(queuedIndex, 1);
        thumbnailQueue.unshift(index);
      }
    }
    return;
  }

  image.thumbnailRequested = true;
  if (priority) {
    thumbnailQueue.unshift(index);
  } else {
    thumbnailQueue.push(index);
  }
  renderThumbCacheStatus();
  pumpThumbnailQueue();
}

function pumpThumbnailQueue() {
  while (activeThumbnailJobs < thumbnailConcurrency && thumbnailQueue.length) {
    const index = thumbnailQueue.shift()!;
    const image = state.images[index];
    if (!image || image.thumbnailLoaded) continue;

    activeThumbnailJobs += 1;
    loadThumbnail(index, image)
      .catch((error) => {
        image.thumbnailLoaded = true;
        console.warn("Thumbnail generation failed", error);
      })
      .finally(() => {
        activeThumbnailJobs = Math.max(0, activeThumbnailJobs - 1);
        renderThumbCacheStatus();
        pumpThumbnailQueue();
      });
  }
}

async function loadThumbnail(index: number, image: ImageItem) {
  const start = performance.now();
  const pruneCache = state.thumbCacheLimitMb > 0
    && thumbnailRequestsSincePrune++ % thumbnailPruneInterval === 0;
  const path = await invoke<string | null>("get_thumbnail", {
    request: {
      path: image.path,
      size: image.size,
      modifiedAt: image.modifiedAt,
      maxEdge: thumbnailMaxEdge,
      cacheLimitMb: state.thumbCacheLimitMb,
      pruneCache,
      cacheScope: state.currentDirectory ? "folder" : "app",
    },
  });
  const elapsed = performance.now() - start;
  perf.thumbLastMs = elapsed;
  perf.thumbCount += 1;
  perf.thumbAvgMs = perf.thumbAvgMs === null
    ? elapsed
    : ((perf.thumbAvgMs * (perf.thumbCount - 1)) + elapsed) / perf.thumbCount;
  image.thumbnailLoaded = true;
  if (path) {
    image.thumbnailUrl = convertFileSrc(path);
  }
  updateThumbnailElement(index);
  renderThumbCacheStatus();
  renderPerfMeter();
}

async function buildAllThumbnailCache() {
  if (!state.images.length || !isTauriRuntime()) return;
  const cacheTargets = state.images.filter((image) => !isDigiViewerCachePath(image.path));
  state.isBuildingThumbCache = true;
  state.thumbCacheStatus = `0 / ${cacheTargets.length}`;
  resetThumbnailQueue();
  renderChrome();

  const chunkSize = 24;
  let created = 0;
  let reused = 0;
  let failed = 0;
  try {
    for (let start = 0; start < cacheTargets.length; start += chunkSize) {
      const chunk = cacheTargets.slice(start, start + chunkSize);
      const result = await invoke<ThumbnailCacheResult>("build_thumbnail_cache", {
        request: {
          paths: chunk.map((image) => image.path),
          maxEdge: thumbnailMaxEdge,
          cacheScope: "folder",
        },
      });
      created += result.created;
      reused += result.reused;
      failed += result.failed;
      state.thumbCacheStatus =
        `${Math.min(start + chunk.length, cacheTargets.length)} / ${cacheTargets.length} 作成 ${created} 再利用 ${reused} 失敗 ${failed}`;
      renderThumbCacheStatus();
      renderPerfMeter();
      await idlePause();
    }
    state.thumbCacheStatus = `完了 作成 ${created} 再利用 ${reused} 失敗 ${failed}`;
    for (const image of state.images) {
      image.thumbnailLoaded = false;
      image.thumbnailRequested = false;
    }
    resetThumbnailQueue();
    preloadVisibleThumbnails();
  } catch (error) {
    console.error(error);
    state.thumbCacheStatus = `作成失敗 ${String(error)}`;
    renderThumbCacheStatus();
  } finally {
    state.isBuildingThumbCache = false;
    renderChrome();
  }
}

async function cleanThumbnailCache() {
  if (!state.currentDirectory || !isTauriRuntime()) return;
  try {
    const result = await invoke<ThumbnailCacheResult>("clean_thumbnail_cache", {
      directory: state.currentDirectory,
    });
    state.thumbCacheStatus = `整理 削除 ${result.deleted} 保持 ${result.reused} 失敗 ${result.failed}`;
  } catch (error) {
    console.error(error);
    state.thumbCacheStatus = `整理失敗 ${String(error)}`;
  }
  renderChrome();
}

async function clearThumbnailCache() {
  if (!state.currentDirectory || !isTauriRuntime()) return;
  if (!window.confirm("このフォルダのDigiViewerサムネイルキャッシュを全削除します。よろしいですか？")) return;
  try {
    const result = await invoke<ThumbnailCacheResult>("clear_thumbnail_cache", {
      directory: state.currentDirectory,
    });
    state.thumbCacheStatus = `全削除 ${result.deleted} 失敗 ${result.failed}`;
    for (const image of state.images) {
      image.thumbnailLoaded = false;
      image.thumbnailRequested = false;
      image.thumbnailUrl = undefined;
    }
    resetThumbnailQueue();
    renderThumbs();
    preloadVisibleThumbnails();
  } catch (error) {
    console.error(error);
    state.thumbCacheStatus = `削除失敗 ${String(error)}`;
  }
  renderChrome();
}

function idlePause() {
  return new Promise<void>((resolve) => window.setTimeout(resolve, 0));
}

function updateThumbnailElement(index: number) {
  const image = state.images[index];
  const button = elements.thumbs?.querySelector<HTMLButtonElement>(`.thumb[data-index="${index}"]`);
  if (!image || !button || !image.thumbnailUrl) return;

  let img = button.querySelector<HTMLImageElement>("img");
  if (!img) {
    img = document.createElement("img");
    img.alt = "";
    img.loading = "lazy";
    img.draggable = false;
    button.prepend(img);
  }
  img.src = image.thumbnailUrl;
}

function render() {
  const start = performance.now();
  renderChrome();
  renderCompareGrid();
  renderThumbs();
  renderMeta();
  renderMap();
  perf.renderMs = performance.now() - start;
  renderPerfMeter();
  preloadAroundActive();
  preloadVisibleThumbnails();
  scheduleThumbnailPreload();
  scheduleExifLoad();
}

function renderChrome() {
  const visible = visibleIndexes();
  const hasImages = visible.length > 0;
  const visiblePosition = visiblePositionForIndex(state.activeIndex);
  elements.emptyState?.toggleAttribute("hidden", hasImages);
  elements.compareGrid?.toggleAttribute("hidden", !hasImages);
  elements.prevButton?.toggleAttribute("disabled", !hasImages || visiblePosition <= 0);
  elements.nextButton?.toggleAttribute("disabled", !hasImages || visiblePosition >= visible.length - 1);
  elements.viewerPrevButton?.toggleAttribute("disabled", !hasImages || visiblePosition <= 0);
  elements.viewerNextButton?.toggleAttribute("disabled", !hasImages || visiblePosition >= visible.length - 1);
  const checkedCount = state.checkedIndexes.size;
  if (elements.selectionCount) {
    elements.selectionCount.textContent = `選択 ${checkedCount}`;
  }
  elements.appendSpeciesButton?.toggleAttribute("disabled", checkedCount === 0);
  elements.copyFilesButton?.toggleAttribute("disabled", checkedCount === 0);
  elements.moveDeletedButton?.toggleAttribute(
    "disabled",
    checkedCount === 0 || !isTauriRuntime() || !state.currentDirectory,
  );
  elements.clearSelectionButton?.toggleAttribute("disabled", checkedCount === 0);
  const canManageThumbCache = isTauriRuntime() && hasImages && Boolean(state.currentDirectory);
  elements.buildThumbCacheButton?.toggleAttribute("disabled", !canManageThumbCache || state.isBuildingThumbCache);
  if (elements.buildThumbCacheButton) {
    elements.buildThumbCacheButton.textContent = state.isBuildingThumbCache ? "作成中..." : "サムネ作成";
  }
  elements.cleanThumbCacheButton?.toggleAttribute("disabled", !canManageThumbCache || state.isBuildingThumbCache);
  elements.clearThumbCacheButton?.toggleAttribute("disabled", !canManageThumbCache || state.isBuildingThumbCache);

  for (const button of elements.modeButtons) {
    const count = Number(button.dataset.compareCount ?? 1);
    button.setAttribute("aria-pressed", String(count === state.compareCount));
  }

  if (elements.syncButton) {
    elements.syncButton.setAttribute("aria-pressed", String(state.syncView));
    elements.syncButton.textContent = state.syncView ? "同期 ON" : "同期 OFF";
  }
  renderThumbCacheStatus();
  renderPerfMeter();
}

function renderThumbCacheStatus() {
  if (!elements.thumbCacheStatus) return;
  const pendingCount = thumbnailQueue.length + activeThumbnailJobs;
  const message = state.isBuildingThumbCache
    ? `サムネ作成中 ${state.thumbCacheStatus}`
    : state.thumbCacheStatus
      || (pendingCount > 0
        ? `通常サムネ生成中 残り ${pendingCount} / 生成 ${perf.thumbCount}枚`
        : state.images.length
          ? `サムネ待機 生成 ${perf.thumbCount}枚`
          : "サムネ待機");
  elements.thumbCacheStatus.textContent = message;
  elements.thumbCacheStatus.hidden = false;
}

function renderPerfMeter() {
  if (!elements.perfMeter) return;
  elements.perfMeter.hidden = !state.perfVisible;
  if (!state.perfVisible) return;
  const values = [
    `走査 ${formatMs(perf.scanMs)}`,
    `一覧 ${formatMs(perf.listMs)}`,
    `描画 ${formatMs(perf.renderMs)}`,
    `画像 ${formatMs(perf.imageMs)}`,
    `EXIF ${formatMs(perf.exifMs)}`,
    `サムネ ${formatMs(perf.thumbLastMs)}`,
    `平均 ${formatMs(perf.thumbAvgMs)}`,
    `${perf.thumbCount}枚`,
  ];
  elements.perfMeter.textContent = values.join(" / ");
}

function formatMs(value: number | null) {
  if (value === null) return "-";
  if (value < 1000) return `${Math.round(value)}ms`;
  return `${(value / 1000).toFixed(1)}s`;
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
    scheduleExifLoad();
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
  const panePosition = visiblePositionForIndex(state.compareSlots[slotIndex]!);
  badge.textContent = `${panePosition >= 0 ? panePosition + 1 : "-"} / ${visibleIndexes().length}`;

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

  visibleIndexes().forEach((index, visiblePosition) => {
    const image = state.images[index];
    const button = document.createElement("button");
    button.type = "button";
    button.className = "thumb";
    button.draggable = true;
    button.dataset.index = String(index);
    button.setAttribute("aria-current", String(index === state.activeIndex));
    button.setAttribute("aria-checked", String(state.checkedIndexes.has(index)));
    button.title = image.path;
    button.addEventListener("click", (event) => {
      if (event.shiftKey || event.metaKey || event.ctrlKey) {
        toggleThumbCheck(index, !state.checkedIndexes.has(index), event.shiftKey);
        renderThumbs();
        renderChrome();
        return;
      }
      const slotIndex = Math.min(state.activeSlot, state.compareCount - 1);
      state.activeIndex = index;
      state.activeSlot = slotIndex;
      state.compareSlots[slotIndex] = index;
      fitView();
      render();
    });
    button.addEventListener("dragstart", (event) => {
      event.dataTransfer?.setData("text/plain", String(index));
      event.dataTransfer?.setDragImage(button, 48, 36);
    });

    const check = document.createElement("span");
    check.className = "thumb-check";
    check.textContent = state.checkedIndexes.has(index) ? "✓" : "";
    check.title = state.checkedIndexes.has(index) ? "チェックを外す" : "チェックする";
    check.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      toggleThumbCheck(index, !state.checkedIndexes.has(index), event.shiftKey);
      renderThumbs();
      renderChrome();
    });
    button.append(check);

    if (image.thumbnailUrl) {
      const img = document.createElement("img");
      img.src = image.thumbnailUrl;
      img.alt = "";
      img.loading = "lazy";
      img.draggable = false;
      button.append(img);
    }

    const indexLabel = document.createElement("span");
    indexLabel.className = "thumb-index";
    indexLabel.textContent = String(visiblePosition + 1);
    button.append(indexLabel);
    fragment.append(button);
  });

  elements.thumbs.replaceChildren(fragment);
  const activeThumb = elements.thumbs.querySelector<HTMLElement>('[aria-current="true"]');
  activeThumb?.scrollIntoView({ block: "nearest", inline: "nearest" });
}

function toggleThumbCheck(index: number, checked: boolean, useRange: boolean) {
  const start = useRange && state.lastCheckedIndex !== null
    ? Math.min(state.lastCheckedIndex, index)
    : index;
  const end = useRange && state.lastCheckedIndex !== null
    ? Math.max(state.lastCheckedIndex, index)
    : index;

  for (let current = start; current <= end; current += 1) {
    if (checked) {
      state.checkedIndexes.add(current);
    } else {
      state.checkedIndexes.delete(current);
    }
  }
  state.lastCheckedIndex = index;
}

function toggleActiveCheck() {
  if (!state.images.length) return;
  const slotIndex = Math.min(state.activeSlot, state.compareCount - 1);
  const index = state.compareSlots[slotIndex] ?? state.activeIndex;
  if (!Number.isInteger(index) || index < 0 || index >= state.images.length) return;

  toggleThumbCheck(index, !state.checkedIndexes.has(index), false);
  renderThumbs();
  renderChrome();
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
    const visible = visibleIndexes();
    const visiblePosition = visiblePositionForIndex(state.activeIndex);
    const filteredSuffix = state.filenameFilter.trim() ? ` (全${state.images.length})` : "";
    elements.imageCount.textContent = visible.length
      ? `${visiblePosition + 1} / ${visible.length}${filteredSuffix}`
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

  const start = performance.now();
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
    perf.exifMs = performance.now() - start;
    image.exifLoaded = true;
    if (image === activeImage()) {
      renderMeta();
      renderMap();
      renderPerfMeter();
    }
  }
}

function scheduleExifLoad() {
  if (state.isBuildingThumbCache) return;
  if (exifTimer) window.clearTimeout(exifTimer);
  exifTimer = window.setTimeout(() => {
    exifTimer = 0;
    loadExifForActiveImage();
  }, exifDelayMs);
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
