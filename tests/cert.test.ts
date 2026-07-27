import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID, X509Certificate } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createSecureContext } from "node:tls";

import { ensureCertificates } from "../src/cert.js";

function hasOpenSSL(): boolean {
  try {
    execFileSync("openssl", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

test("certificate generation treats metacharacter paths as argv and keeps artifacts private", (t) => {
  if (!hasOpenSSL()) {
    t.skip("OpenSSL is not installed");
    return;
  }

  const root = mkdtempSync(path.join(os.tmpdir(), "wand cert argv "));
  const markerName = `.wand-cert-injected-${randomUUID()}`;
  const markerPath = path.join(process.cwd(), markerName);
  // This component would execute touch through the previous shell-string call.
  const configDir = path.join(root, `cert dir "$(touch ${markerName})" ; [literal]`);
  t.after(() => {
    rmSync(markerPath, { force: true });
    rmSync(root, { recursive: true, force: true });
  });

  const ssl = ensureCertificates(configDir);
  const keyPath = path.join(configDir, "server.key");
  const certPath = path.join(configDir, "server.crt");

  assert.equal(existsSync(markerPath), false, "path content was interpreted by a shell");
  assert.equal(ssl.certPath, certPath);
  assert.equal(ssl.userProvided, false);
  assert.match(ssl.fingerprint, /^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$/);
  assert.equal(statSync(configDir).mode & 0o777, 0o700);
  assert.equal(statSync(keyPath).mode & 0o777, 0o600);
  assert.equal(statSync(certPath).mode & 0o777, 0o600);

  assert.doesNotThrow(() => createSecureContext({ key: ssl.key, cert: ssl.cert }));
  const certificate = new X509Certificate(ssl.cert);
  assert.match(certificate.subjectAltName ?? "", /DNS:localhost/);
  assert.ok(Date.parse(certificate.validTo) > Date.now());

  // Existing generated files are hardened again when loaded.
  chmodSync(keyPath, 0o644);
  chmodSync(certPath, 0o644);
  const reloaded = ensureCertificates(configDir);
  assert.deepEqual(reloaded.key, readFileSync(keyPath));
  assert.deepEqual(reloaded.cert, readFileSync(certPath));
  assert.equal(statSync(keyPath).mode & 0o777, 0o600);
  assert.equal(statSync(certPath).mode & 0o777, 0o600);
});

test("missing OpenSSL fails explicitly without writing placeholder certificates", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-cert-no-openssl-"));
  const emptyBin = path.join(root, "empty-bin");
  const configDir = path.join(root, "config");
  mkdirSync(emptyBin);
  const originalPath = process.env.PATH;

  try {
    process.env.PATH = emptyBin;
    assert.throws(
      () => ensureCertificates(configDir),
      /无法生成 HTTPS 证书.*OpenSSL/,
    );
    const files = existsSync(configDir) ? readdirSync(configDir) : [];
    assert.deepEqual(files, []);
    assert.equal(existsSync(path.join(configDir, "server.key")), false);
    assert.equal(existsSync(path.join(configDir, "server.crt")), false);
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    rmSync(root, { recursive: true, force: true });
  }
});
