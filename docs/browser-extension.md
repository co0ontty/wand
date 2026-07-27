# Wand Passwords Browser Extension

The extension source lives in `browser-extension/` and defaults to:

```text
https://home.huniu.fun:8183
```

Load it in Chrome/Edge/Brave from `chrome://extensions` with Developer Mode enabled, then choose `Load unpacked` and select `browser-extension/`.

## 1Password Baseline Coverage

- Save logins from browser forms after submit confirmation.
- Remember third-party sign-in choices such as Google, Apple, GitHub, Microsoft, Facebook, GitLab, and Twitter.
- Autofill login username/password and TOTP codes.
- Search, open, and fill items from the extension popup.
- Generate strong passwords locally in the popup or context menu.
- Store and fill credit card fields.
- Store and fill identity/address fields.
- Organize items into vaults through the server API.
- Copy usernames/passwords from the popup.
- Lock/unlock the extension with a Wand-issued app token.
- Disable or re-enable Wand suggestions per website.
- Watchtower-style report for weak, reused, missing-URL, and old-password items.
- Passkeys are supported through Chrome MV3 `webAuthenticationProxy` on browsers that expose that API; unsupported browsers fall back to passwords/cards/identities without passkey interception.

## Server API

The extension signs in through `POST /api/login` with:

```json
{ "password": "...", "client": "browser-extension" }
```

The response includes an `appToken`. Later requests use:

```text
Authorization: Bearer <appToken>
```

Changing the Wand password invalidates existing extension tokens.
