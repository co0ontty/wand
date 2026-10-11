import { test } from "node:test";

test("message image galleries retain message scope, native controls, touch and focus", {
  skip: process.env.WAND_IMAGE_GALLERY_BROWSER !== "1", timeout: 120_000,
}, async () => {
  const { runImageGalleryBrowser } = await import("./helpers/image-gallery-browser.mjs");
  await runImageGalleryBrowser();
});
