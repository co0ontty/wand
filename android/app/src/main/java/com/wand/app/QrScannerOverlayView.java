package com.wand.app;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.PorterDuff;
import android.graphics.PorterDuffXfermode;
import android.graphics.Rect;
import android.graphics.RectF;
import android.util.AttributeSet;
import android.view.View;

public class QrScannerOverlayView extends View {
    private static final int MASK_COLOR = 0x99000000;
    private static final int FRAME_COLOR = 0xFFFFFFFF;
    private static final int ACCENT_COLOR = 0xFFD97A4F;
    private static final float FRAME_WIDTH_DP = 2.5f;
    private static final float CORNER_WIDTH_DP = 5f;
    private static final float CORNER_LENGTH_DP = 30f;
    private static final float CORNER_RADIUS_DP = 24f;
    private static final float SCAN_LINE_HEIGHT_DP = 3f;

    private final Paint maskPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint framePaint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint cornerPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint scanLinePaint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint clearPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final RectF frameRect = new RectF();
    private final Path framePath = new Path();
    private Rect cameraFrameRect;

    public QrScannerOverlayView(Context context) {
        super(context);
        init();
    }

    public QrScannerOverlayView(Context context, AttributeSet attrs) {
        super(context, attrs);
        init();
    }

    public QrScannerOverlayView(Context context, AttributeSet attrs, int defStyleAttr) {
        super(context, attrs, defStyleAttr);
        init();
    }

    private void init() {
        setLayerType(LAYER_TYPE_SOFTWARE, null);
        maskPaint.setColor(MASK_COLOR);
        framePaint.setStyle(Paint.Style.STROKE);
        framePaint.setStrokeWidth(dp(FRAME_WIDTH_DP));
        framePaint.setColor(FRAME_COLOR);
        framePaint.setAlpha(170);
        cornerPaint.setStyle(Paint.Style.STROKE);
        cornerPaint.setStrokeCap(Paint.Cap.ROUND);
        cornerPaint.setStrokeJoin(Paint.Join.ROUND);
        cornerPaint.setStrokeWidth(dp(CORNER_WIDTH_DP));
        cornerPaint.setColor(ACCENT_COLOR);
        scanLinePaint.setStyle(Paint.Style.FILL);
        scanLinePaint.setColor(ACCENT_COLOR);
        scanLinePaint.setShadowLayer(dp(10), 0, 0, ACCENT_COLOR);
        clearPaint.setColor(Color.TRANSPARENT);
        clearPaint.setXfermode(new PorterDuffXfermode(PorterDuff.Mode.CLEAR));
    }

    public static int getFrameSizePx(Context context) {
        float density = context.getResources().getDisplayMetrics().density;
        int width = context.getResources().getDisplayMetrics().widthPixels;
        int height = context.getResources().getDisplayMetrics().heightPixels;
        int minSide = Math.min(width, height);
        int frame = (int) (minSide * 0.72f);
        int min = Math.round(236f * density);
        int max = Math.round(320f * density);
        return Math.max(min, Math.min(frame, max));
    }

    public void setCameraFrameRect(Rect rect) {
        if (rect == null) {
            cameraFrameRect = null;
        } else {
            cameraFrameRect = new Rect(rect);
        }
        invalidate();
    }

    @Override
    protected void onDraw(Canvas canvas) {
        super.onDraw(canvas);
        int width = getWidth();
        int height = getHeight();
        if (width <= 0 || height <= 0) {
            return;
        }

        if (cameraFrameRect != null && !cameraFrameRect.isEmpty()) {
            frameRect.set(cameraFrameRect);
        } else {
            float frameSize = Math.min(getFrameSizePx(getContext()), Math.min(width, height) - dp(48));
            float top = (height - frameSize) / 2f;
            float left = (width - frameSize) / 2f;
            frameRect.set(left, top, left + frameSize, top + frameSize);
        }

        int checkpoint = canvas.saveLayer(0, 0, width, height, null);
        canvas.drawRect(0, 0, width, height, maskPaint);
        float radius = dp(CORNER_RADIUS_DP);
        framePath.reset();
        framePath.addRoundRect(frameRect, radius, radius, Path.Direction.CW);
        canvas.drawPath(framePath, clearPaint);
        canvas.restoreToCount(checkpoint);

        canvas.drawRoundRect(frameRect, radius, radius, framePaint);
        drawCorners(canvas);
        drawScanLine(canvas);
    }

    private void drawCorners(Canvas canvas) {
        float length = dp(CORNER_LENGTH_DP);
        float radius = dp(CORNER_RADIUS_DP);
        float left = frameRect.left;
        float top = frameRect.top;
        float right = frameRect.right;
        float bottom = frameRect.bottom;

        Path path = new Path();

        path.moveTo(left + length, top);
        path.lineTo(left + radius, top);
        path.quadTo(left, top, left, top + radius);
        path.lineTo(left, top + length);

        path.moveTo(right - length, top);
        path.lineTo(right - radius, top);
        path.quadTo(right, top, right, top + radius);
        path.lineTo(right, top + length);

        path.moveTo(left + length, bottom);
        path.lineTo(left + radius, bottom);
        path.quadTo(left, bottom, left, bottom - radius);
        path.lineTo(left, bottom - length);

        path.moveTo(right - length, bottom);
        path.lineTo(right - radius, bottom);
        path.quadTo(right, bottom, right, bottom - radius);
        path.lineTo(right, bottom - length);

        canvas.drawPath(path, cornerPaint);
    }

    private void drawScanLine(Canvas canvas) {
        float progress = (System.currentTimeMillis() % 1800L) / 1800f;
        float y = frameRect.top + dp(26) + (frameRect.height() - dp(52)) * progress;
        float inset = dp(22);
        RectF line = new RectF(
                frameRect.left + inset,
                y - dp(SCAN_LINE_HEIGHT_DP) / 2f,
                frameRect.right - inset,
                y + dp(SCAN_LINE_HEIGHT_DP) / 2f
        );
        canvas.drawRoundRect(line, dp(999), dp(999), scanLinePaint);
        postInvalidateDelayed(16);
    }

    private float dp(float value) {
        return value * getResources().getDisplayMetrics().density;
    }
}
