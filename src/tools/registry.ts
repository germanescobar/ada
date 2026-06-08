import type { ToolDefinition, ToolResult, ToolSchema } from "../types/tools.js";

const SUPPORTED_PROPERTY_TYPES = new Set([
  "string",
  "number",
  "integer",
  "boolean",
  "object",
  "array",
]);

export class ToolRegistry {
  private tools = new Map<string, ToolDefinition>();

  register(tool: ToolDefinition): void {
    this.tools.set(tool.name, tool);
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  toSchemas(): ToolSchema[] {
    return Array.from(this.tools.values())
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
      }));
  }

  async execute(
    name: string,
    input: Record<string, unknown>
  ): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return { content: `Unknown tool: ${name}`, isError: true };
    }

    const validationError = this.validateInput(name, input);
    if (validationError) return validationError;

    return tool.execute(input);
  }

  validateInput(
    name: string,
    input: Record<string, unknown>
  ): ToolResult | null {
    const tool = this.tools.get(name);
    if (!tool) return null;

    const errors = validateAgainstSchema(tool.inputSchema, input);
    if (errors.length === 0) return null;

    return {
      content: `Invalid input for tool "${name}": ${errors.join(" ")}`,
      isError: true,
      metadata: {
        validationErrors: errors,
      },
    };
  }
}

function validateAgainstSchema(
  schema: Record<string, unknown>,
  input: Record<string, unknown>
): string[] {
  const errors: string[] = [];
  const required = readRequiredFields(schema.required);

  for (const field of required) {
    if (
      !Object.prototype.hasOwnProperty.call(input, field) ||
      input[field] === undefined
    ) {
      errors.push(`missing required field "${field}".`);
    }
  }

  const properties = readProperties(schema.properties);
  for (const [field, propertySchema] of Object.entries(properties)) {
    if (
      !Object.prototype.hasOwnProperty.call(input, field) ||
      input[field] === undefined
    ) {
      continue;
    }

    const expectedType = readExpectedType(propertySchema);
    if (!expectedType) continue;

    const value = input[field];
    if (!matchesType(value, expectedType)) {
      errors.push(`field "${field}" must be ${formatExpectedType(expectedType)}.`);
    }
  }

  return errors;
}

function readRequiredFields(required: unknown): string[] {
  if (!Array.isArray(required)) return [];
  return required.filter((field): field is string => typeof field === "string");
}

function readProperties(
  properties: unknown
): Record<string, Record<string, unknown>> {
  if (!isPlainObject(properties)) return {};

  const result: Record<string, Record<string, unknown>> = {};
  for (const [field, propertySchema] of Object.entries(properties)) {
    if (isPlainObject(propertySchema)) {
      result[field] = propertySchema;
    }
  }
  return result;
}

function readExpectedType(schema: Record<string, unknown>): string | null {
  const type = schema.type;
  if (typeof type !== "string") return null;
  return SUPPORTED_PROPERTY_TYPES.has(type) ? type : null;
}

function matchesType(value: unknown, expectedType: string): boolean {
  switch (expectedType) {
    case "array":
      return Array.isArray(value);
    case "boolean":
      return typeof value === "boolean";
    case "integer":
      return Number.isInteger(value);
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "object":
      return isPlainObject(value);
    case "string":
      return typeof value === "string";
    default:
      return true;
  }
}

function formatExpectedType(expectedType: string): string {
  return expectedType === "integer" ? "an integer" : `a ${expectedType}`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
