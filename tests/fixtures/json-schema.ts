/**
 * A JSON Schema check for the OpenAPI subset the pinned OpenAI file uses: `$ref` inside the file,
 * `type`, `enum`, `properties`, `required`, `additionalProperties: false`, `items`, `minItems`,
 * `maxItems`, `oneOf` (exactly one) and `anyOf`. Annotations (`format`, `discriminator`, `title`,
 * `x-*`) are ignored, as a validator ignores them. With `strict`, an object property the schema does
 * not name is an error too, so a renamed optional field is caught, not just a missing required one.
 */

type Schema = Record<string, unknown>;

export function validate(
  root: Schema,
  schema: Schema,
  value: unknown,
  o: { strict?: boolean } = {},
  at = "$",
): string[] {
  if (typeof schema.$ref === "string") {
    const target = (schema.$ref as string)
      .replace(/^#\//, "")
      .split("/")
      .reduce<unknown>((x, k) => (x as Schema | undefined)?.[k], root) as Schema | undefined;
    if (!target) return [`${at}: unresolved ${schema.$ref}`];
    return validate(root, target, value, o, at);
  }
  const errors: string[] = [];
  const type = schema.type as string | undefined;
  if (type !== undefined && !isType(value, type)) return [`${at}: not ${type}`];
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    errors.push(`${at}: ${JSON.stringify(value)} not in ${JSON.stringify(schema.enum)}`);
  }
  if (Array.isArray(schema.oneOf)) {
    const passing = (schema.oneOf as Schema[]).filter(
      (s) => validate(root, s, value, o, at).length === 0,
    );
    if (passing.length !== 1) errors.push(`${at}: matches ${passing.length} of oneOf, not 1`);
  }
  if (Array.isArray(schema.anyOf)) {
    const passing = (schema.anyOf as Schema[]).some(
      (s) => validate(root, s, value, o, at).length === 0,
    );
    if (!passing) errors.push(`${at}: matches none of anyOf`);
  }
  if (isType(value, "object") && (schema.properties || schema.required)) {
    const obj = value as Record<string, unknown>;
    const props = (schema.properties ?? {}) as Record<string, Schema>;
    for (const r of (schema.required ?? []) as string[]) {
      if (!(r in obj)) errors.push(`${at}: missing ${r}`);
    }
    for (const [k, v] of Object.entries(obj)) {
      if (props[k]) errors.push(...validate(root, props[k], v, o, `${at}.${k}`));
      else if (schema.additionalProperties === false || o.strict) {
        errors.push(`${at}: unexpected property ${k}`);
      }
    }
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) {
      errors.push(`${at}: fewer than ${schema.minItems} items`);
    }
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) {
      errors.push(`${at}: more than ${schema.maxItems} items`);
    }
    if (schema.items) {
      value.forEach((v, i) => {
        errors.push(...validate(root, schema.items as Schema, v, o, `${at}[${i}]`));
      });
    }
  }
  return errors;
}

function isType(v: unknown, type: string): boolean {
  switch (type) {
    case "string":
      return typeof v === "string";
    case "number":
      return typeof v === "number" && Number.isFinite(v);
    case "integer":
      return Number.isInteger(v);
    case "boolean":
      return typeof v === "boolean";
    case "null":
      return v === null;
    case "array":
      return Array.isArray(v);
    case "object":
      return typeof v === "object" && v !== null && !Array.isArray(v);
    default:
      return false;
  }
}
