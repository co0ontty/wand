package com.wand.app;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONArray;
import org.json.JSONException;

import java.util.ArrayList;
import java.util.List;

/**
 * Manages server URL persistence using SharedPreferences.
 */
public class ServerStore {

    private static final String PREFS_NAME = "wand_servers";
    private static final String KEY_RECENT = "recent_urls";
    private static final String KEY_LAST = "last_url";
    private static final String KEY_APP_TOKEN = "app_token";
    private static final int MAX_RECENT = 5;

    private final SharedPreferences prefs;

    public ServerStore(Context context) {
        prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
    }

    public String getLastUrl() {
        return prefs.getString(KEY_LAST, "");
    }

    public void setLastUrl(String url) {
        prefs.edit().putString(KEY_LAST, url).apply();
    }

    public List<String> getRecentUrls() {
        List<String> list = new ArrayList<>();
        String json = prefs.getString(KEY_RECENT, "[]");
        try {
            JSONArray arr = new JSONArray(json);
            for (int i = 0; i < arr.length(); i++) {
                list.add(arr.getString(i));
            }
        } catch (JSONException e) {
            // ignore
        }
        return list;
    }

    public void addRecentUrl(String url) {
        List<String> list = getRecentUrls();
        list.remove(url);
        list.add(0, url);
        while (list.size() > MAX_RECENT) {
            list.remove(list.size() - 1);
        }
        JSONArray arr = new JSONArray(list);
        prefs.edit().putString(KEY_RECENT, arr.toString()).apply();
    }

    public void removeRecentUrl(String url) {
        List<String> list = getRecentUrls();
        list.remove(url);
        JSONArray arr = new JSONArray(list);
        prefs.edit().putString(KEY_RECENT, arr.toString()).apply();
    }

    public void clearRecent() {
        prefs.edit().putString(KEY_RECENT, "[]").apply();
    }

    public String getSkippedVersion() {
        return prefs.getString("skipped_apk_version", "");
    }

    public void setSkippedVersion(String version) {
        prefs.edit().putString("skipped_apk_version", version).apply();
    }

    public String getAppToken() {
        return prefs.getString(KEY_APP_TOKEN, "");
    }

    public void setAppToken(String token) {
        prefs.edit().putString(KEY_APP_TOKEN, token).apply();
    }

    public void clearAppToken() {
        prefs.edit().remove(KEY_APP_TOKEN).apply();
    }
}
