import axios from 'axios';
import protobuf from 'protobufjs';
import * as R from 'ramda';
import fs from 'fs';
import crypto from 'crypto';
import hkdf from 'js-crypto-hkdf';
import yaml from 'js-yaml';

import {
  StickerPackJson,
  StickerPackManifest
} from 'etc/types';
import ErrorWithCode from 'lib/error';

// ----- Locals ----------------------------------------------------------------

const stickers = yaml.safeLoad(fs.readFileSync('./stickers.yml'));

/**
 * Module-local gRPC client used to parse sticker pack manifests from the Signal
 * CDN.
 */
const StickersProto = fs.readFileSync('src/etc/Stickers.proto');
const protobufClient = protobuf.parse(StickersProto).root;

/**
 * See: https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto/deriveKey
 */
async function deriveKeys(encodedKey: string) {
  const masterKey = Buffer.from(encodedKey, 'hex');
  const hash = 'SHA-256';
  const length = 512;
  const info = 'Sticker Pack';
  const salt = new ArrayBuffer(32);
  const derivedKey = (await hkdf.compute(masterKey, hash, length, info, salt)).key;
  return [derivedKey.slice(0, 32), derivedKey.slice(32, 64)];
}

/**
 * Decrypts a manifest returned from the Signal API using a sticker pack's
 * pack key.
 */
async function decryptManifest(encodedKey: string, rawManifest: any) {
  const [aesKey, hmacKey] = await deriveKeys(encodedKey);

  // rawManifest: IV || Ciphertext || truncated MAC(IV||Ciphertext)
  const theirIv = rawManifest.slice(0, 16);
  const cipherTextBody = rawManifest.slice(16, rawManifest.length - 32);
  const theirMac = rawManifest.slice(rawManifest.byteLength - 32, rawManifest.byteLength).toString('hex');
  const combinedCipherText = rawManifest.slice(0, rawManifest.byteLength - 32);

  // Validate signature
  const computedMac = crypto.createHmac('sha256', hmacKey).update(combinedCipherText).digest('hex');
  if (theirMac !== computedMac) {
    throw new Error(`MAC verification failed.`);
  }

  const decipher = crypto.createDecipheriv('aes-256-cbc', aesKey, theirIv);
  return Buffer.concat([decipher.update(cipherTextBody), decipher.final()]);
}

/**
 * Provided a key and an encrypted manifest from the Signal API, resolves with a
 * decrypted and parsed manifest.
 */
async function parseManifest(key: string, rawManifest: any): Promise<StickerPackManifest> {
  try {
    const manifest = await decryptManifest(key, rawManifest);
    const PackMessage = protobufClient.lookupType('Pack');
    const manifestData = new Uint8Array(manifest, 0, manifest.byteLength);
    return PackMessage.decode(manifestData) as unknown as StickerPackManifest;
  } catch (err) {
    throw new ErrorWithCode(err.code || 'MANIFEST_PARSE', `[parseManifest] ${err.message}`);
  }
}

/**
 * Waits for a random number of ms between min and max before resolving the promise.
 */
async function randomDelay(minMs: number, maxMs: number) {
  const delayMs = Math.round(Math.random() * (maxMs - minMs)) + minMs;
  return new Promise(resolve => setTimeout(resolve, delayMs)); // tslint:disable-line no-string-based-set-timeout
}

/**
 * Provided a sticker pack ID and key, queries the Signal API and resolves with
 * a parsed manifest.
 */
async function getStickerPack(id: string, key: string, retriesRemaining = 5): Promise<StickerPackManifest> {
  try {
    const res = await axios({
      method: 'GET',
      responseType: 'arraybuffer',
      url: `https://cdn-ca.signal.org/stickers/${id}/manifest.proto`
    });

    return await parseManifest(key, res.data);
  } catch (err) {
    // If the error was due to tiemout and we have retries remaining, retry
    if (err.code === 'ECONNABORTED' && retriesRemaining > 0) {
      // pause before retrying.
      await randomDelay(250, 500);
      console.log(`Retrying fetch for ${id}, attempts remaining: ${retriesRemaining - 1}`);
      return getStickerPack(id, key, retriesRemaining - 1);
    }

    throw new ErrorWithCode(err.code, `[getStickerPack] ${err.message}`);
  }
}

/**
 * Query the manifest for all known sticker packs.
 */
async function getAllStickerPacks(): Promise<StickerPackManifestsJson> {
  return Promise.all(R.map(async ([id, value]) => {
    try {
      // Signal's service will ignore our request if we fetch
      // too many packs too rapidly so we stagger our timing.
      await randomDelay(0, 1000);
      const manifest = await getStickerPack(id, value.key);
      return {
        meta: {id, ...value},
        manifest: {
          title: manifest.title,
          author: manifest.author,
          cover: manifest.cover
        }
      };
    } catch (err) {
      throw new ErrorWithCode(err.code, `[getAllStickerPacks] ${err.message}`);
    }
  }, Object.entries(stickers as StickerPackJson)));
}

export default class FetchStickerDataPlugin {
  constructor({filename}) {
    this.filename = filename;
  }

  apply(compiler) {
    compiler.plugin('emit', async (compilation, done) => {
      const json = JSON.stringify(await getAllStickerPacks());
      compilation.assets[this.filename] = {
        source: () => json,
        size: () => json.length
      };
      done();
    });
  }
}