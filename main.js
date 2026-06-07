'use strict';

/**
 * ioBroker.vidaa — controllo TV/proiettori Hisense VIDAA via il broker MQTT integrato.
 * Stile upstream: classe singola Vidaa extends utils.Adapter + helper in lib/.
 *
 * Le credenziali di pairing (uuid, clientId, username, accessToken, refreshToken, host) vengono
 * salvate nello STATO `info.credentials` (JSON), NON nella config native dell'istanza: così il
 * pannello admin non le sovrascrive e non si innescano riavvii a ogni salvataggio del token.
 */

const utils = require('@iobroker/adapter-core');
const VidaaClient = require('./lib/vidaa-client');
const { generateUuid } = require('./lib/credentials');

const KEY_BUTTONS = {
    power: 'KEY_POWER',
    volumeUp: 'KEY_VOLUMEUP',
    volumeDown: 'KEY_VOLUMEDOWN',
    mute: 'KEY_MUTE',
    up: 'KEY_UP',
    down: 'KEY_DOWN',
    left: 'KEY_LEFT',
    right: 'KEY_RIGHT',
    ok: 'KEY_OK',
    back: 'KEY_BACK',
    home: 'KEY_HOME',
    menu: 'KEY_MENU',
    exit: 'KEY_EXIT',
    play: 'KEY_PLAY',
    pause: 'KEY_PAUSE',
    stop: 'KEY_STOP',
};

const SOURCE_STATES = { '0': 'TV', '1': 'AV', '2': 'Component', '3': 'HDMI1', '4': 'HDMI2', '5': 'HDMI3', '6': 'HDMI4' };

