import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = (path: string) => readFileSync(new URL(`../android/app/src/${path}`, import.meta.url), "utf8");
const main = (path: string) => source(`main/java/com/wand/app/${path}`);

test("Android plain addresses use password authentication and never accept 401 as a successful connection", () => {
  const activity = main("ConnectActivity.java");
  assert.match(activity, /PasswordConnection\.connect\(baseUrl, password, timeout\)/);
  assert.match(activity, /return verifyPassword\(serverUrl, "", timeout\)/);
  assert.match(activity, /if \(result\.needsPassword\) connectView\.requestPassword\(result\.serverUrl, serverId\)/);
  assert.doesNotMatch(activity, /code == 200 \|\| code == 401/);
  const view = main("ConnectComposeView.kt");
  assert.match(view, /ConnectionPasswordField\(/);
  assert.match(view, /inputValue\.isNotBlank\(\) && !hasConnectionCode && passwordServerId == null/);
  assert.match(view, /passwordContent\(profile\.id\)/);
});

test("Android discovery remains bounded, read-only, network-bound and lifecycle-cancelled", () => {
  const discovery = main("data/LanDiscovery.kt");
  assert.match(discovery, /CookieJar\.NO_COOKIES/);
  assert.match(discovery, /socketFactory\(network\.socketFactory\)/);
  assert.match(discovery, /withTimeoutOrNull\(30_000\)/);
  assert.match(discovery, /repeat\(16\)/);
  assert.match(discovery, /peekBody\(4096\)/);
  assert.match(discovery, /invokeOnCancellation \{ call\.cancel\(\) \}/);
  assert.doesNotMatch(discovery, /\/api\/login|\/api\/sessions|appToken|\.put\("password"/);
  assert.match(discovery, /\.username\(""\)\.password\(""\)\.query\(null\)\.fragment\(null\)/);
  assert.match(main("ConnectActivity.java"), /protected void onStop\(\) \{\s*if \(lanDiscovery != null\) lanDiscovery\.stop\(\)/);
  const view = main("ConnectComposeView.kt");
  assert.ok(view.indexOf("LanServerSection(") > view.indexOf("label = \"扫描二维码\""),
    "As discovery results arrive, the address/password form stays in place above the discovery list");
});

test("Android complete settings open an internal WebView by stable server ID without changing native execution", () => {
  const settings = main("ui/screens/SettingsScreen.kt");
  assert.match(settings, /ActionRow\("完整 Web 设置", WandIcons\.web, onClick = onOpenWeb\)/);
  assert.match(settings, /onOpenWeb = \{\s*context\.startActivity\(Intent\(context, WebSettingsActivity::class\.java\)/);
  assert.match(settings, /WebSettingsActivity::class\.java/);
  assert.match(settings, /putExtra\(WebSettingsActivity\.EXTRA_SERVER_ID, connection\.serverId\)/);
  const manifest = source("main/AndroidManifest.xml");
  assert.match(manifest, /android:name="\.WebSettingsActivity"\s*android:exported="false"/);
  const activity = main("WebSettingsActivity.kt");
  assert.match(activity, /store\.activeServerProfile\?\.id != selected\.id/);
  assert.match(activity, /WandDetailBackButton\(onClick = \{ finish\(\) \}\)/);
  assert.doesNotMatch(activity, /SessionWatcher|ChatStore|canGoBack|addJavascriptInterface/);
});

test("Android settings cookie transfer and certificate allowance are restricted to the selected endpoint", () => {
  const activity = main("WebSettingsActivity.kt");
  assert.match(activity, /SettingsWebAuthentication\.cookies\(session\.baseUrl, profile\.token\)/);
  assert.match(main("data/SettingsWebAuthentication.kt"), /cookieJar\(CookieJar\.NO_COOKIES\)/);
  assert.match(main("data/SettingsWebAuthentication.kt"), /\/api\/settings\/webview-session/);
  assert.match(activity, /removeAllCookies/);
  assert.match(activity, /setAcceptThirdPartyCookies\(this, false\)/);
  assert.match(activity, /settings\.allowFileAccess = false/);
  assert.match(activity, /settings\.allowContentAccess = false/);
  assert.match(activity, /MIXED_CONTENT_NEVER_ALLOW/);
  assert.match(activity, /if \(session\.accepts\(error\.url\)\) handler\.proceed\(\) else handler\.cancel\(\)/);
  assert.match(activity, /browser\.loadUrl\(session\.startUrl\)/);
  assert.match(main("SettingsWebSession.kt"), /val startUrl = "\$\{this\.baseUrl\}\/settings\?client=app"/);
  assert.doesNotMatch(activity + main("SettingsWebSession.kt"), /openSettingsScript|evaluateJavascript|MutationObserver|settings-button|trigger\.click/);
  assert.doesNotMatch(activity, /getToken\(|appToken|\?token=|password=.*evaluateJavascript/);
});
