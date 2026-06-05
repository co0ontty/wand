package com.wand.app;

import android.content.Context;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.NetworkRequest;

final class NetworkMonitor {

    interface Listener {
        void onNetworkStateChanged(String state);
    }

    private final Context context;
    private final Listener listener;
    private ConnectivityManager.NetworkCallback networkCallback;
    private boolean hasUsableNetwork = true;

    NetworkMonitor(Context context, Listener listener) {
        this.context = context;
        this.listener = listener;
    }

    boolean hasUsableNetwork() {
        return hasUsableNetwork;
    }

    void register() {
        try {
            ConnectivityManager cm = (ConnectivityManager)
                    context.getSystemService(Context.CONNECTIVITY_SERVICE);
            if (cm == null) return;

            android.net.Network active = cm.getActiveNetwork();
            hasUsableNetwork = (active != null);

            NetworkRequest request = new NetworkRequest.Builder()
                    .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
                    .build();
            networkCallback = new ConnectivityManager.NetworkCallback() {
                @Override
                public void onAvailable(Network network) {
                    if (!hasUsableNetwork) {
                        hasUsableNetwork = true;
                        listener.onNetworkStateChanged("available");
                    } else {
                        listener.onNetworkStateChanged("changed");
                    }
                }

                @Override
                public void onLost(Network network) {
                    if (cm.getActiveNetwork() == null) {
                        hasUsableNetwork = false;
                        listener.onNetworkStateChanged("lost");
                    }
                }

                @Override
                public void onCapabilitiesChanged(Network network, NetworkCapabilities caps) {
                    if (caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
                            && caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
                            && !hasUsableNetwork) {
                        hasUsableNetwork = true;
                        listener.onNetworkStateChanged("validated");
                    }
                }
            };
            cm.registerNetworkCallback(request, networkCallback);
        } catch (Exception ignored) {}
    }

    void unregister() {
        if (networkCallback == null) return;
        try {
            ConnectivityManager cm = (ConnectivityManager)
                    context.getSystemService(Context.CONNECTIVITY_SERVICE);
            if (cm != null) cm.unregisterNetworkCallback(networkCallback);
        } catch (Exception ignored) {}
        networkCallback = null;
    }
}
