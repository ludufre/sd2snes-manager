<p align="center"><a href="https://sd2snes.ludufre.com/manager/"><img src="web/public/logo.png" alt="sd2snes+" width="320"></a></p>

<h1 align="center">Web Manager</h1>

<p align="center"><b>Fill your SD2SNES / FXPak Pro card with box art, game info, video previews, cheats and manuals, from the browser, with nothing to install.</b></p>

> **What is this?** The companion tool for the [**sd2snes+ firmware**](https://github.com/ludufre/sd2snes). Point it at your SD card and it identifies every ROM by checksum, then downloads and writes the art, metadata and cheats the console shows. Your files never leave your machine.

## 👉 Use it now: **[sd2snes.ludufre.com/manager](https://sd2snes.ludufre.com/manager/)**

You do not need this repository to use the Manager. It is a web app: open the link, connect your card, done. Everything below is for people who want to read the code or run it themselves.

## Get it running

1. Open the **[Web Manager](https://sd2snes.ludufre.com/manager/)** in Chrome or Edge, with the SD card plugged into your computer.
2. Hit **Select folder…** and pick the card (or drag the folder onto the page). Nothing is uploaded; the browser grants access to that one folder and everything is read locally.
3. Run **Auto-fill**. It analyses what is already on the card and asks, category by category, whether to *Don't touch*, *Complete* only what is missing, *Update* what is outdated, or *Replace* everything.
4. Put the card back in the console.

Just browsing? Pick **Try with sample ROMs** on the start screen and the whole interface works against a demo library, no card required.

> [!NOTE]
> Nothing is uploaded, ever. ROMs are read locally and identified by CRC32, and only the checksum goes to the server. The card is read and written directly through the File System Access API.

> [!IMPORTANT]
> Chrome or Edge only, over `https` or `http://localhost`. Firefox and Safari have no write support in the File System Access API, which is the whole basis of the app.

## What it does

| | |
| :------ | :------ |
| **Identifies your library** | CRC32 of each ROM (headerless, and minus the iNES header on `.nes`) resolves the game against the [GameDB](https://sd2snes.ludufre.com/gamesdb). Handles SNES, Satellaview, Game Boy / Color / Super, NES, Master System, Atari 2600 and Sufami Turbo. |
| **Box art** | Writes `.cov` next to each ROM, encoded in the browser by the same Go encoder the native tool uses, compiled to WebAssembly, so the bytes are identical. Or bring your own image. |
| **Game info cards** | The screenshot and the animated preview with sound (`.fmv` + `.pcm`) that the console shows before a game boots, plus the `.yml` with developer, year, players, genre, chip and a description in six languages. |
| **Cheats** | Downloaded per CRC and filed where the firmware expects them, with an editor for toggling and writing codes by hand. |
| **Manuals and guides** | Official manuals installed into the game's eight slots, readable on the TV. There is also a local editor that turns a PDF or a pile of images into `.man`, splitting two-page spreads automatically. |
| **Themes** | Lists the `.thm` on the card with a rendered preview, sets or deletes the active one, and installs new themes from the gallery. |
| **Firmware and chip BIOS** | Lists sd2snes+ releases with their changelog and installs Core or Full, touching only `/sd2snes/`. For chip BIOS, drop any file in and the slot is identified by name, then CRC32, then size. |
| **File management** | Import, move, copy, delete and rename to No-Intro, always carrying the game's sidecar files along. |
| **Organizes the card** | Firmware 2.15 moved to two-letter folders. **Organize** detects the old layout, shows exactly what will move before touching anything, rescues stranded `.ips`/`.bps` patches and sweeps system junk. |

Interface in Portuguese, English, Spanish, German, French, Italian and Russian, following your browser's language.

## What lands on the card

From firmware 2.15 on, per-game files live in two-letter folders derived from the filename.

| File | Where |
| :--- | :--- |
| `.cov` (box art) | next to the ROM, as `<stem>.cov` |
| `.fmv` `.pcm` `.yml` `.man` | `/sd2snes/info/<XX>/` |
| cheats | `/sd2snes/cheats/<XX>/` |
| saves and states | `/sd2snes/saves/<XX>/`, `/sd2snes/states/<XX>/` |
| chip BIOS | `/sd2snes/` |

Game Boy ROMs get their own namespace inside each root (`/sd2snes/saves/sgb/TE/…`), otherwise a `Tetris.gb` and a `Tetris.sfc` would fight over one save file.

## Build from source

Needs Node 20+, pnpm and a Chromium browser.

```bash
cd web
pnpm install
pnpm start     # http://localhost:4200
pnpm test      # Vitest
```

For a production build use `./build.sh` from the root, not `ng build`: it sets the base href and stages the ffmpeg and pdf.js assets. The output is static files, so any host works as long as unknown paths fall back to `index.html`.

To publish with `./deploy.sh`, copy `.env.example` to `.env` and point `SSH_HOST` and `SSH_DEST` at your own server (`.env` is gitignored). Run `./deploy.sh --dry-run` first; it previews the rsync without writing anything.

The `.cov` encoder is Go, in [`covgen/`](covgen), compiled to WebAssembly by `covgen/build-covwasm.sh`. It lives here so the wasm can always be rebuilt from this repository alone. The `wasm_exec.js` has to come from the same Go version that built the wasm; the script regenerates both together.

## Related

[Firmware sd2snes+](https://github.com/ludufre/sd2snes) · [Site, guides and downloads](https://sd2snes.ludufre.com) · [GamesDB](https://sd2snes.ludufre.com/gamesdb/) · [Theme gallery](https://sd2snes.ludufre.com/gallery/) · [Theme Creator](https://sd2snes.ludufre.com/theme/) · [Sound Creator](https://sd2snes.ludufre.com/sounds/)

## Credits & license

Project and web tools by [@ludufre](https://github.com/ludufre). Built on the [original sd2snes project](https://github.com/mrehkopf/sd2snes) by [@mrehkopf](https://github.com/mrehkopf) and its contributors.

Thanks to [@furious](https://github.com/furious) for the `/sd2snes/config.yml` editor, the per-game save state buttons and the SNES controller combo picker ([#1](https://github.com/ludufre/sd2snes-manager/pull/1)).

Licensed under **GPL-2.0**, the same as the sd2snes+ firmware and the original sd2snes project. © 2026 Luan Freitas and contributors. See [LICENSE](LICENSE).

Third-party components keep their own licenses. Worth singling out: the video previews are produced by [ffmpeg.wasm](https://github.com/ffmpegwasm/ffmpeg.wasm), whose `@ffmpeg/core` build is **GPL-2.0-or-later** and ships with the deployed app. The rest is permissive: Angular, `fflate`, `fzstd`, `marked` and Transloco under MIT, `pdfjs-dist` under Apache-2.0.

No games or ROMs are included. Use your own legally obtained files.
