'use strict';

/**
 * Client MQTT per TV/proiettori Hisense VIDAA (broker integrato, porta 36669, mutual TLS).
 *
 * Due modalita':
 *   - PAIRING: senza token. Genera credenziali dinamiche, fa comparire il PIN, lo invia,
 *     ottiene access/refresh token (evento 'token').
 *   - TOKEN: gia' accoppiato. Riconnette usando clientId/username del pairing + accessToken
 *     come password MQTT.
 *
 * Emette: 'connected', 'closed', 'error', 'token', 'authresult', 'state', 'volume',
 *         'tvinfo', 'sources', 'apps', 'message'(topic,payload).
 */

const mqtt = require('mqtt');
const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');
const { generateCredentials } = require('./credentials');

const PORT = 36669;
const CERT = fs.readFileSync(path.join(__dirname, 'certs', 'vidaa_client.pem'));
const KEY = fs.readFileSync(path.join(__dirname, 'certs', 'vidaa_client.key'));

function subsFor(tc) {
    return [
        '/remoteapp/mobile/broadcast/ui_service/state',
        '/remoteapp/mobile/broadcast/ui_service/volume',
        '/remoteapp/mobile/broadcast/platform_service/actions/volumechange',
        `/remoteapp/mobile/${tc}/ui_service/data/sourcelist`,
        `/remoteapp/mobile/${tc}/ui_service/data/applist`,
        `/remoteapp/mobile/${tc}/ui_service/data/authentication`,
        `/remoteapp/mobile/${tc}/ui_service/data/authenticationcode`,
        `/remoteapp/mobile/${tc}/platform_service/data/tokenissuance`,
        `/remoteapp/mobile/${tc}/platform_service/data/gettvinfo`,
        `/remoteapp/mobile/${tc}/platform_service/data/getdeviceinfo`,
    ];
}

class VidaaClient extends EventEmitter {
    /**
     * @param {object} opts host, uuid, [clientId], [username], [accessToken], [refreshToken], [log]
     */
    constructor(opts) {
        super();
        this.host = opts.host;
        this.uuid = opts.uuid;
        this.clientId = opts.clientId || null;
        this.username = opts.username || null;
        this.accessToken = opts.accessToken || null;
        this.refreshToken = opts.refreshToken || null;
        this.accessTokenExpiresAt = opts.accessTokenExpiresAt || null; // epoch ms
        this.refreshTokenExpiresAt = opts.refreshTokenExpiresAt || null; // epoch ms
        this.log = opts.log || console;
        this.client = null;
        this.connected = false;
        this._pairing = false;
        this._authKind = null; // 'access' | 'refresh'
        this._refreshAfterConnect = false;
        this._refreshFallbackTried = false;
    }

    get tc() {
        return this.clientId;
    }

    // ---- topic helpers --------------------------------------------------
    _tvTopic(svc, action) {
        return `/remoteapp/tv/${svc}/${this.tc}/actions/${action}`;
    }

    // ---- connessione ----------------------------------------------------
    /**
     * @param {'token'|'pairing'} mode
     */
    /**
     * Stato dei token. Un token "valido" ha scadenza nota e futura (con 1h di margine).
     * Le creds legacy senza timestamp → accessToken assunto valido (lo verifica il broker).
     */
    tokenStatus() {
        const now = Date.now();
        const BUF = 60 * 60 * 1000; // margine 1h
        const accessValid = !!this.accessToken && !!this.accessTokenExpiresAt && now < this.accessTokenExpiresAt - BUF;
        const refreshValid = !!this.refreshToken && !!this.refreshTokenExpiresAt && now < this.refreshTokenExpiresAt - BUF;
        const accessUnknown = !!this.accessToken && !this.accessTokenExpiresAt; // legacy
        const accessOk = accessValid || accessUnknown;
        return { accessValid: accessOk, refreshValid, needsRefresh: !accessOk && refreshValid, needsReauth: !accessOk && !refreshValid };
    }

    connect(mode) {
        this._pairing = mode === 'pairing';
        if (this._pairing) {
            const creds = generateCredentials(this.uuid);
            this.clientId = creds.clientId;
            this.username = creds.username; // memorizzato per le riconnessioni col token
            this._open(creds.username, creds.password);
            return this;
        }
        if (!this.clientId || !this.username || (!this.accessToken && !this.refreshToken)) {
            throw new Error('Token mode richiede clientId, username e (access|refresh)Token');
        }
        this._refreshFallbackTried = false;
        this._connectTokenMode();
        return this;
    }

