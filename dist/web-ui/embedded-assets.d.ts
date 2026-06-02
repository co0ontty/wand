export declare const EMBEDDED_WEB_ASSET_VERSION = "5149a02c8fe4";
export declare const EMBEDDED_WEB_ASSETS: {
    readonly scriptsJs: string;
    readonly stylesCss: string;
    readonly vendor: {
        readonly "/vendor/wterm/wterm.bundle.js": {
            readonly content: string;
            readonly contentType: "application/javascript";
            readonly hash: "5c8595b1";
        };
        readonly "/vendor/wterm/terminal.css": {
            readonly content: string;
            readonly contentType: "text/css; charset=utf-8";
            readonly hash: "e6459118";
        };
        readonly "/vendor/qrcode/qrcode.bundle.js": {
            readonly content: string;
            readonly contentType: "application/javascript";
            readonly hash: "8be76aad";
        };
    };
};
export type EmbeddedVendorAssetPath = keyof typeof EMBEDDED_WEB_ASSETS.vendor;
