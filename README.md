# ioBroker.vidaa

Control **Hisense VIDAA** TVs and projectors (e.g. *Hisense Laser Mini Projector M2 Pro*) from
ioBroker, via the device's **built-in MQTT broker** (port 36669, mutual TLS).

There is no official Hisense/VIDAA API; this adapter speaks the reverse-engineered VIDAA MQTT
protocol used by the official mobile app. Modern VIDAA firmware needs a one-time **PIN pairing**
(the PIN appears on the screen); after that the adapter stores the access/refresh tokens and
reconnects automatically.

## Setup

1. Install the adapter and create an instance.
2. Open the instance settings.
3. Enter the **IP** of the projector/TV.
4. Press **Start pairing** → a PIN appears on the device screen.
5. Type the PIN within ~15 seconds and press **Confirm PIN**.
6. The adapter restarts and connects. `info.connection` becomes `true`.

The device must be on or in **network standby** (enable *Quick start* / network standby), otherwise
the MQTT broker is not reachable.

## Objects

- `control.power`, `control.volumeUp/volumeDown`, `control.mute`, `control.up/down/left/right/ok`,
  `control.back/home/menu/exit`, `control.play/pause/stop` — remote keys (write `true`).
- `control.volume` — set volume 0–100.
- `control.source` — switch input (0=TV, 3=HDMI1, 4=HDMI2, …).
- `control.app` — launch an installed app by name (e.g. `Netflix`).
- `control.key` — send any raw `KEY_*`.
- `state.volume`, `state.source`, `state.statetype`, `state.raw` — live status from the device.

## Notes / limitations

- Reverse-engineered protocol; behaviour may vary by model/firmware.
- Power-on over MQTT only works from network standby; from full power-off use Wake-on-LAN.
- The bundled client certificate corresponds to a recent VIDAA app; older certs are rejected
  ("app obsolete").

## Credits

This adapter stands on community reverse-engineering of the VIDAA MQTT protocol. In particular the
credential algorithm, protocol/topics and the bundled client certificate come from
**[tombabolewski/vidaa-control](https://github.com/tombabolewski/vidaa-control)** (MIT, © 2025 Tom
Babolewski), with additional references from `Krazy998/mqtt-hisensetv`, `warrenrees/ha_vidaatv`,
`sehaas/ha_hisense_tv` and others.

Full acknowledgements and third-party license notices: see **[CREDITS.md](CREDITS.md)**.

## License

MIT © Giovanni Caruso. Includes MIT-licensed portions © 2025 Tom Babolewski (see CREDITS.md).
