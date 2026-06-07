'use strict';

/**
 * ioBroker.vidaa — controllo TV/proiettori Hisense VIDAA via il broker MQTT integrato.
 * Stile upstream: classe singola Vidaa extends utils.Adapter + helper in lib/.
 */

const utils = require('@iobroker/adapter-core');
const VidaaClient = require('./lib/vidaa-client');
const { generateUuid } = require('./lib/credentials');

// mappa pulsanti control -> tasto KEY_* del telecomando
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
        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('message', this.onMessage.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    async onReady() {
        this.setState('info.connection', false, true);

        // uuid stabile (identifica il client; va mantenuto)
        if (!this.config.uuid) {
            const uuid = generateUuid();
            await this.extendForeignObjectAsync(`system.adapter.${this.namespace}`, { native: { uuid } });
            this.log.info(`Generato uuid client ${uuid} (riavvio per applicarlo)`);
            return; // il restart riparte con uuid in config
        }

        await this.createObjects();
        this.subscribeStates('control.*');

        if (!this.config.host) {
            this.log.warn('Nessun IP configurato. Apri le impostazioni e fai il pairing.');
            return;
        }
        if (!this.config.accessToken) {
            this.log.warn('Non accoppiato. Apri le impostazioni → Avvia pairing e inserisci il PIN.');
            return;
        }
        this.connectToken();
    }

    connectToken() {
        this.client = new VidaaClient({
            host: this.config.host,
            uuid: this.config.uuid,
            clientId: this.config.clientId,
            username: this.config.username,
            accessToken: this.config.accessToken,
            refreshToken: this.config.refreshToken,
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
        this.client.on('apps', (d) => {
            if (Array.isArray(d)) this.apps = d;
        });
        this.client.on('token', (tok) => this.saveToken(tok));

        this.client.connect('token');

        // refresh token ogni 24h (accessToken dura ~48h)
        this.refreshTimer = this.setInterval(() => this.client && this.client.refresh(), 24 * 3600 * 1000);
    }

    async saveToken(tok) {
        await this.extendForeignObjectAsync(`system.adapter.${this.namespace}`, {
            native: {
                clientId: tok.clientId,
                username: tok.username,
                uuid: tok.uuid,
                accessToken: tok.accessToken,
                refreshToken: tok.refreshToken,
            },
        });
        this.log.info('Token VIDAA aggiornato e salvato');
    }

    // ---- oggetti --------------------------------------------------------
    async createObjects() {
        const C = (id, common) => this.setObjectNotExistsAsync(`control.${id}`, { type: 'state', common, native: {} });
        const S = (id, common) => this.setObjectNotExistsAsync(`state.${id}`, { type: 'state', common, native: {} });

        // pulsanti
        for (const id of Object.keys(KEY_BUTTONS)) {
            const role = id === 'mute' ? 'button' : (id.startsWith('volume') ? 'button' : 'button');
            await C(id, { name: id, type: 'boolean', role, read: false, write: true, def: false });
        }
        await C('volume', { name: 'volume', type: 'number', role: 'level.volume', min: 0, max: 100, read: true, write: true });
        await C('key', { name: 'send raw KEY_*', type: 'string', role: 'text', read: false, write: true });
        await C('source', { name: 'source/input', type: 'string', role: 'media.input', read: true, write: true, states: SOURCE_STATES });
        await C('app', { name: 'launch app by name', type: 'string', role: 'text', read: false, write: true });

        // stati
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
            const host = (obj.message && obj.message.host) || this.config.host;
            if (!host) return reply({ error: 'Inserisci prima l\'IP del proiettore' });
            try {
                if (this.pairClient) this.pairClient.disconnect();
                this.pairClient = new VidaaClient({ host, uuid: this.config.uuid, log: this.log });
                let replied = false;
                this.pairClient.once('pinRequested', () =>
                    !replied && (replied = true, reply({ result: 'PIN mostrato sullo schermo del proiettore. Inseriscilo qui sotto.' })));
                this.pairClient.once('error', (e) => !replied && (replied = true, reply({ error: String(e && e.message || e) })));
                setTimeout(() => !replied && (replied = true, reply({ error: 'Timeout connessione al proiettore' })), 15000);
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
                await this.extendForeignObjectAsync(`system.adapter.${this.namespace}`, {
                    native: {
                        host: this.pairClient.host,
                        clientId: tok.clientId,
                        username: tok.username,
                        uuid: tok.uuid,
                        accessToken: tok.accessToken,
                        refreshToken: tok.refreshToken,
                    },
                });
                this.pairClient.disconnect();
                this.pairClient = null;
                reply({ result: 'Pairing riuscito! L\'adapter si riavvia e si connette.' });
            });
            setTimeout(() => !replied && (replied = true, reply({ error: 'Nessun token (PIN errato o scaduto). Riprova.' })), 12000);
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
