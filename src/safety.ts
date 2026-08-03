export const REDACTED_SECRET = "[REDACTED SECRET]";
export const REDACTED_SECRET_REQUEST = "[REDACTED: request for sensitive information]";

const secretTerms = String.raw`(?:api[ _-]?keys?|access[ _-]?keys?|secrets?(?:[ _-]?keys?)?|tokens?|passwords?|passwds?|pwd|credentials?|cookies?|sessions?(?:[ _-]?(?:id|value|token))?|private[ _-]?keys?|client[ _-]?secrets?|oauth[ _-]?secrets?)`;
const disclosureVerbs = String.raw`(?:show|reveal|give|send|print|display|output|dump|expose|retrieve|read|fetch|return|tell|find|what(?:'s|\s+is))`;

const knownSecretPatterns: RegExp[] = [
  /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
  /\bxox(?:a|b|p|r|s)-[A-Za-z0-9-]{10,}\b/g,
  /\bsk_(?:live|test)_[A-Za-z0-9]{16,}\b/g,
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
];

const labelledSecret = new RegExp(
  String.raw`(\b${secretTerms}\b\s*(?:=|:|is\b)\s*)(["']?)([^\s,"'\]\}\)]+)\2`,
  "gi",
);
const authorizationHeader = /\b(authorization\s*:\s*(?:bearer|basic)\s+)[A-Za-z0-9._~+\/-]+=*/gi;
const cookieHeader = /\b((?:set-)?cookie\s*:\s*)[^\r\n]+/gi;
const credentialUrl = /\b(https?:\/\/[^\s:/@]+:)[^\s@/]+@/gi;

function likelyPlaceholder(value: string): boolean {
  return /^(?:<[^>]+>|\$\{|\[?redacted\]?|xxx+|your[_-]|example|placeholder|dummy|none|null|undefined)/i.test(value);
}

export function isSensitiveSecretRequest(value: string): boolean {
  const disclosure = new RegExp(String.raw`\b${disclosureVerbs}\b[\s\S]{0,80}\b${secretTerms}\b`, "i");
  const reverseDisclosure = new RegExp(String.raw`\b${secretTerms}\b[\s\S]{0,40}\b${disclosureVerbs}\b`, "i");
  if (!disclosure.test(value) && !reverseDisclosure.test(value)) return false;
  const managementIntent = new RegExp(
    String.raw`\b(?:redact|mask|hide|remove|rotate|revoke|scan|detect|prevent|protect|validate|replace|how\s+to\s+(?:configure|set|update|store))\b[\s\S]{0,60}\b${secretTerms}\b`,
    "i",
  );
  const exampleIntent = new RegExp(
    String.raw`\b(?:example|placeholder|dummy|mock|format|variable|field|input)\b[\s\S]{0,30}\b${secretTerms}\b|\b${secretTerms}\b[\s\S]{0,30}\b(?:example|placeholder|dummy|mock|format|variable|field|input|validation\s+error)\b`,
    "i",
  );
  return !managementIntent.test(value) && !exampleIntent.test(value);
}

export function redactSensitiveText(value: string, request?: string): string {
  if (request && isSensitiveSecretRequest(request)) return REDACTED_SECRET_REQUEST;

  let redacted = value;
  for (const pattern of knownSecretPatterns) redacted = redacted.replace(pattern, REDACTED_SECRET);
  redacted = redacted
    .replace(authorizationHeader, `$1${REDACTED_SECRET}`)
    .replace(cookieHeader, `$1${REDACTED_SECRET}`)
    .replace(credentialUrl, `$1${REDACTED_SECRET}@`)
    .replace(labelledSecret, (match, prefix: string, _quote: string, secret: string) =>
      likelyPlaceholder(secret) || secret.length < 6 ? match : `${prefix}${REDACTED_SECRET}`);
  return redacted;
}

export function secretSafetyPrompt(request: string): string[] {
  const rules = [
    "Never include credentials, secrets, tokens, API keys, passwords, cookies, session values, private keys, OAuth secrets, or other confidential values in visible responses, progress, tool summaries, or operational details.",
    `Replace any such value with ${REDACTED_SECRET}; describe where it is stored or how to rotate it without printing it.`,
  ];
  if (isSensitiveSecretRequest(request)) {
    rules.push("This request appears to ask for confidential material. Do not retrieve or disclose the value; provide only a safe refusal or non-sensitive remediation guidance.");
  }
  return rules;
}
