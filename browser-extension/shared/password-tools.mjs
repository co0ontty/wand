const COMMON_WEAK_PASSWORDS = new Set([
  "123456",
  "123456789",
  "qwerty",
  "password",
  "111111",
  "abc123",
  "password1",
  "iloveyou"
]);

export function generatePassword(options = {}) {
  const length = clampInteger(options.length ?? 20, 8, 80);
  const lower = "abcdefghijkmnopqrstuvwxyz";
  const upper = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const digits = "23456789";
  const symbols = "!@#$%^&*-_=+?";
  const pools = [lower, upper];
  if (options.digits !== false) pools.push(digits);
  if (options.symbols !== false) pools.push(symbols);
  const alphabet = pools.join("");
  const chars = pools.map((pool) => randomChar(pool));
  while (chars.length < length) chars.push(randomChar(alphabet));
  return shuffle(chars).join("");
}

export function scorePasswordStrength(password) {
  if (!password) return 0;
  const value = String(password);
  const lower = value.toLowerCase();
  if (COMMON_WEAK_PASSWORDS.has(lower)) return 0;
  let score = Math.min(40, value.length * 3);
  if (/[a-z]/.test(value)) score += 10;
  if (/[A-Z]/.test(value)) score += 10;
  if (/\d/.test(value)) score += 10;
  if (/[^A-Za-z0-9]/.test(value)) score += 15;
  if (value.length >= 20) score += 15;
  if (/(.)\1{2,}/.test(value)) score -= 20;
  if (/^(?:[a-z]+|\d+)$/.test(value)) score -= 20;
  return Math.max(0, Math.min(100, score));
}

function clampInteger(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function randomChar(alphabet) {
  const values = new Uint32Array(1);
  globalThis.crypto.getRandomValues(values);
  return alphabet[values[0] % alphabet.length];
}

function shuffle(values) {
  for (let i = values.length - 1; i > 0; i -= 1) {
    const rand = new Uint32Array(1);
    globalThis.crypto.getRandomValues(rand);
    const j = rand[0] % (i + 1);
    [values[i], values[j]] = [values[j], values[i]];
  }
  return values;
}
