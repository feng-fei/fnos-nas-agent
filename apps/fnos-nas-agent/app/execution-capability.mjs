/**
 * Server-side capability token for destructive operations.
 *
 * The symbol is deliberately module-private (a plain `Symbol`, never `Symbol.for`),
 * so it cannot be reconstructed from JSON, from an HTTP request body, or from any
 * other module. Only code that imported this exact module can mint a capability,
 * which is what turns "the client asked nicely" into "the server authorized it".
 *
 * Lifecycle:
 *   1. A destructive tool call is queued for confirmation (no capability yet).
 *   2. The server consumes the one-time approval grant and invokes the tool with
 *      `{ capability: DELETE_CAPABILITY }`.
 *   3. The file manager only accepts a delete when `hasDeleteCapability(input.capability)`
 *      is true. A request body field such as `confirm: true` is NOT a capability.
 */
export const DELETE_CAPABILITY = Symbol("fnos-nas-agent.delete-capability");

export function hasDeleteCapability(value) {
  return value === DELETE_CAPABILITY;
}
