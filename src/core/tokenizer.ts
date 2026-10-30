export function estimateTokens(value: unknown): number {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return Math.ceil((text?.length ?? 0) / 4);
}

export function payloadCharacters(value: unknown): number {
  return (typeof value === "string" ? value : JSON.stringify(value)).length;
}
