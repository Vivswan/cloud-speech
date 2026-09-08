import { SITE_BASE, SITE_ORIGIN } from "@cloud-speech/constants";

// The managed pages.yml builds the site once per tier and exports
// PAGES_ORIGIN, PAGES_BASE_PATH, and PAGES_VERSION for each: the root tier
// (the newest release tag at the bare root base), latest/ (main HEAD), and
// one vX.Y.Z/ directory per served tag. Every other build (dev, CI) falls
// back to the constants and counts as the root tier.
const version = process.env.PAGES_VERSION ?? "";

export const siteOrigin = process.env.PAGES_ORIGIN ?? SITE_ORIGIN;
export const siteBase = process.env.PAGES_BASE_PATH ?? SITE_BASE;

/** True only for the vX.Y.Z/ tiers: a tag-shaped PAGES_VERSION whose base
 *  path ends in that segment. Those are historical snapshots, so they are
 *  noindexed and ship no sitemap. The root tier and latest/ stay indexable:
 *  latest/ is the only tier guaranteed to exist (the root is a redirect to
 *  it until a release tag that builds the site is served), and the root
 *  tier carries the newest tag's version at the bare root base, so its
 *  PAGES_VERSION never terminates its path. */
export const isVersionedTier =
  /^v\d/.test(version) && siteBase.replace(/\/+$/, "").endsWith(`/${version}`);
