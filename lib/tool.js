/**
 * dsh-plugin-photoshop — a dependency-free `defineTool` equivalent.
 *
 * The official helper lives in `@deepseek-ai/dsh-tools`, but that package is
 * only resolvable from inside a booted profile (pnpm hoists it to
 * `<DSH_HOME>/profiles/node_modules`). A published plugin must keep working
 * regardless of the installer, the package manager's hoisting layout, or the
 * host's version — so this module reproduces the exact registry-ready
 * definition shape the tool registry consumes, using nothing but plain
 * JavaScript:
 *
 *   {
 *     name, description,
 *     parameters: <raw JSON Schema, object-rooted>,
 *     output: { schema: <raw JSON Schema>, render(args, value): ContentBlock[] },
 *     timeoutMs?,
 *     execute(args, exec): Promise<canonicalValue>,
 *     isConcurrencySafe?(args): boolean,
 *   }
 *
 * The author-facing parameter spec is the same one the official helper takes:
 * a map of property name to schema node, where requiredness is the per-property
 * `required: true` annotation rather than a sibling `required` array.
 */

/** Value schema node types this plugin actually declares. */
const SCALAR_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'null'])

/**
 * Convert one author-facing value schema node into a raw JSON Schema node.
 * @param spec - the author-facing node.
 * @param path - property path, for error messages.
 * @returns an equivalent raw JSON Schema node.
 */
function toJsonSchema(spec, path) {
  if (spec === null || typeof spec !== 'object') {
    throw new Error(`invalid schema at ${path}: expected an object`)
  }
  const out = {}
  if (typeof spec.description === 'string') out.description = spec.description
  if (Array.isArray(spec.enum)) out.enum = [...spec.enum]
  if ('const' in spec) out.const = spec.const

  const type = spec.type
  if (type === 'json') return out
  if (SCALAR_TYPES.has(type)) {
    out.type = type
    return out
  }
  if (type === 'array') {
    out.type = 'array'
    if (spec.items !== undefined) out.items = toJsonSchema(spec.items, `${path}[]`)
    return out
  }
  if (type === 'object') {
    out.type = 'object'
    out.properties = toPropertyMap(spec.properties ?? {}, path).properties
    const required = toPropertyMap(spec.properties ?? {}, path).required
    if (required !== undefined) out.required = required
    out.additionalProperties = spec.additionalProperties ?? false
    return out
  }
  throw new Error(`invalid schema at ${path}: unsupported type ${JSON.stringify(type)}`)
}

/**
 * Convert an author-facing property map into raw JSON Schema `properties` plus
 * the sibling `required` array.
 * @param spec - per-property author-facing nodes.
 * @param path - parent path, for error messages.
 * @returns the compiled properties and required list.
 */
function toPropertyMap(spec, path) {
  const properties = {}
  const required = []
  for (const key of Object.keys(spec)) {
    if (typeof key !== 'string') throw new Error(`invalid schema at ${path}: symbol keys are not supported`)
    const node = spec[key]
    const { required: isRequired, ...authorNode } = node ?? {}
    properties[key] = toJsonSchema(authorNode, `${path}.${key}`)
    if (isRequired === true) required.push(key)
  }
  return required.length > 0 ? { properties, required } : { properties }
}

/**
 * Report the first batch of argument violations against an author-facing spec.
 * Deliberately small: it covers requiredness and primitive shape, which is what
 * this plugin's tools can actually violate.
 * @param spec - the author-facing parameter spec.
 * @param args - candidate arguments.
 * @returns path-qualified violations; empty means valid.
 */
function validate(spec, args) {
  const violations = []
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    return ['<root>: expected an object']
  }
  for (const key of Object.keys(spec)) {
    const node = spec[key] ?? {}
    const value = args[key]
    if (value === undefined || value === null) {
      if (node.required === true) violations.push(`${key}: required`)
      continue
    }
    if (node.type === 'string' && typeof value !== 'string') violations.push(`${key}: expected a string`)
    else if ((node.type === 'number' || node.type === 'integer') && typeof value !== 'number') violations.push(`${key}: expected a number`)
    else if (node.type === 'boolean' && typeof value !== 'boolean') violations.push(`${key}: expected a boolean`)
    else if (node.type === 'array' && !Array.isArray(value)) violations.push(`${key}: expected an array`)
    if (Array.isArray(node.enum) && !node.enum.includes(value)) {
      violations.push(`${key}: expected one of ${node.enum.map((v) => JSON.stringify(v)).join(', ')}`)
    }
    if (node.type === 'array' && Array.isArray(value) && node.items?.type === 'string') {
      value.forEach((item, index) => {
        if (typeof item !== 'string') violations.push(`${key}[${index}]: expected a string`)
      })
    }
  }
  return violations
}

/**
 * Build a registry-ready tool definition.
 * @param options - name, description, author-facing parameters, output contract, execute.
 * @returns the definition `ctx.tools.register` accepts.
 */
export function defineTool(options) {
  const { name, description, parameters, output, timeoutMs, isConcurrencySafe, execute } = options
  if (typeof name !== 'string' || name.length === 0) throw new Error('defineTool: name is required')
  if (typeof execute !== 'function') throw new Error(`defineTool(${name}): execute is required`)
  if (output === undefined || typeof output.render !== 'function') {
    throw new Error(`defineTool(${name}): output.render is required`)
  }
  if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
    throw new Error(`defineTool(${name}): timeoutMs must be a positive finite number`)
  }

  const compiledParameters = {
    type: 'object',
    properties: toPropertyMap(parameters ?? {}, 'parameters').properties,
  }
  const required = toPropertyMap(parameters ?? {}, 'parameters').required
  if (required !== undefined) compiledParameters.required = required

  const tool = {
    name,
    description,
    parameters: compiledParameters,
    output: {
      schema: toJsonSchema(output.schema, 'output.schema'),
      render: (args, value) => output.render(args, value),
    },
    async execute(args, exec) {
      const violations = validate(parameters ?? {}, args)
      if (violations.length > 0) throw new Error(`invalid arguments: ${violations.join('; ')}`)
      return execute(args, exec)
    },
  }
  if (timeoutMs !== undefined) tool.timeoutMs = timeoutMs
  if (isConcurrencySafe !== undefined) tool.isConcurrencySafe = (args) => isConcurrencySafe(args)
  return tool
}
