# Design plan: soft, LAN-first transfer

## Plan change: one web app on WebRTC

Because the computer side is a browser page, WebRTC is the right transport, and the computer needs no install.

The phone can use the same page as a PWA in Safari. That gives one codebase, with no $99 Apple developer fee and no Mac required.

The trade-off is that background transfers are lost: the page must stay open on the phone. For sending a file or some text that is usually fine. A native iOS app only becomes worth building later if you need background relay or push notifications.

## Layout: one calm screen, three parts

1. **Nearby devices.** Soft circular avatars float on a gentle ripple, like a quiet radar. Devices on the same Wi-Fi appear automatically, and tapping one selects it as the recipient.
2. **Drop zone.** A large card with rounded edges that gently "breathes". Drop files or paste text onto it. A text field sits inside the same card.
3. **Incoming transfers.** A slim card slides up with Accept and Decline, then turns into a progress ring once accepted.

The prototype adds two more parts: a pairing strip ("Different network?") with a 4-digit code, and an activity list that holds sent and received items.

As built (October 2026), top to bottom: a compact 3:2 radar, a one-line bar showing the newest item received from another device (tap it to jump to that item; it has Copy or Save), the send card, the activity list, then the pairing strip.

## Look: warm, rounded, slow-moving

| Aspect | Direction |
| --- | --- |
| Color | Warm off-white background (for example `#FAF7F2`) with one muted accent. Peach was chosen. No pure black, no saturated colors. Dark mode is a dusky blue-gray, not black. |
| Shape | Large radii (20–28 px) and no hard borders. Things are separated by diffuse, low-opacity shadows and tonal layers. |
| Type | A rounded or humanist sans (Figtree in the prototype). A soft serif (Fraunces) for the title. |
| Motion | Spring-like easing, 250–400 ms, nothing that snaps. Slow pulse while discovering devices, soft glow when a file hovers over the drop zone, smooth ring fill for progress. |
| Wording | Gentle and short: "Looking for devices nearby…", "Sent ✓". |

## Transfer-mode label

Each transfer carries a small, quiet label, either "Direct · same Wi-Fi" or "Via relay".

It shows the user that the LAN-first design is working, and it explains slowness when a transfer falls back to the VPS relay.

## Decisions

- Accent color: peach.
- Phone: PWA, not a native iOS app.
- Transport: WebRTC, with signaling and relay on the VPS.
