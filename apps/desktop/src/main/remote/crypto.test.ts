import { describe, expect, it } from "vitest";
import vectors from "../../../../../docs/crypto-vectors.json";
import { decryptJson, encryptJsonWithNonce, keyFromBase64 } from "./crypto";

describe("relay secretbox envelope", () => {
  it("matches the cross-client fixed vector and opens it", () => {
    const vector = vectors.vectors[0];
    expect(vector).toBeDefined();
    if (!vector) throw new Error("Missing crypto vector.");

    const key = keyFromBase64(vector.keyBase64);
    const nonce = new Uint8Array(Buffer.from(vector.nonceBase64, "base64"));
    const plaintext: unknown = vector.plaintext;

    expect(encryptJsonWithNonce(plaintext, key, nonce)).toBe(vector.envelopeBase64);
    expect(decryptJson(vector.envelopeBase64, key)).toEqual(plaintext);
  });
});
