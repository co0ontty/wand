package com.wand.app;

import android.annotation.SuppressLint;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import android.view.View;
import android.webkit.CookieManager;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;

import androidx.appcompat.app.AlertDialog;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.content.FileProvider;

import com.google.android.material.dialog.MaterialAlertDialogBuilder;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;

final class UpdateManager {

    static final int INSTALL_PERMISSION_REQUEST = 1003;

    private final AppCompatActivity activity;
    private final ServerStore serverStore;
    private final ExecutorService executor;
    private final String serverUrl;
    private File pendingInstallFile;

    UpdateManager(AppCompatActivity activity, ServerStore serverStore,
                  ExecutorService executor, String serverUrl) {
        this.activity = activity;
        this.serverStore = serverStore;
        this.executor = executor;
        this.serverUrl = serverUrl;
    }

    interface UpdateFoundCallback {
        void onUpdateFound(String currentVersion, String latestVersion,
                           String downloadUrl, String fileName, long size,
                           String source, String releaseNotes);
    }

    void checkForUpdate(UpdateFoundCallback callback) {
        String currentVersion;
        try {
            currentVersion = activity.getPackageManager()
                    .getPackageInfo(activity.getPackageName(), 0).versionName;
        } catch (Exception e) {
            return;
        }

        if (executor == null || executor.isShutdown()) return;
        executor.execute(() -> {
            try {
                String apiUrl = serverUrl + "/api/android-apk-update?currentVersion=" +
                        java.net.URLEncoder.encode(currentVersion, "UTF-8");
                HttpURLConnection conn = NetUtils.openConnection(apiUrl,
                        NetUtils.CONNECT_TIMEOUT_MS, NetUtils.READ_TIMEOUT_MS);

                String cookie = CookieManager.getInstance().getCookie(serverUrl);
                if (cookie != null) conn.setRequestProperty("Cookie", cookie);

                conn.setRequestMethod("GET");

                int code = conn.getResponseCode();
                if (code != 200) {
                    conn.disconnect();
                    return;
                }

                BufferedReader reader = new BufferedReader(
                        new InputStreamReader(conn.getInputStream(), StandardCharsets.UTF_8));
                StringBuilder sb = new StringBuilder();
                String line;
                while ((line = reader.readLine()) != null) sb.append(line);
                reader.close();
                conn.disconnect();

                JSONObject data = new JSONObject(sb.toString());
                if (!data.optBoolean("updateAvailable", false)) return;

                String latestVersion = data.optString("latestVersion", "");
                String downloadUrl = data.optString("downloadUrl", "");
                String fileName = data.optString("fileName", "wand-update.apk");
                long size = data.optLong("size", 0);
                String source = data.optString("source", "");
                String releaseNotes = data.optString("releaseNotes", "");

                if (latestVersion.isEmpty() || downloadUrl.isEmpty()) return;
                if (latestVersion.equals(serverStore.getSkippedVersion())) return;
                if (latestVersion.equals(serverStore.getDownloadedApkVersion())) return;

                activity.runOnUiThread(() -> {
                    if (activity.isDestroyed()) return;
                    callback.onUpdateFound(currentVersion, latestVersion,
                            downloadUrl, fileName, size, source, releaseNotes);
                });

            } catch (Exception ignored) {}
        });
    }

    @SuppressLint("DefaultLocale")
    void showUpdateDialog(String currentVer, String latestVer,
                          String downloadUrl, String fileName, long size,
                          String source, String releaseNotes) {
        String sizeText = size > 0 ? "\n文件大小: " + formatSize(size) : "";
        String sourceText = "github".equals(source) ? "\n来源: GitHub Release" : "";
        String notesText = (releaseNotes != null && !releaseNotes.isEmpty())
                ? "\n\n更新内容:\n" + releaseNotes : "";

        new MaterialAlertDialogBuilder(activity, R.style.Theme_Wand_Dialog)
                .setTitle(R.string.update_title)
                .setMessage("当前版本: " + currentVer + "\n最新版本: " + latestVer
                        + sizeText + sourceText + notesText)
                .setPositiveButton(R.string.update_now, (dialog, which) ->
                        downloadAndInstall(downloadUrl, fileName, source, latestVer))
                .setNegativeButton(R.string.remind_later, null)
                .setNeutralButton(R.string.skip_version, (dialog, which) ->
                        serverStore.setSkippedVersion(latestVer))
                .setCancelable(true)
                .show();
    }

