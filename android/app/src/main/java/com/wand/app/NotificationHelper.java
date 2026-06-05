package com.wand.app;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.media.AudioAttributes;
import android.media.AudioManager;
import android.media.MediaPlayer;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;

import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.HashMap;
import java.util.Map;

final class NotificationHelper {

    static final String CHANNEL_ID_SILENT = "wand_notif_silent";
    static final String CHANNEL_ID_TASKS = "wand_notif_tasks";
    static final String CHANNEL_ID_UPDATES = "wand_notif_updates";
    static final String CHANNEL_ID_PROGRESS = "wand_notif_progress";

    private static final String CHANNEL_ID_PREFIX_LEGACY = "wand_notif_";
    private static final String CHANNEL_ID_LEGACY = "wand_notifications";
    private static final int NOTIFICATION_ID_BASE = 2000;
    private static final long PROGRESS_UPDATE_DEBOUNCE_MS = 50;
    private static final long PROGRESS_STALE_MS = 5 * 60 * 1000;

    static final String[][] SOUND_PRESETS = {
        {"chime",  "叮咚"},
        {"bubble", "气泡"},
        {"meow",   "喵~"},
        {"bell",   "铃声"},
    };

    private static final AudioAttributes NOTIF_AUDIO_ATTRS = new AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_NOTIFICATION)
            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
            .setLegacyStreamType(AudioManager.STREAM_NOTIFICATION)
            .build();

    private final Context context;
    private int notificationCounter = 0;
    private final Map<String, Long> progressUpdateTimestamps = new HashMap<>();
    private final Map<String, Runnable> pendingProgressUpdates = new HashMap<>();
    private final Handler mainHandler = new Handler(Looper.getMainLooper());

    NotificationHelper(Context context) {
        this.context = context;
    }

    void createChannels() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager nm = context.getSystemService(NotificationManager.class);
        if (nm == null) return;

        nm.deleteNotificationChannel(CHANNEL_ID_LEGACY);
        for (String[] preset : SOUND_PRESETS) {
            nm.deleteNotificationChannel(CHANNEL_ID_PREFIX_LEGACY + preset[0]);
        }

        if (nm.getNotificationChannel(CHANNEL_ID_SILENT) == null) {
            NotificationChannel channel = new NotificationChannel(
                    CHANNEL_ID_SILENT, "Wand 轻提醒", NotificationManager.IMPORTANCE_DEFAULT);
            channel.setDescription("低优先级提醒（铃声由应用内控制）");
            channel.setSound(null, null);
            nm.createNotificationChannel(channel);
        }

        if (nm.getNotificationChannel(CHANNEL_ID_TASKS) == null) {
            NotificationChannel channel = new NotificationChannel(
                    CHANNEL_ID_TASKS, "Wand 任务", NotificationManager.IMPORTANCE_DEFAULT);
            channel.setDescription("任务进展与权限提醒");
            channel.setSound(null, null);
            nm.createNotificationChannel(channel);
        }

        if (nm.getNotificationChannel(CHANNEL_ID_UPDATES) == null) {
            NotificationChannel channel = new NotificationChannel(
                    CHANNEL_ID_UPDATES, "Wand 更新", NotificationManager.IMPORTANCE_HIGH);
            channel.setDescription("版本更新提醒");
            channel.setSound(null, null);
            nm.createNotificationChannel(channel);
        }

        if (nm.getNotificationChannel(CHANNEL_ID_PROGRESS) == null) {
            NotificationChannel channel = new NotificationChannel(
                    CHANNEL_ID_PROGRESS, "Wand 实时进度", NotificationManager.IMPORTANCE_LOW);
            channel.setDescription("任务实时进度通知");
            channel.setSound(null, null);
            channel.setShowBadge(false);
            nm.createNotificationChannel(channel);
        }
    }

    boolean hasPostNotificationPermission() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return true;
        return ContextCompat.checkSelfPermission(context,
                android.Manifest.permission.POST_NOTIFICATIONS)
                == PackageManager.PERMISSION_GRANTED;
    }

    boolean isSystemMuted() {
        AudioManager am = (AudioManager) context.getSystemService(Context.AUDIO_SERVICE);
        if (am == null) return false;
        int mode = am.getRingerMode();
        if (mode == AudioManager.RINGER_MODE_SILENT
                || mode == AudioManager.RINGER_MODE_VIBRATE) {
            return true;
        }
        return am.getStreamVolume(AudioManager.STREAM_NOTIFICATION) == 0;
    }

    void playNotificationSound(ServerStore serverStore) {
        if (isSystemMuted()) return;
        playPresetSound(serverStore.getNotificationSound(), serverStore.getNotificationVolume() / 100f);
    }

    void playPresetSound(String soundName, float vol) {
        if (vol <= 0) return;
        int resId = context.getResources().getIdentifier("notif_" + soundName, "raw", context.getPackageName());
        if (resId == 0) return;
        try {
            MediaPlayer mp = MediaPlayer.create(context, resId, NOTIF_AUDIO_ATTRS, 0);
            if (mp != null) {
                mp.setVolume(vol, vol);
                mp.setOnCompletionListener(MediaPlayer::release);
                mp.start();
            }
        } catch (Exception ignored) {}
    }

    static boolean isValidSound(String name) {
        for (String[] preset : SOUND_PRESETS) {
            if (preset[0].equals(name)) return true;
        }
        return false;
    }

    String resolveChannel(String tag) {
        if (tag == null || tag.isEmpty()) return CHANNEL_ID_SILENT;
        if (tag.startsWith("update:")) return CHANNEL_ID_UPDATES;
        if (tag.startsWith("task:") || tag.startsWith("permission:") || tag.startsWith("task-ended:"))
            return CHANNEL_ID_TASKS;
        return CHANNEL_ID_SILENT;
    }

    int resolvePriority(String channelId) {
        if (CHANNEL_ID_UPDATES.equals(channelId)) return NotificationCompat.PRIORITY_HIGH;
        return NotificationCompat.PRIORITY_DEFAULT;
    }

    void sendNotification(String title, String body, String tag,
                          PendingIntent contentIntent, ServerStore serverStore) {
        if (!hasPostNotificationPermission()) return;

        String channelId = resolveChannel(tag);
        NotificationCompat.Builder builder = new NotificationCompat.Builder(context, channelId)
                .setSmallIcon(R.drawable.ic_notification)
                .setContentTitle(title != null ? title : "Wand")
                .setContentText(body != null ? body : "")
                .setStyle(new NotificationCompat.BigTextStyle().bigText(body != null ? body : ""))
                .setPriority(resolvePriority(channelId))
                .setContentIntent(contentIntent)
                .setAutoCancel(true)
                .setSilent(true);

        if (tag != null) {
            NotificationManagerCompat.from(context).notify(tag, 0, builder.build());
        } else {
            NotificationManagerCompat.from(context).notify(
                    NOTIFICATION_ID_BASE + (notificationCounter++ % 20), builder.build());
        }

        playNotificationSound(serverStore);
    }

    void updateSessionProgress(String sessionId, String jsonData, PendingIntent contentIntent) {
        if (sessionId == null || sessionId.isEmpty() || jsonData == null) return;
        if (!hasPostNotificationPermission()) return;
        evictStaleEntries();
        long now = System.currentTimeMillis();
        Long lastUpdate = progressUpdateTimestamps.get(sessionId);
        if (lastUpdate != null && (now - lastUpdate) < PROGRESS_UPDATE_DEBOUNCE_MS) {
            Runnable pending = pendingProgressUpdates.remove(sessionId);
            if (pending != null) mainHandler.removeCallbacks(pending);
            Runnable deferred = () -> {
                pendingProgressUpdates.remove(sessionId);
                progressUpdateTimestamps.put(sessionId, System.currentTimeMillis());
                doUpdateSessionProgress(sessionId, jsonData, contentIntent);
            };
            pendingProgressUpdates.put(sessionId, deferred);
            mainHandler.postDelayed(deferred, PROGRESS_UPDATE_DEBOUNCE_MS);
            return;
        }
        progressUpdateTimestamps.put(sessionId, now);
        doUpdateSessionProgress(sessionId, jsonData, contentIntent);
    }

    void clearSessionProgress(String sessionId) {
        if (sessionId == null || sessionId.isEmpty()) return;
        progressUpdateTimestamps.remove(sessionId);
        Runnable pending = pendingProgressUpdates.remove(sessionId);
        if (pending != null) mainHandler.removeCallbacks(pending);
        NotificationManagerCompat.from(context).cancel("progress:" + sessionId, 0);
    }

    void cancelAllProgress() {
        NotificationManagerCompat nm = NotificationManagerCompat.from(context);
        for (String sessionId : progressUpdateTimestamps.keySet()) {
            nm.cancel("progress:" + sessionId, 0);
        }
        progressUpdateTimestamps.clear();
        pendingProgressUpdates.clear();
        mainHandler.removeCallbacksAndMessages(null);
    }

    private void evictStaleEntries() {
        if (progressUpdateTimestamps.size() <= 8) return;
        long now = System.currentTimeMillis();
        progressUpdateTimestamps.entrySet().removeIf(e -> now - e.getValue() > PROGRESS_STALE_MS);
    }

    private void doUpdateSessionProgress(String sessionId, String jsonData,
                                          PendingIntent contentIntent) {
        try {
            JSONObject data = new JSONObject(jsonData);
            String sessionLabel = data.optString("sessionLabel", sessionId);
            String status = data.optString("status", "running");
            String latestUserText = data.optString("latestUserText", "");
            JSONArray todosArray = data.optJSONArray("todos");

            int total = todosArray != null ? todosArray.length() : 0;
            int completed = 0;
            int inProgress = 0;

            if (todosArray != null) {
                for (int i = 0; i < todosArray.length(); i++) {
                    JSONObject todo = todosArray.getJSONObject(i);
                    String todoStatus = todo.optString("status", "pending");
                    if ("completed".equals(todoStatus)) {
                        completed++;
                    } else if ("in_progress".equals(todoStatus)) {
                        inProgress++;
                    }
                }
            }

            boolean isOngoingState = "running".equals(status) || "thinking".equals(status)
                    || "initializing".equals(status);

            String capsuleText;
            if (!isOngoingState) {
                capsuleText = "完成";
            } else if (inProgress > 0) {
                capsuleText = String.valueOf(inProgress);
            } else {
                capsuleText = "运行";
            }

            String displayTitle = truncateForNotification(
                    pickFirstNonEmpty(latestUserText, sessionLabel, "Wand"), 40);
            String contentText;
            if (!isOngoingState) {
                contentText = "已完成";
            } else if (total > 0) {
                contentText = "执行中";
            } else {
                contentText = "正在执行";
            }

            NotificationCompat.Builder builder = new NotificationCompat.Builder(context, CHANNEL_ID_PROGRESS)
                    .setSmallIcon(R.drawable.ic_notification)
                    .setContentTitle(displayTitle)
                    .setContentText(contentText)
                    .setContentIntent(contentIntent)
                    .setOngoing(isOngoingState)
                    .setOnlyAlertOnce(true)
                    .setSilent(true)
                    .setAutoCancel(!isOngoingState);

            if (isOngoingState && total > 0) {
                if (Build.VERSION.SDK_INT >= 36) {
                    buildProgressStyleNotification(builder, todosArray, total, completed, inProgress);
                } else {
                    buildFallbackProgressNotification(builder, total, completed);
                }
            }

            builder.setShortCriticalText(capsuleText);
            if (isOngoingState) {
                builder.setRequestPromotedOngoing(true);
            }

            NotificationManagerCompat.from(context).notify("progress:" + sessionId, 0, builder.build());
        } catch (Exception ignored) {}
    }

    private static String pickFirstNonEmpty(String... candidates) {
        if (candidates == null) return "";
        for (String c : candidates) {
            if (c != null && !c.isEmpty()) return c;
        }
        return "";
    }

    private static String truncateForNotification(String text, int max) {
        if (text == null) return "";
        String compact = text.replace('\n', ' ').replace('\r', ' ').trim();
        if (compact.length() <= max) return compact;
        return compact.substring(0, Math.max(0, max - 1)) + "…";
    }

    private void buildProgressStyleNotification(NotificationCompat.Builder builder,
            JSONArray todosArray, int total, int completed, int inProgress) {
        try {
            NotificationCompat.ProgressStyle progressStyle = new NotificationCompat.ProgressStyle();
            int currentProgress = completed * 100 + (inProgress > 0 ? 50 : 0);
            progressStyle.setStyledByProgress(false);
            progressStyle.setProgress(currentProgress);

            int completedColor = Color.parseColor("#4CAF50");
            int activeColor = Color.parseColor("#2196F3");
            int pendingColor = Color.parseColor("#9E9E9E");

            for (int i = 0; i < todosArray.length(); i++) {
                JSONObject todo = todosArray.getJSONObject(i);
                String todoStatus = todo.optString("status", "pending");
                int color;
                if ("completed".equals(todoStatus)) {
                    color = completedColor;
                } else if ("in_progress".equals(todoStatus)) {
                    color = activeColor;
                } else {
                    color = pendingColor;
                }
                progressStyle.addProgressSegment(
                        new NotificationCompat.ProgressStyle.Segment(100).setColor(color));
            }

            builder.setStyle(progressStyle);
            builder.setSubText(completed + "/" + total);
        } catch (Exception e) {
            buildFallbackProgressNotification(builder, total, completed);
        }
    }

    private void buildFallbackProgressNotification(NotificationCompat.Builder builder,
            int total, int completed) {
        builder.setProgress(total, completed, false);
        builder.setSubText(completed + "/" + total);
    }
}
