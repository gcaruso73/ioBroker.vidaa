# Credits & Acknowledgements

This adapter would not exist without the community reverse-engineering of the **Hisense VIDAA**
MQTT protocol. Huge thanks to the people and projects below — they saved an enormous amount of work.

## Primary source

### [tombabolewski/vidaa-control](https://github.com/tombabolewski/vidaa-control) — MIT
Copyright (c) 2025 Tom Babolewski.

This was the decisive reference for the "modern" VIDAA firmware. From this project we used:

- **The dynamic credential algorithm** — `lib/credentials.js` is a JavaScript port of
  `vidaa/credentials.py` (XOR-timestamp + MD5 scheme, reverse-engineered from `libmqttcrypt.so`).
- **The protocol details and exact MQTT topics** — pairing flow (`vidaa_app_connect`, the
  **integer** `authNum`, `gettoken` → `tokenissuance`) and the exact subscribe/publish topics
  (`docs/PROTOCOL.md`, `vidaa/topics.py`).
- **The client certificate** — `lib/certs/vidaa_client.pem` and `lib/certs/vidaa_client.key` are
  the recent VIDAA app certificate taken from `vidaa/certs/`. Mutual TLS with this certificate is
  required by current firmware (older certificates are rejected by the device as "app obsolete").

The certificate itself originates from Hisense's official VIDAA mobile app and is redistributed
here solely for local interoperability with hardware the user owns.

## Additional references consulted

- [Krazy998/mqtt-hisensetv](https://github.com/Krazy998/mqtt-hisensetv) — MIT — original
  documentation of the Hisense built-in MQTT broker (port 36669, `hisenseservice`/`multimqttservice`,
  base topic structure).
- [warrenrees/ha_vidaatv](https://github.com/warrenrees/ha_vidaatv) — MIT — Home Assistant
  integration for Hisense/VIDAA TVs (MQTT control, PIN pairing).
- [sehaas/ha_hisense_tv](https://github.com/sehaas/ha_hisense_tv) — MIT — Hisense TV integration
  for Home Assistant.
- [d3nd3/Hisense-mqtt-keyfiles](https://github.com/d3nd3/Hisense-mqtt-keyfiles) — older Hisense
  MQTT keyfiles, used during investigation (not bundled in this adapter).
- `hisensetv` (instalator and contributors) — earlier Hisense MQTT reverse-engineering.

If you maintain one of these projects and want the attribution changed or removed, please open an
issue — credit where credit is due, and corrections are welcome.

---

## Third-party license notices

Portions of this project (the credential algorithm and the bundled client certificate) derive from
**vidaa-control**, distributed under the MIT License:

```
MIT License

Copyright (c) 2025 Tom Babolewski

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