    void downloadAndInstall(String downloadUrl, String fileName,
                            String source, String latestVersion) {
        if (downloadUrl == null || downloadUrl.isEmpty()) {
            Toast.makeText(activity, "下载地址为空", Toast.LENGTH_LONG).show();
            return;
        }
        if (fileName == null || fileName.isEmpty()) {
            fileName = "wand-update.apk";
        }
        final String safeFileName = fileName;

        View progressView = activity.getLayoutInflater()
                .inflate(R.layout.dialog_download_progress, null);
        final ProgressBar progressBar = progressView.findViewById(R.id.progressBar);
        final TextView progressPercent = progressView.findViewById(R.id.progressPercent);
        final TextView progressBytes = progressView.findViewById(R.id.progressBytes);

        final boolean[] cancelled = {false};
        final AlertDialog progress = new MaterialAlertDialogBuilder(activity, R.style.Theme_Wand_Dialog)
                .setView(progressView)
                .setNegativeButton(R.string.cancel_download, (d, w) -> cancelled[0] = true)
                .setCancelable(false)
                .create();
        progress.show();

        if (executor == null || executor.isShutdown()) {
            progress.dismiss();
            Toast.makeText(activity, R.string.download_failed, Toast.LENGTH_SHORT).show();
            return;
        }
        executor.execute(() -> {
            HttpURLConnection conn = null;
            try {
                String fullUrl = downloadUrl.startsWith("http")
                        ? downloadUrl : serverUrl + downloadUrl;

                conn = NetUtils.openConnection(fullUrl,
                        NetUtils.DOWNLOAD_CONNECT_TIMEOUT_MS, NetUtils.DOWNLOAD_READ_TIMEOUT_MS);

                if (!downloadUrl.startsWith("http")) {
                    String cookie = CookieManager.getInstance().getCookie(serverUrl);
                    if (cookie != null) conn.setRequestProperty("Cookie", cookie);
                }

                conn.setInstanceFollowRedirects(true);

                int responseCode = conn.getResponseCode();
                if (responseCode == 302 || responseCode == 301) {
                    String redirectUrl = conn.getHeaderField("Location");
                    conn.disconnect();
                    if (redirectUrl != null) {
                        conn = NetUtils.openConnection(redirectUrl,
                            NetUtils.DOWNLOAD_CONNECT_TIMEOUT_MS, NetUtils.DOWNLOAD_READ_TIMEOUT_MS);
                        conn.setInstanceFollowRedirects(true);
                        responseCode = conn.getResponseCode();
                    }
                }

                if (responseCode != 200) {
                    throw new Exception("服务器返回 " + responseCode);
                }

                int fileLength = conn.getContentLength();
                File outputFile = new File(activity.getExternalFilesDir(null), safeFileName);

                if (fileLength > 0) {
                    File dir = outputFile.getParentFile();
                    long usable = dir != null ? dir.getUsableSpace() : Long.MAX_VALUE;
                    if (usable < (long) fileLength + 5 * 1024 * 1024) {
                        throw new Exception("存储空间不足，需要约 " + formatSize(fileLength) + "，请清理后重试");
                    }
                }

                try (InputStream in = conn.getInputStream();
                     FileOutputStream out = new FileOutputStream(outputFile)) {
                    byte[] buffer = new byte[8192];
                    long total = 0;
                    int count;
                    long lastUiUpdate = 0;
                    final long startTime = System.currentTimeMillis();
                    while ((count = in.read(buffer)) != -1) {
                        if (cancelled[0]) break;
                        total += count;
                        out.write(buffer, 0, count);
                        long now = System.currentTimeMillis();
                        if (now - lastUiUpdate > 50 || total == fileLength) {
                            lastUiUpdate = now;
                            final long totalSnap = total;
                            final int totalLen = fileLength;
                            final long elapsed = Math.max(1, now - startTime);
                            final long bytesPerSec = totalSnap * 1000 / elapsed;
                            activity.runOnUiThread(() -> {
                                if (activity.isDestroyed()) return;
                                String speedText = "  " + formatSize(bytesPerSec) + "/s";
                                if (totalLen > 0) {
                                    int percent = (int) (totalSnap * 100 / totalLen);
                                    progressBar.setIndeterminate(false);
                                    progressBar.setProgress(percent);
                                    progressPercent.setText(percent + "%");
                                    progressBytes.setText(formatSize(totalSnap) + " / "
                                            + formatSize(totalLen) + speedText);
                                } else {
                                    progressBar.setIndeterminate(true);
                                    progressPercent.setText("大小未知");
                                    progressBytes.setText(formatSize(totalSnap) + speedText);
                                }
                            });
                        }
                    }
                }

                if (cancelled[0]) {
                    if (outputFile.exists()) {
                        try { outputFile.delete(); } catch (Exception ignored) {}
                    }
                    return;
                }

                if (!outputFile.exists() || outputFile.length() == 0) {
                    throw new Exception("下载文件为空");
                }

                String versionToRecord = latestVersion != null
                        ? latestVersion : extractVersionFromFileName(safeFileName);
                if (versionToRecord != null) {
                    serverStore.setDownloadedApkVersion(versionToRecord);
                }

                activity.runOnUiThread(() -> {
                    if (activity.isDestroyed()) return;
                    progress.dismiss();
                    installApk(outputFile);
                });

            } catch (Exception e) {
                if (cancelled[0]) return;
                final String errMsg = friendlyDownloadError(e);
                activity.runOnUiThread(() -> {
                    if (activity.isDestroyed()) return;
                    progress.dismiss();
                    new MaterialAlertDialogBuilder(activity, R.style.Theme_Wand_Dialog)
                        .setTitle("下载失败")
                        .setMessage(errMsg)
                        .setPositiveButton("重试", (d, w) ->
                                downloadAndInstall(downloadUrl, safeFileName, source, latestVersion))
                        .setNegativeButton(android.R.string.cancel, null)
                        .show();
                });
            } finally {
                if (conn != null) {
                    try { conn.disconnect(); } catch (Exception ignored) {}
                }
            }
        });
    }

