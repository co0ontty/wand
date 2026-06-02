export declare class PromptOptimizeError extends Error {
    readonly code: string;
    constructor(message: string, code: string);
}
export declare function optimizePrompt(rawText: string, language: string, cwd?: string): Promise<string>;