    /** Sceglie access|refresh come password MQTT, in base allo stato dei token, e apre. */
    _connectTokenMode(forceKind) {
        const st = this.tokenStatus();
        const kind = forceKind || (st.accessValid ? 'access' : st.refreshValid ? 'refresh' : null);
        if (!kind) {
            this.log.warn && this.log.warn('VIDAA: access e refresh token scaduti → serve nuovo pairing (PIN)');
            this.emit('needPair');
            return;
        }
        this._authKind = kind;
        this._refreshAfterConnect = kind === 'refresh';
        if (kind === 'refresh') {
            this.log.info && this.log.info('VIDAA: accessToken scaduto → mi connetto col refreshToken e rinnovo i token');
        }
        this._open(this.username, kind === 'access' ? this.accessToken : this.refreshToken);
    }

    _open(username, password) {
        const options = {
            host: this.host,
            port: PORT,
            protocol: 'mqtts',
            clientId: this.clientId,
            username,
            password,
            cert: CERT,
            key: KEY,
            rejectUnauthorized: false,
            protocolVersion: 4, // MQTT 3.1.1
            reconnectPeriod: 0, // riconnessione gestita dall'adapter (con la password giusta)
            connectTimeout: 15000,
            clean: true,
        };

        this.client = mqtt.connect(options);

        this.client.on('connect', () => {
            this.connected = true;
            this._refreshFallbackTried = false;
            subsFor(this.tc).forEach((t) => this.client.subscribe(t));
            this.emit('connected', { pairing: this._pairing });
            if (this._pairing) {
                this.startPairing();
            } else if (this._refreshAfterConnect) {
                this._refreshAfterConnect = false;
                setTimeout(() => this.refresh(), 800); // conia subito un accessToken fresco
                setTimeout(() => this.queryAll(), 2200);
            } else {
                this.queryAll();
            }
        });

        this.client.on('message', (topic, payload) => this._onMessage(topic, payload.toString('utf8')));
        this.client.on('error', (err) => this._onError(err));
        this.client.on('close', () => {
            this.connected = false;
            this.emit('closed');
        });
    }

    /** CONNACK rc=5 / "Not authorized": se ho usato l'accessToken, ritento col refreshToken. */
    _onError(err) {
        this.emit('error', err);
        if (this.connected || this._pairing) return;
        const msg = String((err && (err.message || err.code)) || err).toLowerCase();
        const authFail = (err && err.code === 5) || msg.includes('not authorized') || msg.includes('code: 5') || msg.includes('code 5');
        if (!authFail) return;
        if (this._authKind === 'access' && this.refreshToken && !this._refreshFallbackTried) {
            this._refreshFallbackTried = true;
            this.log.info && this.log.info('VIDAA: login con accessToken rifiutato → ritento col refreshToken');
            try { this.client && this.client.end(true); } catch (e) { /* noop */ }
            this._connectTokenMode('refresh');
        } else if (this._authKind === 'refresh') {
            this.log.warn && this.log.warn("VIDAA: anche il refreshToken e' rifiutato → serve nuovo pairing (PIN)");
            this.emit('needPair');
        }
    }

    disconnect() {
        if (this.client) {
            try {
                this.client.end(true);
            } catch (e) {
                /* noop */
            }
            this.client = null;
        }
        this.connected = false;
    }

    _publish(topic, payload) {
        if (!this.client) return;
        const data = typeof payload === 'string' ? payload : JSON.stringify(payload);
        this.client.publish(topic, data);
    }

    // ---- pairing --------------------------------------------------------
    /** Fa comparire il PIN sullo schermo. */
    startPairing() {
        this._publish(this._tvTopic('ui_service', 'vidaa_app_connect'), {
            app_version: 2,
            connect_result: 0,
            device_type: 'Mobile App',
        });
        this.emit('pinRequested');
    }

