# 🌼 Bollywood Night Awards

A party voting app for Bollywood nights. Guests vote for each other in awards like *Best dressed* and *Most filmy entry*, then the host opens the envelopes one by one on their screen.

### ▶ [Open the app](https://sheery96.github.io/claude-ai-games/bollywood-vote/)

## How a party runs

1. **Host** taps *Host a party*, types the guest names (one per line), and edits the awards if they like.
2. Guests **scan the QR code** on the host's screen (or open the site and enter the 5-letter code), pick a nominee for each award, and send their vote. They can change it until voting closes.
3. The host taps *Close voting and reveal winners* and opens each envelope — ties are announced as ties.

No Wi-Fi at the venue, or guests without phones? Choose **Pass this phone around** during setup: each guest votes privately on one device, fully offline.

## How it works

Plain HTML, CSS and JavaScript — no build step, no backend of its own, so it runs on GitHub Pages like the snake game.

- Guest phones connect **directly to the host's browser** over WebRTC, using the free public [PeerJS](https://peerjs.com/) broker only to find each other. The host's device holds the votes, so **the host must keep the app open** during voting.
- Votes are saved in the host's browser, so a refresh or accidental close doesn't lose them.
- Strict networks (some corporate Wi-Fi, a few mobile carriers) can block peer-to-peer connections. If a guest can't connect, use pass-the-phone mode or switch them to the same Wi-Fi as the host.

```
bollywood-vote/
├── index.html   # page shell, fonts, CDN scripts (PeerJS, QR code)
├── style.css    # marigold-and-plum theme
└── app.js       # host, guest, pass-the-phone and reveal flows
```

## Disclaimer

Unofficial, fan-made party game. Not affiliated with any film studio, production house or awards show.
