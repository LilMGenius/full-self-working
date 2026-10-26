// Named errors for the economics modules. Every missing fee, count or config value fails closed with
// one of these codes instead of falling back to an assumed number.
export class EconomicsError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = 'EconomicsError';
    this.code = code;
    Object.assign(this, detail);
  }
}

export function requireNumber(value, path, code = 'FSW_CONFIG_MISSING') {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new EconomicsError(code, `${path} must be a number, got ${JSON.stringify(value)}`, { path });
  }
  return value;
}
