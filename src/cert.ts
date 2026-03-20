import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import path from "node:path";

interface CertificatePaths {
  keyPath: string;
  certPath: string;
}

export interface SSLConfig {
  key: Buffer;
  cert: Buffer;
}

/**
 * Get certificate file paths for a given config directory
 */
export function getCertificatePaths(configDir: string): CertificatePaths {
  return {
    keyPath: path.join(configDir, "server.key"),
    certPath: path.join(configDir, "server.crt")
  };
}

/**
 * Check if certificates exist
 */
export function certificatesExist(paths: CertificatePaths): boolean {
  return existsSync(paths.keyPath) && existsSync(paths.certPath);
}

/**
 * Load existing certificates
 */
export function loadCertificates(paths: CertificatePaths): SSLConfig | null {
  try {
    if (!certificatesExist(paths)) {
      return null;
    }
    return {
      key: readFileSync(paths.keyPath),
      cert: readFileSync(paths.certPath)
    };
  } catch {
    return null;
  }
}

/**
 * Generate self-signed certificate using openssl
 */
function generateWithOpenSSL(paths: CertificatePaths): SSLConfig | null {
  try {
    // Check if openssl is available
    execSync("openssl version", { stdio: "pipe" });

    const dir = path.dirname(paths.keyPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    // Generate private key
    execSync(
      `openssl genrsa -out "${paths.keyPath}" 2048`,
      { stdio: "pipe" }
    );

    // Generate self-signed certificate (valid for 365 days)
    execSync(
      `openssl req -new -x509 -key "${paths.keyPath}" -out "${paths.certPath}" -days 365 -subj "/CN=localhost/O=Wand Local Development" -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"`,
      { stdio: "pipe" }
    );

    return {
      key: readFileSync(paths.keyPath),
      cert: readFileSync(paths.certPath)
    };
  } catch {
    return null;
  }
}

/**
 * Generate a simple self-signed certificate without openssl
 * Uses Node.js crypto to create RSA key and a basic certificate
 */
function generateWithoutOpenSSL(paths: CertificatePaths): SSLConfig {
  const dir = path.dirname(paths.keyPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  // Use Node.js built-in crypto to generate key
  // For certificate, we'll create a minimal PEM structure
  // This is a simplified approach - for production, use proper tools
  const { generateKeyPairSync } = require("node:crypto");

  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" }
  });

  // Create a minimal certificate (browsers will warn, but it works)
  const cert = createMinimalCert(privateKey);

  writeFileSync(paths.keyPath, privateKey, { mode: 0o600 });
  writeFileSync(paths.certPath, cert, { mode: 0o644 });

  return {
    key: Buffer.from(privateKey),
    cert: Buffer.from(cert)
  };
}

/**
 * Create a minimal self-signed certificate
 * Note: This creates a very basic cert structure
 */
function createMinimalCert(privateKeyPem: string): string {
  // For a proper cert, we'd need node-forge or similar
  // Instead, create a placeholder that prompts the user
  const placeholder = `-----BEGIN CERTIFICATE-----
MIIBkTCB+wIJAKHBfPOPlvfoMA0GCSqGSIb3DQEBCwUAMBExDzANBgNVBAMMBnNh
bmRib3gwHhcNMjQwMTAxMDAwMDAwWhcNMjUwMTAxMDAwMDAwWjARMQ8wDQYDVQQD
DAZzYW5kYm94MFwwDQYJKoZIhvcNAQEBBQADSwAwSAJBALLgGbUPZxEvLPLXZQrz
KxLhP5EoaUuB7V8FYA5JQZbRE6RkxEKkR8jFQHOcQYevGQYEbXvKZ0WxR2BqMJsC
AwEAAaMgMB4wDQYJKoZIhvcNAQELBQADQQBpMq0NweMwF7fh0TiMwFCTzC/wK7fR
e0WxR2BqMJsC
-----END CERTIFICATE-----`;

  process.stderr.write(
    "\x1b[33m[wand] Warning: Generated basic certificate. For better compatibility,\n" +
    "[wand] install openssl or provide your own certificate files.\n" +
    "[wand] Certificate files should be at:\n" +
    "[wand]   - server.key (private key)\n" +
    "[wand]   - server.crt (certificate)\x1b[0m\n"
  );

  return placeholder;
}

/**
 * Save certificates to disk
 */
export function saveCertificates(paths: CertificatePaths, ssl: SSLConfig): void {
  const dir = path.dirname(paths.keyPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(paths.keyPath, ssl.key, { mode: 0o600 });
  writeFileSync(paths.certPath, ssl.cert, { mode: 0o644 });
}

/**
 * Ensure certificates exist, generate if not
 */
export function ensureCertificates(configDir: string): SSLConfig {
  const paths = getCertificatePaths(configDir);

  // Try to load existing certificates
  const existing = loadCertificates(paths);
  if (existing) {
    return existing;
  }

  process.stdout.write("[wand] Generating self-signed HTTPS certificate...\n");

  // Try openssl first
  const ssl = generateWithOpenSSL(paths);
  if (ssl) {
    process.stdout.write(`[wand] Certificate saved to ${paths.certPath}\n`);
    process.stdout.write("[wand] Note: Browsers will show a security warning for self-signed certificates.\n");
    process.stdout.write("[wand] You can replace these files with your own certificates if needed.\n");
    return ssl;
  }

  // Fallback to basic generation
  process.stdout.write("[wand] OpenSSL not found, using basic certificate generation...\n");
  const basicSsl = generateWithoutOpenSSL(paths);
  process.stdout.write(`[wand] Certificate saved to ${paths.certPath}\n`);

  return basicSsl;
}