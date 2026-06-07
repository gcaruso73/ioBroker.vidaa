'use strict';

/**
 * Generazione credenziali dinamiche per la connessione MQTT a TV/proiettori Hisense VIDAA.
 *
 * Algoritmo reverse-engineered da libmqttcrypt.so dell'app VIDAA (metodo MODERN, firmware >= 3290).
 * Porting in JS dell'algoritmo di riferimento (vidaa-control/credentials.py).
 *
 *  - client_id = `${uuid}$his$${race}_vidaacommon_001`,  race = MD5(`${PATTERN}$${uuid}`)[:6]
 *  - username  = `his$${timestamp XOR 0x569814772b03a968}`
 *  - value     = `his${sum_digits(ts)%10}${VALUE_SUFFIX_MODERN}`,  value_md5 = MD5(value)[:6]
 *  - password  = MD5(`${ts}$${value_md5}`)
 *
 * MD5 sempre in HEX MAIUSCOLO. timestamp = Unix in SECONDI.
 */

const crypto = require('crypto');

const PATTERN = '38D65DC30F45109A369A86FCE866A85B';
const VALUE_SUFFIX_MODERN = 'h!i@s#$v%i^d&a*a';
const TIME_XOR_CONSTANT = 0x569814772b03a968n; // 64 bit -> BigInt
const BRAND = 'his';
const OPERATION = 'vidaacommon';

function md5Upper(str) {
    return crypto.createHash('md5').update(str, 'utf8').digest('hex').toUpperCase();
}

function sumDigits(n) {
    return String(Math.abs(n))
        .split('')
        .reduce((acc, d) => acc + Number(d), 0);
}

/**
 * Genera un identificativo tipo MAC (AA:BB:CC:DD:EE:FF) casuale ma stabile.
 * Va memorizzato nella config dell'istanza per mantenere lo stesso client_id.
 */
function generateUuid() {
    const hex = crypto.randomBytes(6).toString('hex').toUpperCase();
    return hex.match(/.{2}/g).join(':');
}

/**
 * @param {string} uuid  MAC/identificativo stabile (AA:BB:..)
 * @param {number} [timestamp] Unix in secondi (default: ora)
 * @returns {{clientId:string, username:string, password:string, timestamp:number}}
 */
function generateCredentials(uuid, timestamp) {
    const ts = timestamp || Math.floor(Date.now() / 1000);

    const race = md5Upper(`${PATTERN}$${uuid}`).slice(0, 6);
    const clientId = `${uuid}$${BRAND}$${race}_${OPERATION}_001`;

    const xorTime = BigInt(ts) ^ TIME_XOR_CONSTANT;
    const username = `${BRAND}$${xorTime.toString()}`;

    const remainder = sumDigits(ts) % 10;
    const valueMd5 = md5Upper(`${BRAND}${remainder}${VALUE_SUFFIX_MODERN}`).slice(0, 6);
    const password = md5Upper(`${ts}$${valueMd5}`);

    return { clientId, username, password, timestamp: ts };
}

module.exports = {
    generateCredentials,
    generateUuid,
    md5Upper,
    sumDigits,
    PATTERN,
    VALUE_SUFFIX_MODERN,
    TIME_XOR_CONSTANT,
    BRAND,
    OPERATION,
};
