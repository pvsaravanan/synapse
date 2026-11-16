/**
 * Credential redaction applied before every durable write.
 *
 * Rules are deliberately narrow: they target explicit `name = value`
 * assignments and well-known token formats, so ordinary prose about
 * passwords or tokens is left untouched.
 */

interface RedactionRule {
  name: string;
  pattern: RegExp;
  replace: (match: string, ...groups: string[]) => string;
}

const MASK = '[REDACTED]';

const SENSITIVE_NAMES = [
  'password', 'passwd', 'pwd', 'passphrase', 'secret', 'client_secret', 'client-secret',
  'token', 'access_token', 'refresh_token', 'api_key', 'api-key', 'apikey',
  'auth_key', 'auth-key', 'access_key', 'access-key', 'private_key', 'private-key',
];

const nameAlternation = SENSITIVE_NAMES.map((n) => n.replace(/[-_]/g, '[-_]?')).join('|');

const RULES: RedactionRule[] = [
  {
    // NAME=value, NAME: "value", NAME='value' — keep the name and quote, mask a value of 6+ chars.
    name: 'assignment',
    pattern: new RegExp(`\\b((?:${nameAlternation})\\s*[:=]\\s*["']?)([^\\s"',;]{6,})`, 'gi'),
    replace: (_m, prefix) => `${prefix}${MASK}`,
  },
  {
    name: 'bearer',
    pattern: /\b(Bearer\s+)[\w.~+/-]{20,}=*/g,
    replace: (_m, prefix) => `${prefix}${MASK}`,
  },
  { name: 'github', pattern: /\b(?:gh[pousr]|github_pat)_\w{30,}\b/g, replace: () => MASK },
  { name: 'openai-anthropic', pattern: /\bsk-(?:ant-|proj-)?[\w-]{20,}\b/g, replace: () => MASK },
  { name: 'aws-access-key', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, replace: () => MASK },
  { name: 'slack', pattern: /\bxox[abprs]-[\w-]{10,}\b/g, replace: () => MASK },
  { name: 'jwt', pattern: /\beyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,}\b/g, replace: () => MASK },
  {
    name: 'pem-private-key',
    pattern: /-----BEGIN ([A-Z ]*)PRIVATE KEY-----[\s\S]*?-----END \1PRIVATE KEY-----/g,
    replace: () => '[REDACTED PRIVATE KEY]',
  },
];

export function redactSecrets(text: string): string {
  if (!text) return text;
  return RULES.reduce((out, rule) => out.replace(rule.pattern, rule.replace as (...a: string[]) => string), text);
}

export function containsSecret(text: string): boolean {
  return redactSecrets(text) !== text;
}
