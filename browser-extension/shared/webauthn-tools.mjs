export const WEBAUTHN_ALGORITHM_ES256 = -7;

export async function createPasskeyCredential(options) {
  const rpId = resolveRpId(options);
  const origin = resolveOrigin(options, rpId);
  const challenge = requiredBase64Url(options.challenge, "challenge");
  const userId = requiredBase64Url(options.user?.id, "user.id");
  const userName = String(options.user?.name || "");
  const userDisplayName = String(options.user?.displayName || userName || "");
  ensureEs256Allowed(options.pubKeyCredParams || []);

  const credentialIdBytes = randomBytes(32);
  const credentialId = base64UrlEncode(credentialIdBytes);
  const keyPair = await subtle().generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"]
  );
  const publicJwk = await subtle().exportKey("jwk", keyPair.publicKey);
  const privateJwk = await subtle().exportKey("jwk", keyPair.privateKey);
  const publicRaw = new Uint8Array(await subtle().exportKey("raw", keyPair.publicKey));
  const cosePublicKey = encodeCosePublicKey(publicRaw);
  const authData = await buildAuthenticatorData({
    rpId,
    flags: 0x45,
    signCount: 0,
    credentialIdBytes,
    cosePublicKey
  });
  const attestationObject = cborEncode(new Map([
    ["fmt", "none"],
    ["attStmt", new Map()],
    ["authData", authData]
  ]));
  const clientDataJSON = encodeClientData("webauthn.create", challenge, origin);
  const response = {
    id: credentialId,
    rawId: credentialId,
    type: "public-key",
    authenticatorAttachment: "platform",
    response: {
      clientDataJSON: base64UrlEncode(clientDataJSON),
      attestationObject: base64UrlEncode(attestationObject),
      transports: ["internal", "hybrid"],
      publicKeyAlgorithm: WEBAUTHN_ALGORITHM_ES256,
      publicKey: base64UrlEncode(publicRaw),
      authenticatorData: base64UrlEncode(authData)
    },
    clientExtensionResults: {}
  };
  const item = {
    type: "passkey",
    title: buildPasskeyTitle(options, rpId),
    username: userName || userDisplayName || rpId,
    urls: [origin],
    fields: {
      rpId,
      origin,
      credentialId,
      userHandle: userId,
      userName,
      userDisplayName,
      algorithm: String(WEBAUTHN_ALGORITHM_ES256),
      signCount: "0",
      publicKeyJwk: JSON.stringify(publicJwk),
      privateKeyJwk: JSON.stringify(privateJwk),
      publicKeyRaw: base64UrlEncode(publicRaw),
      publicKeyCose: base64UrlEncode(cosePublicKey)
    },
    tags: ["passkey", "browser-extension"]
  };
  return { response, item, credentialId };
}

export async function getPasskeyAssertion(options, item) {
  const fields = item?.fields || {};
  const rpId = resolveRpId(options, fields.rpId);
  const origin = resolveOrigin(options, rpId, fields.origin);
  const challenge = requiredBase64Url(options.challenge, "challenge");
  const credentialId = fields.credentialId;
  const privateKeyJwk = parseJson(fields.privateKeyJwk, "privateKeyJwk");
  if (!credentialId || !privateKeyJwk) {
    throw new Error("Stored passkey is missing credential material.");
  }
  const credentialIdBytes = base64UrlDecode(credentialId);
  const nextSignCount = Math.max(0, Number(fields.signCount || "0") || 0) + 1;
  const authenticatorData = await buildAuthenticatorData({
    rpId,
    flags: 0x05,
    signCount: nextSignCount
  });
  const clientDataJSON = encodeClientData("webauthn.get", challenge, origin);
  const clientDataHash = await sha256(clientDataJSON);
  const signedBytes = concatBytes(authenticatorData, clientDataHash);
  const key = await subtle().importKey(
    "jwk",
    privateKeyJwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"]
  );
  const rawSignature = new Uint8Array(await subtle().sign({ name: "ECDSA", hash: "SHA-256" }, key, signedBytes));
  const signature = maybeDerEncodeEcdsa(rawSignature);
  const response = {
    id: credentialId,
    rawId: credentialId,
    type: "public-key",
    authenticatorAttachment: "platform",
    response: {
      authenticatorData: base64UrlEncode(authenticatorData),
      clientDataJSON: base64UrlEncode(clientDataJSON),
      signature: base64UrlEncode(signature),
      userHandle: fields.userHandle || null
    },
    clientExtensionResults: {}
  };
  return { response, signCount: nextSignCount };
}