    /** Invia il PIN (INTERO!) e richiede il token. */
    submitPin(pin) {
        const n = parseInt(String(pin).replace(/\D/g, ''), 10);
        if (Number.isNaN(n)) {
            this.emit('error', new Error('PIN non valido'));
            return;
        }
        this._publish(this._tvTopic('ui_service', 'authenticationcode'), { authNum: n });
        setTimeout(() => {
            this._publish(`/remoteapp/tv/platform_service/${this.tc}/data/gettoken`, { refreshtoken: '' });
            this._publish(this._tvTopic('ui_service', 'authenticationcodeclose'), '');
        }, 1200);
    }

    /** Rinnova l'accessToken usando il refreshToken (prima della scadenza). */
    refresh() {
        if (!this.refreshToken) return;
        this._publish(`/remoteapp/tv/platform_service/${this.tc}/data/gettoken`, {
            refreshtoken: this.refreshToken,
        });
    }

    // ---- comandi --------------------------------------------------------
    sendKey(key) {
        this._publish(`/remoteapp/tv/remote_service/${this.tc}/actions/sendkey`, String(key));
    }

    /**
     * "Digita" un numero di canale in sorgente DTV/TV: invia i tasti numerici uno a uno
     * (con una piccola pausa), `.`/`-` → KEY_CHANNELDOT. Il device sintonizza dopo le cifre.
     */
    async sendChannel(input) {
        const s = String(input).trim();
        for (const ch of s) {
            let key = null;
            if (ch >= '0' && ch <= '9') key = `KEY_${ch}`;
            else if (ch === '.' || ch === '-') key = 'KEY_CHANNELDOT';
            if (!key) continue; // ignora separatori/spazi
            this.sendKey(key);
            await new Promise((r) => setTimeout(r, 280)); // pausa tra le cifre (il device le accoda)
        }
    }

    setVolume(value) {
        const v = Math.max(0, Math.min(100, parseInt(value, 10) || 0));
        this._publish(`/remoteapp/tv/platform_service/${this.tc}/actions/changevolume`, String(v));
    }

    setSource(sourceId) {
        this._publish(this._tvTopic('ui_service', 'changesource'), { sourceid: String(sourceId) });
    }

    launchApp(app) {
        // il proiettore vuole un sottoinsieme {appId, name, url}, non l'oggetto intero dell'applist
        const payload =
            app && typeof app === 'object' ? { appId: app.appId, name: app.name, url: app.url } : app;
        this._publish(this._tvTopic('ui_service', 'launchapp'), payload);
    }

    queryAll() {
        this._publish(this._tvTopic('ui_service', 'gettvstate'), '');
        this._publish(`/remoteapp/tv/platform_service/${this.tc}/actions/getvolume`, '');
        this._publish(this._tvTopic('ui_service', 'sourcelist'), '');
        this._publish(this._tvTopic('ui_service', 'applist'), '');
        this._publish(`/remoteapp/tv/platform_service/${this.tc}/actions/gettvinfo`, '');
    }

    // ---- parsing messaggi ----------------------------------------------
    _onMessage(topic, text) {
        this.emit('message', topic, text);
        let data = null;
        try {
            data = JSON.parse(text);
        } catch (e) {
            data = text;
        }
        const t = topic.toLowerCase();

        if (t.includes('tokenissuance') || (data && data.accesstoken)) {
            if (data && data.accesstoken) {
                this.accessToken = data.accesstoken;
                this.refreshToken = data.refreshtoken || this.refreshToken;
                this.emit('token', {
                    clientId: this.clientId,
                    username: this.username,
                    uuid: this.uuid,
                    accessToken: data.accesstoken,
                    refreshToken: data.refreshtoken,
                    accessTokenDurationDay: data.accesstoken_duration_day,
                    refreshTokenDurationDay: data.refreshtoken_duration_day,
                });
            }
            return;
        }
        if (t.includes('/authenticationcode')) {
            this.emit('authresult', data); // {result:1,...}
            return;
        }
        if (t.endsWith('/state')) {
            this.emit('state', data);
            return;
        }
        if (t.endsWith('/volume') || t.includes('volumechange')) {
            this.emit('volume', data);
            return;
        }
        if (t.includes('gettvinfo') || t.includes('getdeviceinfo')) {
            this.emit('tvinfo', data);
            return;
        }
        if (t.includes('sourcelist')) {
            this.emit('sources', data);
            return;
        }
        if (t.includes('applist')) {
            this.emit('apps', data);
            return;
        }
    }
}

module.exports = VidaaClient;
