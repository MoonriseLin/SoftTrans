# Softdrop project bundle

Everything needed to start building Softdrop with Claude Code.

```
softdrop/
├── CLAUDE.md                 Project brief. Claude Code reads this automatically.
├── README.md                 This file.
├── prototype/
│   └── index.html            Front-end prototype (simulated devices). Open it in a browser.
└── docs/
    ├── design-plan.md        Layout, look and wording decisions.
    ├── protocol-draft.md     Draft signaling and data-channel messages.
    └── deploy-notes.md       VPS setup notes, coturn config, ports.
```

## Start

1. Unzip, then `cd softdrop`.
2. Open `prototype/index.html` in a browser to see the target look. Try the theme button, drop a file, send text, and use "Preview another incoming transfer".
3. Run `claude` in this folder. It loads `CLAUDE.md` for context.
4. A good first prompt:

   > Read CLAUDE.md and the docs. Start with build step 1: a signaling server in TypeScript with `ws` that groups devices by public IP and relays offer, answer and ICE messages, following docs/protocol-draft.md. Add a minimal test client. Do not touch the prototype yet.

5. Then, step by step: wire the prototype to the real server and WebRTC, then add the transfer protocol, pairing and identity.

## The planning doc

The same design plan lives as a Claude Doc from the original conversation. It was the source for `docs/design-plan.md`.
