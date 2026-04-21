/**
 * Vajra AI Guardrails
 * Prompt injection detection, content filtering, PII detection.
 */

interface GuardrailResult {
  safe: boolean;
  violations: GuardrailViolation[];
}

interface GuardrailViolation {
  type: 'prompt-injection' | 'pii' | 'content-filter';
  pattern: string;
  match: string;
}

// Prompt injection patterns
const INJECTION_PATTERNS = [
  /ignore\s+(all\s+)?previous\s+instructions/i,
  /ignore\s+(all\s+)?above\s+instructions/i,
  /disregard\s+(all\s+)?previous/i,
  /forget\s+(all\s+)?previous/i,
  /you\s+are\s+now\s+/i,
  /act\s+as\s+if\s+you\s+are/i,
  /pretend\s+you\s+are/i,
  /new\s+instructions?\s*:/i,
  /system\s*:\s*you\s+are/i,
  /\[SYSTEM\]/i,
  /\[INST\]/i,
  /<<SYS>>/i,
  /jailbreak/i,
  /DAN\s+mode/i,
  /developer\s+mode\s+enabled/i,
  /do\s+anything\s+now/i,
];

// PII patterns
const PII_PATTERNS = [
  { name: 'ssn', pattern: /\b\d{3}[-.]?\d{2}[-.]?\d{4}\b/ },
  { name: 'credit-card', pattern: /\b(?:4\d{3}|5[1-5]\d{2}|3[47]\d{2}|6(?:011|5\d{2}))\d{8,12}\b/ },
  { name: 'email', pattern: /\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/ },
  { name: 'phone-us', pattern: /\b(?:\+1[-.]?)?\(?\d{3}\)?[-.]?\d{3}[-.]?\d{4}\b/ },
  { name: 'phone-in', pattern: /\b(?:\+91[-.]?)?\d{10}\b/ },
  { name: 'aadhaar', pattern: /\b\d{4}\s?\d{4}\s?\d{4}\b/ },
  { name: 'pan', pattern: /\b[A-Z]{5}\d{4}[A-Z]\b/ },
];

// Content filter patterns
const CONTENT_FILTERS = [
  { name: 'violence', pattern: /\b(kill|murder|assault|bomb|shoot|stab|attack)\b/i },
  { name: 'self-harm', pattern: /\b(suicide|self.?harm|cut\s+myself)\b/i },
  { name: 'illegal', pattern: /\b(hack\s+into|steal\s+credentials|bypass\s+security)\b/i },
];

/** Detect prompt injection attempts */
export function detectPromptInjection(input: string): GuardrailViolation[] {
  const violations: GuardrailViolation[] = [];
  for (const pattern of INJECTION_PATTERNS) {
    const match = input.match(pattern);
    if (match) {
      violations.push({
        type: 'prompt-injection',
        pattern: pattern.source,
        match: match[0],
      });
    }
  }
  return violations;
}

/** Detect PII in text */
export function detectPII(input: string): GuardrailViolation[] {
  const violations: GuardrailViolation[] = [];
  for (const { name, pattern } of PII_PATTERNS) {
    const match = input.match(pattern);
    if (match) {
      violations.push({
        type: 'pii',
        pattern: name,
        match: match[0].slice(0, 4) + '***', // Partially mask
      });
    }
  }
  return violations;
}

/** Detect harmful content */
export function detectHarmfulContent(input: string): GuardrailViolation[] {
  const violations: GuardrailViolation[] = [];
  for (const { name, pattern } of CONTENT_FILTERS) {
    const match = input.match(pattern);
    if (match) {
      violations.push({
        type: 'content-filter',
        pattern: name,
        match: match[0],
      });
    }
  }
  return violations;
}

/** Mask PII in text */
export function maskPII(input: string): string {
  let result = input;
  for (const { pattern } of PII_PATTERNS) {
    result = result.replace(new RegExp(pattern.source, 'g'), '[REDACTED]');
  }
  return result;
}

interface GuardrailOptions {
  promptInjection?: boolean;
  pii?: boolean;
  contentFilter?: boolean;
}

/** Run all guardrails on input text */
export function checkGuardrails(input: string, options: GuardrailOptions = {}): GuardrailResult {
  const violations: GuardrailViolation[] = [];

  if (options.promptInjection !== false) {
    violations.push(...detectPromptInjection(input));
  }

  if (options.pii !== false) {
    violations.push(...detectPII(input));
  }

  if (options.contentFilter !== false) {
    violations.push(...detectHarmfulContent(input));
  }

  return {
    safe: violations.length === 0,
    violations,
  };
}