export function passkeyMatchesRequest(item, options) {
  const fields = item?.fields || {};
  const rpId = resolveRpId(options, fields.rpId);
  if (fields.rpId !== rpId) return false;
  const allowCredentials = Array.isArray(options.allowCredentials) ? options.allowCredentials : [];
  if (!allowCredentials.length) return true;
  return allowCredentials.some((credential) => credential?.id === fields.credentialId);
}

export function parseWebAuthnRequestJson(raw) {
  if (typeof raw !== "string" || !raw.trim()) {
    throw new Error("Missing WebAuthn request JSON.");
  }
  return JSON.parse(raw);
}

export function webAuthnDomException(name, message) {
  return { name, message };
}

export function base64UrlEncode(value) {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.slice(i, i + 0x8000));
  }
  return btoaCompat(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function base64UrlDecode(value) {
  const normalized = String(value || "").replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atobCompat(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

export function cborEncode(value) {
  const chunks = [];
  encodeCborValue(value, chunks);
  return concatBytes(...chunks);
}

export function maybeDerEncodeEcdsa(signature) {
  if (signature[0] === 0x30) return signature;
  if (signature.length !== 64) return signature;
  const r = derInteger(signature.slice(0, 32));
  const s = derInteger(signature.slice(32));
  return concatBytes(
    new Uint8Array([0x30]),
    encodeDerLength(r.length + s.length),
    r,
    s
  );
}

function buildPasskeyTitle(options, rpId) {
  const rpName = options.rp?.name || rpId;
  const user = options.user?.name || options.user?.displayName;
  return user ? `${rpName} (${user})` : String(rpName);
}

function resolveRpId(options, fallback) {
  const raw = options.rpId || options.rp?.id || fallback;
  const rpId = String(raw || "").trim().toLowerCase();
  if (!rpId) throw new Error("WebAuthn request has no rpId.");
  return rpId;
}

function resolveOrigin(options, rpId, fallback) {
  const raw = options.origin || options.topOrigin || fallback || `https://${rpId}`;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("invalid origin");
    return parsed.origin;
  } catch {
    return `https://${rpId}`;
  }
}

function ensureEs256Allowed(params) {
  if (!Array.isArray(params) || !params.length) return;
  const allowed = params.some((param) => Number(param?.alg) === WEBAUTHN_ALGORITHM_ES256);
  if (!allowed) throw new Error("Only ES256 passkeys are supported.");
}

function requiredBase64Url(value, name) {
  if (typeof value !== "string" || !value) throw new Error(`Missing ${name}.`);
  base64UrlDecode(value);
  return value;
}

async function buildAuthenticatorData(options) {
  const rpIdHash = await sha256(new TextEncoder().encode(options.rpId));
  const flags = new Uint8Array([options.flags]);
  const signCount = new Uint8Array(4);
  new DataView(signCount.buffer).setUint32(0, options.signCount, false);
  if (!options.credentialIdBytes || !options.cosePublicKey) {
    return concatBytes(rpIdHash, flags, signCount);
  }
  const aaguid = new Uint8Array(16);
  const credLen = new Uint8Array(2);
  new DataView(credLen.buffer).setUint16(0, options.credentialIdBytes.length, false);
  return concatBytes(
    rpIdHash,
    flags,
    signCount,
    aaguid,
    credLen,
    options.credentialIdBytes,
    options.cosePublicKey
  );
}

function encodeCosePublicKey(publicRaw) {
  if (publicRaw.length !== 65 || publicRaw[0] !== 4) {
    throw new Error("Unexpected P-256 public key format.");
  }
  const x = publicRaw.slice(1, 33);
  const y = publicRaw.slice(33, 65);
  return cborEncode(new Map([
    [1, 2],
    [3, WEBAUTHN_ALGORITHM_ES256],
    [-1, 1],
    [-2, x],
    [-3, y]
  ]));
}

function encodeClientData(type, challenge, origin) {
  return new TextEncoder().encode(JSON.stringify({
    type,
    challenge,
    origin,
    crossOrigin: false
  }));
}

async function sha256(bytes) {
  return new Uint8Array(await subtle().digest("SHA-256", bytes));
}

function subtle() {
  if (!globalThis.crypto?.subtle) throw new Error("WebCrypto is unavailable.");
  return globalThis.crypto.subtle;
}

function randomBytes(length) {
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}

function concatBytes(...parts) {
  const length = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function encodeCborValue(value, chunks) {
  if (value instanceof Uint8Array) {
    encodeTypeAndLength(2, value.length, chunks);
    chunks.push(value);
    return;
  }
  if (typeof value === "string") {
    const bytes = new TextEncoder().encode(value);
    encodeTypeAndLength(3, bytes.length, chunks);
    chunks.push(bytes);
    return;
  }
  if (typeof value === "number") {
    if (Number.isInteger(value) && value >= 0) {
      encodeTypeAndLength(0, value, chunks);
      return;
    }
    if (Number.isInteger(value) && value < 0) {
      encodeTypeAndLength(1, -1 - value, chunks);
      return;
    }
  }
  if (Array.isArray(value)) {
    encodeTypeAndLength(4, value.length, chunks);
    value.forEach((item) => encodeCborValue(item, chunks));
    return;
  }
  if (value instanceof Map) {
    encodeTypeAndLength(5, value.size, chunks);
    for (const [key, mapValue] of value.entries()) {
      encodeCborValue(key, chunks);
      encodeCborValue(mapValue, chunks);
    }
    return;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value);
    encodeTypeAndLength(5, entries.length, chunks);
    for (const [key, objectValue] of entries) {
      encodeCborValue(key, chunks);
      encodeCborValue(objectValue, chunks);
    }
    return;
  }
  throw new Error("Unsupported CBOR value.");
}

function encodeTypeAndLength(type, length, chunks) {
  const major = type << 5;
  if (length < 24) {
    chunks.push(new Uint8Array([major | length]));
  } else if (length < 0x100) {
    chunks.push(new Uint8Array([major | 24, length]));
  } else if (length < 0x10000) {
    chunks.push(new Uint8Array([major | 25, length >> 8, length & 0xff]));
  } else {
    const bytes = new Uint8Array(5);
    bytes[0] = major | 26;
    new DataView(bytes.buffer).setUint32(1, length, false);
    chunks.push(bytes);
  }
}

function derInteger(bytes) {
  let start = 0;
  while (start < bytes.length - 1 && bytes[start] === 0) start += 1;
  let value = bytes.slice(start);
  if (value[0] & 0x80) value = concatBytes(new Uint8Array([0]), value);
  return concatBytes(new Uint8Array([0x02]), encodeDerLength(value.length), value);
}

function encodeDerLength(length) {
  if (length < 0x80) return new Uint8Array([length]);
  if (length < 0x100) return new Uint8Array([0x81, length]);
  return new Uint8Array([0x82, length >> 8, length & 0xff]);
}

function parseJson(raw, name) {
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`Stored passkey has invalid ${name}.`);
  }
}

function btoaCompat(binary) {
  if (typeof btoa === "function") return btoa(binary);
  return Buffer.from(binary, "binary").toString("base64");
}

function atobCompat(value) {
  if (typeof atob === "function") return atob(value);
  return Buffer.from(value, "base64").toString("binary");
}
