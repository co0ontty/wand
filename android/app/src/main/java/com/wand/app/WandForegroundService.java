package com.wand.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.os.Build;
import android.os.IBinder;

import androidx.core.app.NotificationCompat;

public class WandForegroundService extends Service {

    private static final String CHANNEL_ID = "wand_keepalive";
    private static final int NOTIFICATION_ID = 9001;

    @Override
    public void onCreate() {
        super.onCreate();
        createChannel();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        Intent mainIntent = new Intent(this, MainActivity.class);
        mainIntent.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        if (intent != null) {
            String serverUrl = intent.getStringExtra("server_url");
            String appToken = intent.getStringExtra("app_token");
            if (serverUrl != null) mainIntent.putExtra("server_url", serverUrl);
            if (appToken != null) mainIntent.putExtra("app_token", appToken);
        }
        PendingIntent pi = PendingIntent.getActivity(this, 0, mainIntent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        Notification notification = new NotificationCompat.Builder(this, CHANNEL_ID)
                .setSmallIcon(R.drawable.ic_notification)
                .setContentTitle("Wand")
                .setContentText("会话运行中")
                .setContentIntent(pi)
                .setOngoing(true)
                .setSilent(true)
                .build();

        startForeground(NOTIFICATION_ID, notification);
        return START_STICKY;
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private void createChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationManager nm = getSystemService(NotificationManager.class);
            if (nm != null && nm.getNotificationChannel(CHANNEL_ID) == null) {
                NotificationChannel channel = new NotificationChannel(
                        CHANNEL_ID, "Wand 后台保活", NotificationManager.IMPORTANCE_LOW);
                channel.setDescription("保持会话在后台运行");
                channel.setSound(null, null);
                channel.setShowBadge(false);
                nm.createNotificationChannel(channel);
            }
        }
    }
}
