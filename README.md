# Esmount VOD Downloader

A Windows program for downloading Twitch VODs, or just the part you want.

Paste a VOD link, choose the start and end time, pick a quality and a folder, and click **Download**.
Behind the scenes it runs [twitch-dlp](https://github.com/DmitryScaletta/twitch-dlp) for you:

```bash
npx --yes twitch-dlp@latest https://www.twitch.tv/videos/123456789 -f 1080p60 --download-sections "*1:00:00-1:30:00" -o "C:\Users\you\Downloads\channel - title [v123456789] (1h00m00s-1h30m00s).mp4"
```

The program shows the exact command and its live output for every download.

## Download

1. Go to **[Releases](https://github.com/TrinityTF/esmount-vod-downloader/releases/latest)** and download `Esmount-VOD-Downloader-Setup-x.y.z.exe`.
2. Run it. The program installs itself (no admin rights needed), adds Desktop and Start menu shortcuts, and opens.

> Windows may show **"Windows protected your PC"** because the installer isn't code-signed.
> Click **More info → Run anyway**.

## What gets downloaded automatically

On first start, the program checks for and downloads what it needs:

| Tool | When | Where |
| --- | --- | --- |
| Node.js + npx | Node.js 22+ isn't installed | `%LOCALAPPDATA%\Esmount VOD Downloader\tools\node` |
| ffmpeg | ffmpeg isn't installed | `%LOCALAPPDATA%\Esmount VOD Downloader\tools\ffmpeg` |
| twitch-dlp | Always (latest version, through `npx`) | npm's cache |

Nothing is installed system-wide. Downloads are checked against their published checksums.

## Using it

1. **VOD link** – paste a link like `https://www.twitch.tv/videos/123456789`. A `?t=1h2m3s` in the link sets the start time.
2. **Part to download** – drag the slider or type times (`1:23:45`, `83:45`, `1h23m45s`). **Whole VOD** resets it. Cuts are accurate to about 10 seconds.
3. **Quality** – every quality Twitch offers for that VOD, with the source quality first.
4. **Save to** – any folder. The program remembers your last folder and quality.

Downloads run one at a time. Extra ones wait in a queue. If you stop a download, starting the same one again continues where it left off.

## Updates

The program checks GitHub for a newer release at startup and every few hours.
When one is found, it asks **"Update now?"**. Saying yes downloads the update, installs it, and restarts the program.

---

## For the developer

### Publishing an update

Push to `main`. The [release workflow](.github/workflows/release.yml) builds the installer and publishes a GitHub release named `v1.0.<build number>`, using the commit messages as release notes. Installed copies then offer the update.

- Pushes that only change Markdown files don't create a release.
- To start a new version line, change `version` in `package.json` (for example to `1.1.0`).
- The repository must be **public** so installed copies can see releases.

### Running from source

```bash
npm install
npm start
```

### Building the installer locally

```bash
npm run dist
```

The installer is written to `dist/`. To change the icon, edit `build/icon.svg` and run `npm run icon`.

### Project layout

```
src/main/       Electron main process
  main.js         window, IPC, notifications, lifecycle
  tools.js        finds or downloads Node.js/npx, ffmpeg, twitch-dlp
  twitch.js       VOD details (title, length, thumbnail) and qualities (twitch-dlp -F)
  downloads.js    download queue: runs the npx twitch-dlp command and parses its progress
  updater.js      GitHub release updates (electron-updater)
src/renderer/   the window's UI (HTML/CSS/JS)
build/          app icon and build resources
scripts/        icon rendering and release versioning
```

Logs are written to `%LOCALAPPDATA%\Esmount VOD Downloader\logs\app.log`.
