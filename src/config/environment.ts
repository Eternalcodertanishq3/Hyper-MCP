const inheritedEnvironmentNames = new Set([
  "path", "pathext", "systemroot", "windir", "temp", "tmp", "tmpdir", "home", "userprofile",
  "appdata", "localappdata", "programfiles", "programfiles(x86)", "comspec", "lang", "lc_all", "tz",
]);

export function resolveEnvironmentReferences(value: string, label: string, source: NodeJS.ProcessEnv = process.env): string {
  const expanded = value.replace(/\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => {
    const secret = source[name];
    if (secret === undefined) throw new Error(label + " references an unset environment variable: " + name);
    return secret;
  });
  if (expanded.includes("${env:")) throw new Error(label + " contains an invalid environment-variable reference.");
  return expanded;
}

export function buildUpstreamEnvironment(overrides: Record<string, string> = {}, source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const inherited = Object.fromEntries(Object.entries(source).filter(([key, value]) => inheritedEnvironmentNames.has(key.toLowerCase()) && value !== undefined)) as Record<string, string>;
  return { ...inherited, ...overrides };
}
