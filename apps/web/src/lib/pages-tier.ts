import { SITE_BASE, SITE_ORIGIN } from "@cloud-speech/constants";

// The platform's Pages deploy builds the site once per tier under the PAGES_* contract (repo-platform's
// docs/pages.md); every other build (dev, CI) sets none of them and falls back to the constants.
//   root    the mount root: the newest served tag, or main HEAD while no tag builds the site
//   latest  latest/, main HEAD
//   tag     one vX.Y.Z/ directory
//   single  the one build of an unversioned mount
const tier = process.env.PAGES_TIER ?? "";

export const siteOrigin = process.env.PAGES_ORIGIN ?? SITE_ORIGIN;
export const siteBase = process.env.PAGES_BASE_PATH ?? SITE_BASE;

/** latest/ and vX.Y.Z/ duplicate the root's content, so only the root or single tier (or a build outside
 *  the pipeline) is indexed and ships a sitemap. */
export const isIndexableTier = tier === "" || tier === "root" || tier === "single";
