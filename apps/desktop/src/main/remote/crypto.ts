import { randomBytes } from "node:crypto";
import nacl from "tweetnacl";

const KEY_BYTES = nacl.secretbox.keyLength;
const NONCE_BYTES = nacl.secretbox.nonceLength;

function assertLength(value: Uint8Array, expected: number, label: string): void {
  if (value.length !== expected) {
    throw new Error(`${label} must be ${expected} bytes, received ${value.length}.`);
  }
}

export function generateSecretboxKey(): Uint8Array {
  return new Uint8Array(randomBytes(KEY_BYTES));
}

export function keyToBase64(key: Uint8Array): string {
  assertLength(key, KEY_BYTES, "Secretbox key");
  return Buffer.from(key).toString("base64");
}

export function keyFromBase64(encoded: string): Uint8Array {
  const key = new Uint8Array(Buffer.from(encoded, "base64"));
  assertLength(key, KEY_BYTES, "Secretbox key");
  return key;
}

export function encryptJsonWithNonce(value: unknown, key: Uint8Array, nonce: Uint8Array): string {
  assertLength(key, KEY_BYTES, "Secretbox key");
  assertLength(nonce, NONCE_BYTES, "Secretbox nonce");
  const plaintext = new TextEncoder().encode(JSON.stringify(value));
  const ciphertext = nacl.secretbox(plaintext, nonce, key);
  return Buffer.concat([Buffer.from(nonce), Buffer.from(ciphertext)]).toString("base64");
}

export function encryptJson(value: unknown, key: Uint8Array): string {
  return encryptJsonWithNonce(value, key, new Uint8Array(randomBytes(NONCE_BYTES)));
}

export function decryptJson(envelope: string, key: Uint8Array): unknown {
  assertLength(key, KEY_BYTES, "Secretbox key");
  const bytes = new Uint8Array(Buffer.from(envelope, "base64"));
  if (bytes.length <= NONCE_BYTES + nacl.secretbox.overheadLength) {
    throw new Error("Invalid secretbox envelope.");
  }
  const nonce = bytes.slice(0, NONCE_BYTES);
  const ciphertext = bytes.slice(NONCE_BYTES);
  const plaintext = nacl.secretbox.open(ciphertext, nonce, key);
  if (!plaintext) {
    throw new Error("Could not authenticate encrypted relay payload.");
  }
  return JSON.parse(new TextDecoder().decode(plaintext)) as unknown;
}
