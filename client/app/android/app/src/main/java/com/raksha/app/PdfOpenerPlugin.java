package com.raksha.app;

import android.content.ContentValues;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;

import androidx.core.content.FileProvider;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;

/**
 * PdfOpenerPlugin — saves base64 PDF bytes to the device Downloads folder
 * via MediaStore (API 29+) or the legacy Downloads directory (API 28-),
 * then fires ACTION_VIEW to open it.
 *
 * MediaStore.Downloads.EXTERNAL_CONTENT_URI requires no runtime permission
 * on API 29+ — the app can write its own files to Downloads freely.
 */
@CapacitorPlugin(name = "PdfOpener")
public class PdfOpenerPlugin extends Plugin {

    @PluginMethod
    public void open(PluginCall call) {
        String base64 = call.getString("base64");
        String filename = call.getString("filename", "raksha-export.pdf");

        if (base64 == null || base64.isEmpty()) {
            call.reject("Missing base64 parameter");
            return;
        }

        try {
            byte[] pdfBytes = Base64.decode(base64, Base64.DEFAULT);
            Uri savedUri;

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                // API 29+ (Android 10+): MediaStore — no permission needed
                ContentValues values = new ContentValues();
                values.put(MediaStore.Downloads.DISPLAY_NAME, filename);
                values.put(MediaStore.Downloads.MIME_TYPE, "application/pdf");
                values.put(MediaStore.Downloads.IS_PENDING, 1);

                android.content.ContentResolver resolver = getContext().getContentResolver();
                savedUri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);

                if (savedUri == null) {
                    call.reject("Could not create file in Downloads");
                    return;
                }

                try (OutputStream os = resolver.openOutputStream(savedUri)) {
                    if (os == null) throw new Exception("Could not open output stream");
                    os.write(pdfBytes);
                }

                values.clear();
                values.put(MediaStore.Downloads.IS_PENDING, 0);
                resolver.update(savedUri, values, null, null);

            } else {
                // API 28 and below — write to public Downloads directory
                File downloadsDir = Environment.getExternalStoragePublicDirectory(
                    Environment.DIRECTORY_DOWNLOADS);
                if (!downloadsDir.exists()) downloadsDir.mkdirs();
                File pdfFile = new File(downloadsDir, filename);
                try (FileOutputStream fos = new FileOutputStream(pdfFile)) {
                    fos.write(pdfBytes);
                }
                savedUri = FileProvider.getUriForFile(
                    getContext(),
                    getContext().getPackageName() + ".fileprovider",
                    pdfFile
                );
            }

            // Open the saved file with any available viewer
            Intent intent = new Intent(Intent.ACTION_VIEW);
            intent.setDataAndType(savedUri, "application/pdf");
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);

            Intent chooser = Intent.createChooser(intent, "Open Legal Export PDF");
            chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(chooser);

            call.resolve();

        } catch (android.content.ActivityNotFoundException e) {
            // File was saved to Downloads even if no viewer is available
            call.reject("PDF saved to Downloads folder. Install a PDF viewer to open it.");
        } catch (Exception e) {
            call.reject("Failed to save PDF: " + e.getMessage());
        }
    }
}
