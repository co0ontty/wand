package com.wand.app;

import android.app.Activity;
import android.content.Intent;
import android.content.pm.ActivityInfo;
import android.graphics.Rect;
import android.hardware.Camera;
import android.os.Bundle;
import android.widget.TextView;

import androidx.appcompat.app.AppCompatActivity;

import com.google.android.material.button.MaterialButton;
import com.google.zxing.BarcodeFormat;
import com.google.zxing.ResultPoint;
import com.google.zxing.client.android.Intents;
import com.journeyapps.barcodescanner.BarcodeCallback;
import com.journeyapps.barcodescanner.BarcodeResult;
import com.journeyapps.barcodescanner.CameraPreview;
import com.journeyapps.barcodescanner.DecoratedBarcodeView;
import com.journeyapps.barcodescanner.DefaultDecoderFactory;
import com.journeyapps.barcodescanner.Size;
import com.journeyapps.barcodescanner.camera.CameraParametersCallback;
import com.journeyapps.barcodescanner.camera.CameraSettings;

import java.util.Collections;
import java.util.List;

public class QrScannerActivity extends AppCompatActivity {
    private DecoratedBarcodeView barcodeView;
    private MaterialButton closeButton;
    private MaterialButton torchButton;
    private TextView focusStatusText;
    private QrScannerOverlayView overlayView;

    private boolean torchOn = false;
    private boolean resultDelivered = false;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_PORTRAIT);
        setContentView(R.layout.activity_qr_scanner);

        barcodeView = findViewById(R.id.qrBarcodeView);
        closeButton = findViewById(R.id.qrCloseButton);
        torchButton = findViewById(R.id.qrTorchButton);
        focusStatusText = findViewById(R.id.qrFocusStatusText);
        overlayView = findViewById(R.id.qrOverlayView);

        setupScanner();
        setupControls();
    }

    private void setupScanner() {
        CameraSettings settings = new CameraSettings();
        settings.setAutoFocusEnabled(true);
        settings.setContinuousFocusEnabled(true);
        settings.setBarcodeSceneModeEnabled(true);
        settings.setExposureEnabled(true);
        settings.setMeteringEnabled(true);
        barcodeView.setCameraSettings(settings);
        barcodeView.getBarcodeView().setFramingRectSize(new Size(
                QrScannerOverlayView.getFrameSizePx(this),
                QrScannerOverlayView.getFrameSizePx(this)
        ));
        barcodeView.getBarcodeView().setDecoderFactory(
                new DefaultDecoderFactory(Collections.singletonList(BarcodeFormat.QR_CODE))
        );
        barcodeView.getBarcodeView().addStateListener(new CameraPreview.StateListener() {
            @Override
            public void previewSized() {
                updateOverlayFrame();
            }

            @Override
            public void previewStarted() {
                barcodeView.postDelayed(QrScannerActivity.this::refreshFocusStatus, 120);
            }

            @Override
            public void previewStopped() {
            }

            @Override
            public void cameraError(Exception error) {
            }

            @Override
            public void cameraClosed() {
            }
        });
        barcodeView.setStatusText("");
        barcodeView.decodeContinuous(new BarcodeCallback() {
            @Override
            public void barcodeResult(BarcodeResult result) {
                if (resultDelivered || result == null || result.getText() == null) {
                    return;
                }
                resultDelivered = true;
                Intent data = new Intent();
                data.putExtra(Intents.Scan.RESULT, result.getText());
                BarcodeFormat format = result.getBarcodeFormat();
                if (format != null) {
                    data.putExtra(Intents.Scan.RESULT_FORMAT, format.toString());
                }
                setResult(Activity.RESULT_OK, data);
                finish();
            }

            @Override
            public void possibleResultPoints(List<ResultPoint> resultPoints) {
            }
        });
    }

    private void setupControls() {
        closeButton.setOnClickListener(v -> {
            setResult(Activity.RESULT_CANCELED);
            finish();
        });
        torchButton.setOnClickListener(v -> toggleTorch());
        focusStatusText.setText(R.string.scan_qr_focus_starting);
    }

    private void toggleTorch() {
        torchOn = !torchOn;
        if (torchOn) {
            barcodeView.setTorchOn();
        } else {
            barcodeView.setTorchOff();
        }
        updateTorchButton();
    }

    private void updateTorchButton() {
        torchButton.setText(torchOn ? R.string.scan_qr_torch_off : R.string.scan_qr_torch_on);
        torchButton.setIconResource(torchOn ? R.drawable.ic_flash_off_24 : R.drawable.ic_flash_on_24);
    }

    private void refreshFocusStatus() {
        if (isFinishing() || isDestroyed()) {
            return;
        }
        barcodeView.changeCameraParameters(parameters -> {
            String focusMode = parameters == null ? null : parameters.getFocusMode();
            runOnUiThread(() -> {
                if (isFinishing() || isDestroyed()) {
                    return;
                }
                focusStatusText.setText(getFocusStatusText(focusMode));
            });
            return parameters;
        });
    }

    private String getFocusStatusText(String focusMode) {
        if (focusMode == null) {
            return getString(R.string.scan_qr_focus_unknown);
        }
        if (Camera.Parameters.FOCUS_MODE_CONTINUOUS_PICTURE.equals(focusMode)
                || Camera.Parameters.FOCUS_MODE_CONTINUOUS_VIDEO.equals(focusMode)) {
            return getString(R.string.scan_qr_focus_continuous);
        }
        if (Camera.Parameters.FOCUS_MODE_AUTO.equals(focusMode)
                || Camera.Parameters.FOCUS_MODE_MACRO.equals(focusMode)) {
            return getString(R.string.scan_qr_focus_periodic);
        }
        return getString(R.string.scan_qr_focus_fixed);
    }

    private void updateOverlayFrame() {
        Rect frame = barcodeView.getBarcodeView().getFramingRect();
        runOnUiThread(() -> {
            if (!isFinishing() && !isDestroyed()) {
                overlayView.setCameraFrameRect(frame);
            }
        });
    }

    @Override
    protected void onResume() {
        super.onResume();
        barcodeView.resume();
        barcodeView.postDelayed(this::refreshFocusStatus, 400);
    }

    @Override
    protected void onPause() {
        barcodeView.pause();
        super.onPause();
    }

    @Override
    public void onBackPressed() {
        setResult(Activity.RESULT_CANCELED);
        super.onBackPressed();
    }
}
