# 🌼 Bollywood Night Awards

A party voting app for Bollywood nights. Guests vote for each other in awards like *Best dressed* and *Most filmy entry*, then the host opens the envelopes one by one on their screen.

### ▶ [Open the app](https://sheery96.github.io/claude-ai-games/bollywood-vote/)

## How a party runs

1. **Host** taps *Host a party*, types the guest names (one per line), and edits the awards if they like.
2. Guests **scan the QR code** on the host's screen (or open the site and enter the 5-letter code), pick a nominee for each award, and send their vote. They can change it until voting closes.
3. The host taps *Close voting and reveal winners* and opens each envelope — ties are announced as ties.

No Wi-Fi at the venue, or guests without phones? Choose **Pass this phone around** during setup: each guest votes privately on one device, fully offline.

## How it works

Plain HTML, CSS and JavaScript — no build step and no backend of its own, so it runs on GitHub Pages like the snake game.

- Votes travel through [ntfy.sh](https://ntfy.sh), a free public relay that needs no account. Each party uses its own topic named after the party code; guests post their ballot there and the host's screen reads it back.
- The relay keeps messages for 12 hours, so **votes aren't lost if the host's phone locks or drops signal** — the host's screen catches up as soon as the app is open again. Ballots sent after voting closes are ignored.
- If a guest's vote can't be sent (no signal), they see an error and can try again. If lots of guests on the same Wi-Fi vote in the same minute, the app waits and retries automatically.
- The host's results are also saved in their browser, so a refresh doesn't lose them.
- Party topics aren't password-protected: anyone who knows the code could read the raw votes. Fine for a party game; don't use it for anything secret.

```
bollywood-vote/
├── index.html   # page shell, fonts, QR code library
├── style.css    # marigold-and-plum theme
└── app.js       # host, guest, pass-the-phone and reveal flows
```

## Disclaimer

Unofficial, fan-made party game. Not affiliated with any film studio, production house or awards show.
