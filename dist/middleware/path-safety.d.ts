/** Check that targetPath is within basePath (or equal to it). */
export declare function isPathWithinBase(targetPath: string, basePath: string): boolean;
/** Check if targetPath is inside any blocked system folder. */
export declare function isBlockedFolderPath(targetPath: string): boolean;
/** Normalize a folder path to its absolute form. */
export declare function normalizeFolderPath(inputPath: string): string;