class Vidaa extends utils.Adapter {
    constructor(options) {
        super({ ...options, name: 'vidaa' });
        this.client = null;
        this.pairClient = null;
        this.refreshTimer = null;
        this.apps = [];
        this.creds = {}; // { host, uuid, clientId, username, accessToken, refreshToken }
        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('message', this.onMessage.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    async onReady() {
        this.setState('info.connection', false, true);
        await this.createObjects();
        this.subscribeStates('control.*');

        await this.loadCreds();
        if (!this.creds.uuid) {
            this.creds.uuid = generateUuid();
            await this.saveCreds();
            this.log.info(`Generato uuid client ${this.creds.uuid}`);
        }

        const host = this.config.host || this.creds.host;
        if (!host) {
            this.log.warn('Nessun IP configurato. Apri le impostazioni e fai il pairing.');
            return;
        }
        if (!this.creds.accessToken) {
            this.log.warn('Non accoppiato. Apri le impostazioni → Avvia pairing e inserisci il PIN.');
            return;
        }
        this.connectToken();
    }

    // ---- credenziali in stato (non in native!) -------------------------
    async loadCreds() {
        try {
            const st = await this.getStateAsync('info.credentials');
            this.creds = st && st.val ? JSON.parse(st.val) : {};
        } catch (e) {
            this.creds = {};
        }
    }

    async saveCreds() {
        await this.setStateAsync('info.credentials', JSON.stringify(this.creds), true);
    }

    // ---- connessione (token mode) --------------------------------------
    connectToken() {
        const host = this.config.host || this.creds.host;
        this.client = new VidaaClient({
            host,
            uuid: this.creds.uuid,
            clientId: this.creds.clientId,
            username: this.creds.username,
            accessToken: this.creds.accessToken,
            refreshToken: this.creds.refreshToken,
            log: this.log,
        });

        this.client.on('connected', () => {
            this.log.info('Connesso al proiettore VIDAA');
            this.setState('info.connection', true, true);
        });
        this.client.on('closed', () => this.setState('info.connection', false, true));
        this.client.on('error', (e) => this.log.debug(`MQTT error: ${e && e.message}`));
        this.client.on('state', (d) => this.onTvState(d));
        this.client.on('volume', (d) => this.onTvVolume(d));
        this.client.on('apps', (d) => this.onApps(d));
        this.client.on('token', (tok) => this.saveToken(tok));

        this.client.connect('token');

        if (!this.refreshTimer) {
            this.refreshTimer = this.setInterval(() => this.client && this.client.refresh(), 24 * 3600 * 1000);
        }
    }

    async saveToken(tok) {
        Object.assign(this.creds, {
            clientId: tok.clientId,
            username: tok.username,
            uuid: tok.uuid || this.creds.uuid,
            accessToken: tok.accessToken,
            refreshToken: tok.refreshToken || this.creds.refreshToken,
        });
        await this.saveCreds();
        if (this.client) {
            this.client.accessToken = this.creds.accessToken;
            this.client.refreshToken = this.creds.refreshToken;
        }
        this.log.info('Token VIDAA aggiornato e salvato');
    }

    // ---- oggetti --------------------------------------------------------
    async createObjects() {
        // info.credentials (serve anche su upgrade, dove gli instanceObjects non vengono ricreati)
        await this.setObjectNotExistsAsync('info.credentials', {
            type: 'state',
            common: { name: 'Pairing credentials (internal)', type: 'string', role: 'json', read: true, write: false, def: '' },
            native: {},
        });

        const C = (id, common) => this.setObjectNotExistsAsync(`control.${id}`, { type: 'state', common, native: {} });
        const S = (id, common) => this.setObjectNotExistsAsync(`state.${id}`, { type: 'state', common, native: {} });

        for (const id of Object.keys(KEY_BUTTONS)) {
            await C(id, { name: id, type: 'boolean', role: 'button', read: false, write: true, def: false });
        }
        await C('volume', { name: 'volume', type: 'number', role: 'level.volume', min: 0, max: 100, read: true, write: true });
        await C('key', { name: 'send raw KEY_*', type: 'string', role: 'text', read: false, write: true });
        await C('source', { name: 'source/input', type: 'string', role: 'media.input', read: true, write: true, states: SOURCE_STATES });
        await C('app', { name: 'launch app by name', type: 'string', role: 'text', read: true, write: true });
        await S('apps', { name: 'installed apps (json)', type: 'string', role: 'json', read: true, write: false });

        await S('volume', { name: 'volume', type: 'number', role: 'level.volume', min: 0, max: 100, read: true, write: false });
        await S('mute', { name: 'mute', type: 'boolean', role: 'media.mute', read: true, write: false });
        await S('source', { name: 'source', type: 'string', role: 'media.input', read: true, write: false });
        await S('statetype', { name: 'state type', type: 'string', role: 'text', read: true, write: false });
        await S('raw', { name: 'raw broadcast (json)', type: 'string', role: 'json', read: true, write: false });
    }

    // ---- eventi dalla TV ------------------------------------------------
    onTvState(d) {
        if (!d || typeof d !== 'object') return;
        this.setState('state.raw', JSON.stringify(d), true);
        if (d.statetype) this.setState('state.statetype', d.statetype, true);
        if (d.sourcename || d.sourceid) {
            const src = d.sourcename || SOURCE_STATES[String(d.sourceid)] || String(d.sourceid);
            this.setState('state.source', src, true);
            this.setState('control.source', String(d.sourceid), true);
        }
    }

    onTvVolume(d) {
        if (d && typeof d === 'object' && d.volume_value !== undefined) {
            this.setState('state.volume', Number(d.volume_value), true);
            this.setState('control.volume', Number(d.volume_value), true);
        }
    }

    async onApps(d) {
        if (!Array.isArray(d)) return;
        this.apps = d.filter((a) => a && a.name);
        const list = this.apps.map((a) => ({ name: a.name, appId: a.appId, url: a.url }));
        this.setState('state.apps', JSON.stringify(list), true);
        // popola il menu a tendina di control.app con i nomi delle app installate
        const states = {};
        for (const a of this.apps) states[a.name] = a.name;
        try {
            await this.extendObjectAsync('control.app', { common: { states } });
        } catch (e) {
            this.log.debug(`extend control.app states: ${e && e.message}`);
        }
    }

    // ---- comandi da ioBroker -------------------------------------------
    onStateChange(id, state) {
        if (!state || state.ack) return;
        if (!this.client || !this.client.connected) {
            this.log.warn('Comando ignorato: non connesso al proiettore');
            return;
        }
        const key = id.split('.').pop();
        if (KEY_BUTTONS[key]) {
            this.client.sendKey(KEY_BUTTONS[key]);
        } else if (key === 'volume') {
            this.client.setVolume(state.val);
        } else if (key === 'key') {
            if (state.val) this.client.sendKey(String(state.val));
        } else if (key === 'source') {
            this.client.setSource(state.val);
        } else if (key === 'app') {
            const app = this.apps.find((a) => a && (a.name === state.val || a.appId === String(state.val)));
            if (app) this.client.launchApp(app);
            else this.log.warn(`App non trovata: ${state.val}`);
        }
    }

    // ---- messaggi admin (pairing) --------------------------------------
    async onMessage(obj) {
        if (!obj || !obj.command) return;
        const reply = (res) => obj.callback && this.sendTo(obj.from, obj.command, res, obj.callback);

        if (obj.command === 'pairStart') {
            const host = (obj.message && obj.message.host) || this.config.host || this.creds.host;
            if (!host) return reply({ error: 'Inserisci prima l\'IP del proiettore' });
            if (!this.creds.uuid) {
                this.creds.uuid = generateUuid();
                await this.saveCreds();
            }
            try {
                if (this.pairClient) this.pairClient.disconnect();
                this.pairClient = new VidaaClient({ host, uuid: this.creds.uuid, log: this.log });
                let replied = false;
                this.pairClient.once('pinRequested', () => {
                    if (!replied) { replied = true; reply({ result: 'PIN mostrato sullo schermo del proiettore. Inseriscilo qui sotto e premi «Conferma PIN».' }); }
                });
                this.pairClient.once('error', (e) => {
                    if (!replied) { replied = true; reply({ error: String((e && e.message) || e) }); }
                });
                setTimeout(() => { if (!replied) { replied = true; reply({ error: 'Timeout connessione al proiettore' }); } }, 15000);
                this.pairClient.connect('pairing');
            } catch (e) {
                reply({ error: String(e.message || e) });
            }
            return;
        }

        if (obj.command === 'pairSubmit') {
            const pin = obj.message && obj.message.pin;
            if (!this.pairClient) return reply({ error: 'Avvia prima il pairing' });
            if (!pin) return reply({ error: 'Inserisci il PIN' });
            let replied = false;
            this.pairClient.once('token', async (tok) => {
                if (replied) return;
                replied = true;
                Object.assign(this.creds, {
                    host: this.pairClient.host,
                    uuid: tok.uuid || this.creds.uuid,
                    clientId: tok.clientId,
                    username: tok.username,
                    accessToken: tok.accessToken,
                    refreshToken: tok.refreshToken,
                });
                await this.saveCreds();
                this.pairClient.disconnect();
                this.pairClient = null;
                // avvia subito la connessione vera (senza riavvio)
                if (this.client) this.client.disconnect();
                this.client = null;
                this.connectToken();
                reply({ result: 'Pairing riuscito! Connessione in corso.' });
            });
            setTimeout(() => { if (!replied) { replied = true; reply({ error: 'Nessun token (PIN errato o scaduto). Riprova.' }); } }, 12000);
            this.pairClient.submitPin(pin);
            return;
        }
    }

    onUnload(callback) {
        try {
            if (this.refreshTimer) this.clearInterval(this.refreshTimer);
            if (this.client) this.client.disconnect();
            if (this.pairClient) this.pairClient.disconnect();
            this.setState('info.connection', false, true);
            callback();
        } catch (e) {
            callback();
        }
    }
}

if (require.main !== module) {
    module.exports = (options) => new Vidaa(options);
} else {
    new Vidaa();
}
