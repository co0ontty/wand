import path from "node:path";
/** Check that targetPath is within basePath (or equal to it). */
export function isPathWithinBase(targetPath, basePath) {
    const relativePath = path.relative(basePath, targetPath);
    return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}
/** Blocked folder paths that should never be browsed. */
const BLOCKED_FOLDER_PATHS = ["/etc", "/root", "/boot"];
/** Check if targetPath is inside any blocked system folder. */
export function isBlockedFolderPath(targetPath) {
    return BLOCKED_FOLDER_PATHS.some((blockedPath) => {
        const relativePath = path.relative(blockedPath, targetPath);
        return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
    });
}
/** Normalize a folder path to its absolute form. */
export function normalizeFolderPath(inputPath) {
    return path.resolve(inputPath);
}
