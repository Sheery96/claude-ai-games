# 🐍 Snake — Nokia Style

A tiny, dependency-free Snake game inspired by the classic Nokia 3310, built to run identically on **desktop, Android, and iOS** from a single codebase — no app store, no build pipeline, no native SDKs.

![platform](https://img.shields.io/badge/platform-web%20%7C%20android%20%7C%20ios-9bbc0f)
![size](https://img.shields.io/badge/dependencies-zero-0f380f)
![license](https://img.shields.io/badge/license-MIT-blue)

### ▶ [Play it now](https://sheery96.github.io/claude-ai-games/) — no install required

Open that link on desktop or mobile. On your phone, use "Add to Home Screen" (see below) to install it like a native app.

## Why it's lightweight

Instead of Flutter/React Native/native builds, this is plain **HTML + CSS + JavaScript** packaged as a **Progressive Web App (PWA)**:

- Runs in any modern browser — just open `index.html` or serve the folder.
- **Installable** on Android and iOS via "Add to Home Screen," launching full-screen like a native app.
- Works **offline** via a service worker that caches all assets.
- No frameworks, no bundler, no build step — the whole game is a few KB.

## Play it

### Desktop / any browser
```bash
cd claude-ai-games
python3 -m http.server 8000
```
Then open `http://localhost:8000` in your browser.

(A service worker requires `http://` or `https://` — opening `index.html` directly via `file://` will skip offline caching but the game itself still works.)

### Android
1. Serve the folder from a host reachable by your phone (e.g. deploy to GitHub Pages, Netlify, Vercel, or run a local server on the same Wi-Fi).
2. Open the URL in Chrome.
3. Tap the menu → **Add to Home screen**. It installs and launches like a native app.

### iOS
1. Open the hosted URL in Safari.
2. Tap the Share icon → **Add to Home Screen**.
3. Launch it from the home screen — it runs full-screen, no browser chrome.

## Controls

| Platform | Input |
|---|---|
| Desktop | Arrow keys or `WASD` |
| Mobile | On-screen D-pad, or swipe on the screen |

Wall or self-collision ends the run, just like the original — tap/press any key to retry.

## Project structure

```
claude-ai-games/
├── index.html          # markup + retro "phone" chrome
├── style.css            # Nokia LCD look (pixelated canvas, D-pad)
├── game.js               # game loop, input, collision, scoring
├── manifest.json        # PWA manifest (installable app metadata)
├── service-worker.js    # offline asset caching
└── icons/                # app icons (192px, 512px, iOS touch icon)
```

## Deploying

Live at **https://sheery96.github.io/claude-ai-games/** via GitHub Pages (served from the `main` branch root). Any static host works, though — no server-side code required.

## License

MIT — see [LICENSE](LICENSE). Free to use, modify, and share.
