/**
 * The official fnOS package identity.
 *
 * It is decided by the server-side review of the quarantined archive, never by
 * the Skill name the operator typed when registering it. The name is only a
 * display label: a typo must not lock the official CLI out of an otherwise
 * valid, server reviewed official package.
 *
 * A record qualifies when all of the following hold:
 *   - the server itself produced the review (`reviewedBy === "server"`),
 *   - the reviewed manifest declares the official `fnos` package name,
 *   - the review was made against exactly the archive the record points at.
 */
export function isOfficialFnosPackage(record) {
  if (!record || typeof record !== "object") return false;
  const review = record.manifestReview;
  if (!review || typeof review !== "object") return false;
  if (review.reviewedBy !== "server") return false;
  if (typeof review.name !== "string" || review.name.toLowerCase() !== "fnos") return false;
  if (typeof record.archiveSha256 !== "string" || !/^[a-f0-9]{64}$/.test(record.archiveSha256)) return false;
  if (review.archiveSha256 !== record.archiveSha256) return false;
  if (typeof record.quarantineFile !== "string") return false;
  if (record.quarantineFile !== `skill-quarantine/${record.archiveSha256}.zip`) return false;
  return true;
}
