const RISK_LEVELS = new Set(["read-only", "write", "destructive", "unknown"]);
const DEFAULT_POLICY = Object.freeze({
  allowReadOnly: true,
  allowWrite: false,
  allowDestructive: false,
  allowUnknown: false
});

export function createPermissionPolicy(overrides = {}) {
  const policy = { ...DEFAULT_POLICY, ...overrides };
  for (const key of Object.keys(DEFAULT_POLICY)) {
    if (typeof policy[key] !== "boolean") throw new TypeError(`Invalid policy flag: ${key}`);
  }
  return Object.freeze({
    evaluate({ risk = "unknown", approved = false } = {}) {
      if (!RISK_LEVELS.has(risk)) return Object.freeze({ allowed: false, requiresApproval: false, reason: "unknown-risk" });
      if (risk === "read-only" && policy.allowReadOnly)
        return Object.freeze({ allowed: true, requiresApproval: false, reason: "read-only-allowed" });
      if (risk === "write" && policy.allowWrite && approved)
        return Object.freeze({ allowed: true, requiresApproval: false, reason: "write-approved" });
      if (risk === "destructive" && policy.allowDestructive && approved)
        return Object.freeze({ allowed: true, requiresApproval: false, reason: "destructive-approved" });
      if (risk === "write" || risk === "destructive")
        return Object.freeze({ allowed: false, requiresApproval: true, reason: "explicit-approval-required" });
      return Object.freeze({ allowed: false, requiresApproval: false, reason: "policy-denied" });
    },
    snapshot() {
      return Object.freeze({ ...policy, executionEnabled: false, note: "Policy evaluation only; this module does not execute tools." });
    }
  });
}
