const secretPatterns: RegExp[] = [
  /sk_live_[a-zA-Z0-9]{16,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /ghp_[a-zA-Z0-9]{20,}/g,
  /eyJ[a-zA-Z0-9_-]+\.eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/g,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
  /(?:^|[\s,;])(?:[A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)[A-Z0-9_]*=)[^\s,;]+/g,
];
const emailPattern = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const tokenPattern = /\$secret:v_\d{3,}/g;

export function shannonEntropy(value: string): number {
  if (value.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const probability = count / value.length;
    entropy -= probability * Math.log2(probability);
  }
  return entropy;
}

export class SecretVault {
  private readonly rawByToken = new Map<string, string>();
  private readonly tokenByRaw = new Map<string, string>();
  private nextId = 1;

  constructor(private readonly maskEmails = true) {}

  private tokenFor(raw: string): string {
    const existing = this.tokenByRaw.get(raw);
    if (existing) return existing;
    const token = "$secret:v_" + String(this.nextId++).padStart(3, "0");
    this.rawByToken.set(token, raw);
    this.tokenByRaw.set(raw, token);
    return token;
  }

  scrubString(input: string): string {
    let text = input;
    for (const pattern of secretPatterns) {
      pattern.lastIndex = 0;
      text = text.replace(pattern, (match) => this.tokenFor(match));
    }
    if (this.maskEmails) {
      emailPattern.lastIndex = 0;
      text = text.replace(emailPattern, (match) => this.tokenFor(match));
    }
    text = text.replace(/\b[A-Za-z0-9_+/=-]{32,}\b/g, (match) =>
      match.length >= 32 && shannonEntropy(match) >= 4.2 ? this.tokenFor(match) : match,
    );
    return text;
  }

  scrub<T>(value: T): T {
    if (typeof value === "string") return this.scrubString(value) as T;
    if (Array.isArray(value)) return value.map((entry) => this.scrub(entry)) as T;
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, entry]) => [this.scrubString(key), this.scrub(entry)])) as T;
    }
    return value;
  }

  hydrateString(input: string): string {
    return input.replace(tokenPattern, (token) => {
      const secret = this.rawByToken.get(token);
      if (secret === undefined) throw new Error("Unknown secret token: " + token);
      return secret;
    });
  }

  hydrate<T>(value: T): T {
    if (typeof value === "string") return this.hydrateString(value) as T;
    if (Array.isArray(value)) return value.map((entry) => this.hydrate(entry)) as T;
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, entry]) => [this.hydrateString(key), this.hydrate(entry)])) as T;
    }
    return value;
  }

  get size(): number {
    return this.rawByToken.size;
  }

  listTokens(): string[] {
    return [...this.rawByToken.keys()];
  }
}
