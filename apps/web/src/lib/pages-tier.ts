import { SITE_BASE, SITE_ORIGIN } from "@cloud-speech/constants";

// The managed pages.yml builds the site once per tier and exports
// PAGES_ORIGIN, PAGES_BASE_PATH, and PAGES_VERSION for each: the root tier
// (the newest release tag at the bare root base), latest/ (main HEAD), and
// one vX.Y.Z/ directory per served tag. Every other build (dev, CI) falls
// back to the constants and counts as the root tier.
const version = process.env.PAGES_VERSION ?? "";

export const siteOrigin = process.env.PAGES_ORIGIN ?? SITE_ORIGIN;
export const siteBase = process.env.PAGES_BASE_PATH ?? SITE_BASE;

/** False for the latest/ and vX.Y.Z/ tiers, whose base path ends in their
 *  PAGES_VERSION segment; the root tier carries the newest tag's version at
 *  the bare root base (/<repo>/, or / on a custom domain). The non-root
 *  tiers are full duplicates of the root, so only the root tier is
 *  indexable and ships a sitemap. */
export const isRootTier = version === "" || !siteBase.replace(/\/+$/, "").endsWith(`/${version}`);
