import { imageViewerController } from "./controller";

const MESSAGE_IMAGES = ".markdown-content img, .wand-markdown-preview img, .inline-tool-image-thumb, .user-attachment-thumb";

/** Take a bounded snapshot of this message, never mix another reply's images. */
export function openMessageImage(image: HTMLImageElement): boolean {
  image.focus({ preventScroll: true });
  const owner = image.closest(".chat-message")
    ?? image.closest('[data-chat-renderer="canonical"]')
    ?? image.closest(".wand-markdown-preview, .markdown-content, .chat-activity-detail-section");
  const images = owner ? Array.from(owner.querySelectorAll<HTMLImageElement>(MESSAGE_IMAGES))
    .filter(candidate => !candidate.closest('[hidden], [inert], [data-image-state="error"]')
      && !(candidate.complete && candidate.naturalWidth === 0)) : [image];
  const current = images.indexOf(image);
  if (current < 0) return imageViewerController.open(image.currentSrc || image.src, image.alt);
  return imageViewerController.openGroup(images.map(candidate => ({
    src: candidate.currentSrc || candidate.src,
    label: candidate.alt,
  })), current);
}
