import { SITE_BASE, SITE_ORIGIN } from "@cloud-speech/constants";

// The managed pages.yml builds the site once per tier under the PAGES_*
// contract (repo-platform docs/pages.md): PAGES_ORIGIN, PAGES_BASE_PATH,
// PAGES_VERSION, and PAGES_TIER, the tier's place in the layout:
//   root    the mount root: the newest served tag, or main HEAD while no
//           tag builds the site
//   latest  latest/, main HEAD
//   tag     one vX.Y.Z/ directory
//   single  the one build of an unversioned mount
// Every other build (dev, CI) sets none of them and falls back to the
// constants.
const tier = process.env.PAGES_TIER ?? "";

export const siteOrigin = process.env.PAGES_ORIGIN ?? SITE_ORIGIN;
export const siteBase = process.env.PAGES_BASE_PATH ?? SITE_BASE;

/** Whether this build is the one copy of the site crawlers should index:
 *  the root or single tier, or a plain build outside the Pages pipeline.
 *  latest/ and vX.Y.Z/ duplicate the root's content, so they are
 *  noindexed and ship no sitemap. */
export const isIndexableTier = tier === "" || tier === "root" || tier === "single";
