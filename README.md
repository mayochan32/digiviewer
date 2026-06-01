# DigiViewer

DigiViewer is a fast local image review and comparison viewer for large photo sets.

The first MVP focuses on interaction feel:

- open a folder or multiple image files
- move quickly with arrow keys
- compare 2, 3, or 4 images in slots
- synchronize zoom and pan across comparison panes
- drag thumbnails into comparison slots
- show a one-line EXIF bar and GPS map when location metadata exists
- display zoom as image-pixel scale, where 100% means one image pixel per screen pixel
- preload and decode nearby images around the active image
- detect same-basename RAW sidecar files and show `RAWあり`
- inspect focus and composition differences without modifying original files

## Current MVP

This repository is scaffolded as a Tauri app, but the current viewer can also run in the browser through Vite. That keeps the first interaction prototype usable before Rust is installed.

```sh
npm install
npm run dev
```

Then open the local URL printed by Vite.

For the desktop app, install Rust and run:

```sh
npm run tauri dev
```

The Tauri build uses a native folder picker and scans image paths through a Rust command. Browser mode still uses the browser file picker as a fallback.

## Controls

| Key / Action | Behavior |
| --- | --- |
| `ArrowRight` / `ArrowLeft` | next / previous image |
| `ArrowDown` / `ArrowUp` | jump forward / backward 10 images |
| `1` `2` `3` `4` | switch comparison count |
| drag thumbnail to pane | assign image to comparison slot |
| mouse wheel | zoom |
| drag | pan |
| `F` | fit / reset view |
| `0` | actual size / pixel 100% |
| `+` / `-` | zoom in / out |
| `L` | toggle sync lock |

The preload count is adjustable in the top toolbar. A value of `6` preloads six images before and six images after the active image.

## Planned Native Layer

The Tauri/Rust layer will add:

- native EXIF loading
- thumbnail disk cache
- SQLite labels and notes
- preloading around the active image
- macOS app bundle and later Windows builds
