/**
 * Checks tool arguments against the subset of JSON Schema that tool definitions use: types,
 * required and extra properties, enums, number and length bounds, and array items. Unknown
 * keywords are ignored, so schemas from MCP servers still work. Returns readable problems,
 * empty when the value fits.
 */
export function validateArguments(schema: unknown, value: unknown, path = 'arguments'): string[] {
  if (typeof schema !== 'object' || schema === null) return [];
  const rules = schema as Record<string, unknown>;
  const problems: string[] = [];

  const types = typeof rules.type === 'string' ? [rules.type] : Array.isArray(rules.type) ? (rules.type as string[]) : null;
  if (types && !types.some((type) => matchesType(type, value))) {
    return [`${path} should be ${types.join(' or ')}, got ${describe(value)}`];
  }

  if (Array.isArray(rules.enum) && !rules.enum.some((option) => option === value)) {
    problems.push(`${path} should be one of ${rules.enum.map((option) => JSON.stringify(option)).join(', ')}`);
  }

  if (typeof value === 'number') {
    if (typeof rules.minimum === 'number' && value < rules.minimum) problems.push(`${path} should be at least ${rules.minimum}`);
    if (typeof rules.maximum === 'number' && value > rules.maximum) problems.push(`${path} should be at most ${rules.maximum}`);
  }

  if (typeof value === 'string') {
    if (typeof rules.minLength === 'number' && value.length < rules.minLength) {
      problems.push(`${path} should have at least ${rules.minLength} characters`);
    }
    if (typeof rules.maxLength === 'number' && value.length > rules.maxLength) {
      problems.push(`${path} should have at most ${rules.maxLength} characters`);
    }
  }

  if (Array.isArray(value)) {
    if (typeof rules.minItems === 'number' && value.length < rules.minItems) problems.push(`${path} should have at least ${rules.minItems} items`);
    if (typeof rules.maxItems === 'number' && value.length > rules.maxItems) problems.push(`${path} should have at most ${rules.maxItems} items`);
    if (rules.items) value.forEach((item, index) => problems.push(...validateArguments(rules.items, item, `${path}[${index}]`)));
  }

  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const properties = (rules.properties ?? {}) as Record<string, unknown>;
    for (const key of Array.isArray(rules.required) ? (rules.required as string[]) : []) {
      if (record[key] === undefined) problems.push(`${path}.${key} is required`);
    }
    for (const [key, item] of Object.entries(record)) {
      if (key in properties) problems.push(...validateArguments(properties[key], item, `${path}.${key}`));
      else if (rules.additionalProperties === false) problems.push(`${path}.${key} is not an accepted argument`);
    }
  }

  return problems;
}

function matchesType(type: string, value: unknown): boolean {
  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'array':
      return Array.isArray(value);
    case 'object':
      return typeof value === 'object' && value !== null && !Array.isArray(value);
    case 'null':
      return value === null;
    default:
      return true;
  }
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return typeof value === 'object' ? 'an object' : `${typeof value} ${JSON.stringify(value)}`.slice(0, 60);
}
