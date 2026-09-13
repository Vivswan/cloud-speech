# Cloud Speech store screenshots

The Chrome Web Store listing screenshots for Cloud Speech
(https://github.com/Vivswan/cloud-speech), rendered by CI from the built extension
and the e2e fake speech server; no provider account is involved.

- Rendered from commit ec01d2b9a7ccce362f1e38929e8bb9da0ce2aeb0 (https://github.com/Vivswan/cloud-speech/commit/ec01d2b9a7ccce362f1e38929e8bb9da0ce2aeb0)
- Regenerated on every green push to main: post-green.yml runs
  "bun run screenshots:store" (apps/extension/tests/e2e/store-screenshots.ts)
  and publish-screenshots.yml replaces this branch with one commit
  holding the new sets, so the branch has no history.
- Stable URL for a file:
  https://raw.githubusercontent.com/Vivswan/cloud-speech/store-screenshots/LOCALE/FILE

Layout: one set per language the extension ships, in a directory
named after the store's language code, and the English set at the
root as well (where the set lived before there were several, so
older URLs keep resolving):

- en/, hi/, zh-CN/, zh-TW/: the sets, one directory each
- SCENE.jpg and the rest at the root: the English set again

Files in a set:

- SCENE.jpg: 1280 x 800, the store upload, a focus crop of the composition
- SCENE-2x.jpg: 2560 x 1600, the whole composition
- crops.json: for each scene, where its store crop sits in the 2x
  image, in that image's pixels

What each scene shows and how it is staged: docs/store-listing.md
in the source repository.
