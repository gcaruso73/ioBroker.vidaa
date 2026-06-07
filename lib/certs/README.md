# Client certificate (mutual TLS)

`vidaa_client.pem` / `vidaa_client.key` is the **client certificate** required for the mutual-TLS
MQTT connection to modern Hisense VIDAA devices (port 36669). Without a recent certificate the
device rejects the connection ("app obsolete").

Source: [tombabolewski/vidaa-control](https://github.com/tombabolewski/vidaa-control)
(`vidaa/certs/`), MIT License, Copyright (c) 2025 Tom Babolewski.

The certificate ultimately originates from Hisense's official VIDAA mobile app and is redistributed
here only for local interoperability with hardware the user owns. See `../../CREDITS.md`.
