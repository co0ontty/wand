/** Allow JS form handlers while denying native submission and Wand-origin
 * privileges, including when an artifact is opened outside the iframe. */
export const HTML_PREVIEW_SANDBOX = "allow-scripts allow-forms";
export const HTML_PREVIEW_CSP = `sandbox ${HTML_PREVIEW_SANDBOX}; connect-src 'none'; form-action 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'`;
