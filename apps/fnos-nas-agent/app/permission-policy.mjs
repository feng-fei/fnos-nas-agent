import { createExecutionPolicy } from "./execution-policy.mjs";

const LEGACY_RISK_LEVELS = new Set(["read-only", "write", "destructive", "unknown"]);
const DEFAULT_POLICY = Object.freeze({
  allowReadOnly: true,
  allowWrite: true,
  allowDestructive: true,
  allowUnknown: false
});
// The reason vocabulary of this module predates the execution policy. It is kept so
// the existing callers and the release gates keep their expectations, while the
// verdict itself is now made in exactly one place.
const ALLOWED_REASONS = Object.freeze({
  "read-only": "read-only-allowed",
  "write": "write-allowed",
  "destructive": "destructive-approved"
});

export function createPermissionPolicy(overrides = {}) {
  const policy = { ...DEFAULT_POLICY, ...overrides };
  for (const key of Object.keys(DEFAULT_POLICY)) {
    if (typeof policy[key] !== "boolean") throw new TypeError(`Invalid policy flag: ${key}`);
  }
  // The global execution policy is the single decision point. This wrapper only
  // translates the legacy flags into it and translates the verdict back.
  const executionPolicy = createExecutionPolicy({ dataDir: "", env: {} });
  const denied = reason => Object.freeze({ allowed: false, requiresApproval: false, reason });
  return Object.freeze({
    evaluate({ risk = "unknown", approved = false } = {}) {
      if (!LEGACY_RISK_LEVELS.has(risk)) return denied("unknown-risk");
      // An unknown risk is never executable, whatever the legacy flag says.
      if (risk === "unknown") return denied("policy-denied");
      if (risk === "read-only" && !policy.allowReadOnly) return denied("policy-denied");
      if (risk === "write" && !policy.allowWrite) return denied("policy-denied");
      if (risk === "destructive" && !policy.allowDestructive) return denied("policy-denied");
      const decision = executionPolicy.evaluate({ risk, approved });
      if (!decision.allowed) {
        return Object.freeze({
          allowed: false,
          requiresApproval: decision.requiresApproval === true,
          reason: decision.requiresApproval === true ? "explicit-approval-required" : "policy-denied"
        });
      }
      return Object.freeze({ allowed: true, requiresApproval: false, reason: ALLOWED_REASONS[risk] });
    },
    snapshot() {
      return Object.freeze({ ...policy, executionEnabled: false, note: "Policy evaluation only; this module does not execute tools." });
    }
  });
}
