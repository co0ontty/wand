import { localPreviewController } from "../react/local-preview/controller";
import { closeReactOverlays } from "./react-overlay-coordinator";

/**
 * Single seam through which legacy message rendering asks React to show a local
 * preview. Keeping this indirection prevents chat-render from owning overlay UI.
 */
export function openLocalPreviewFromLegacy(value: string): boolean {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) return false;
  if (!closeReactOverlays(["localPreview"])) return false;
  return normalized.startsWith("/")
    ? localPreviewController.openFile(normalized)
    : localPreviewController.openUrl(normalized);
}