    void installApk(File apkFile) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                && !activity.getPackageManager().canRequestPackageInstalls()) {
            pendingInstallFile = apkFile;
            new MaterialAlertDialogBuilder(activity, R.style.Theme_Wand_Dialog)
                .setTitle(R.string.install_permission_title)
                .setMessage(R.string.install_permission_message)
                .setPositiveButton(R.string.install_permission_goto, (d, w) -> requestInstallPermission())
                .setNegativeButton(android.R.string.cancel, (d, w) -> pendingInstallFile = null)
                .setCancelable(true)
                .show();
            return;
        }
        doInstallApk(apkFile);
    }

    boolean handleActivityResult(int requestCode) {
        if (requestCode != INSTALL_PERMISSION_REQUEST) return false;
        File toInstall = pendingInstallFile;
        pendingInstallFile = null;
        if (toInstall == null) return true;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                && activity.getPackageManager().canRequestPackageInstalls()) {
            doInstallApk(toInstall);
        } else {
            Toast.makeText(activity, R.string.install_permission_denied, Toast.LENGTH_LONG).show();
        }
        return true;
    }

    private void requestInstallPermission() {
        try {
            Intent intent = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                    Uri.parse("package:" + activity.getPackageName()));
            activity.startActivityForResult(intent, INSTALL_PERMISSION_REQUEST);
        } catch (Exception e) {
            try {
                Intent fallback = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                        Uri.parse("package:" + activity.getPackageName()));
                activity.startActivityForResult(fallback, INSTALL_PERMISSION_REQUEST);
            } catch (Exception ignored) {
                Toast.makeText(activity, R.string.install_permission_failed, Toast.LENGTH_LONG).show();
            }
        }
    }

    private void doInstallApk(File apkFile) {
        try {
            Uri apkUri = FileProvider.getUriForFile(activity,
                    activity.getPackageName() + ".fileprovider", apkFile);
            Intent intent = new Intent(Intent.ACTION_VIEW);
            intent.setDataAndType(apkUri, "application/vnd.android.package-archive");
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            activity.startActivity(intent);
        } catch (Exception e) {
            new MaterialAlertDialogBuilder(activity, R.style.Theme_Wand_Dialog)
                .setTitle("安装失败")
                .setMessage(e.getMessage())
                .setPositiveButton(android.R.string.ok, null)
                .show();
        }
    }

    private static String friendlyDownloadError(Exception e) {
        if (e instanceof java.net.SocketTimeoutException) return "下载超时，请检查网络后重试";
        if (e instanceof java.net.UnknownHostException) return "无法连接到下载服务器，请检查网络";
        if (e instanceof java.net.ConnectException) return "无法连接到下载服务器";
        String raw = e.getMessage() != null ? e.getMessage() : "";
        if (raw.contains("ENOSPC") || raw.toLowerCase().contains("space")) return "存储空间不足，请清理后重试";
        return raw.isEmpty() ? "下载失败，请稍后重试" : raw;
    }

    static String extractVersionFromFileName(String fileName) {
        if (fileName == null) return null;
        java.util.regex.Matcher m = java.util.regex.Pattern
                .compile("(\\d+\\.\\d+\\.\\d+(?:[-+][A-Za-z0-9.-]+)?)").matcher(fileName);
        return m.find() ? m.group(1) : null;
    }

    static String formatSize(long bytes) {
        if (bytes < 1024) return bytes + " B";
        if (bytes < 1024 * 1024) return String.format("%.1f KB", bytes / 1024.0);
        return String.format("%.1f MB", bytes / (1024.0 * 1024.0));
    }
}
