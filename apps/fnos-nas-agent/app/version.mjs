/**
 * Single source of truth for the application version.
 *
 * The FPK package version (apps/fnos-nas-agent/manifest), the npm package version
 * (package.json) and the version reported by /api/health must never drift apart.
 * Release tooling and the release gates compare these values, so this module only
 * ever changes together with those two files.
 */
export const APP_VERSION = "0.2.1";

export default APP_VERSION;
