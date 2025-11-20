# M3U8 Catcher

This Chrome extension detects `.m3u8` HLS playlist requests as you browse, keeps a history of the most recent captures, and forwards them to your existing Windows downloader via Chrome Native Messaging.

## Features

- Watches network traffic for `.m3u8` URLs (XHR, media, and other requests).
- Listens to `<video>` elements so sources discovered during playback are caught even if network requests are hidden.
- Remembers the last 100 captures with timestamp, tab title, originating page, and preview image where available.
- Optional desktop notifications whenever a stream is detected.
- Popup UI (dark theme) to review captured links, resend/download, or copy the URL.
- Options page to tweak the native host name, notifications, and retention duration.

## Installation (Chrome / Edge)

1. Clone or download this folder onto your machine.
2. Open `chrome://extensions/` (or `edge://extensions/`) and enable **Developer mode**.
3. Click **Load unpacked** and select the directory containing this project.
4. Pin the extension to your toolbar for easy access.

> **Note**: The extension uses the Native Messaging API, so it will only send links when the companion Windows app is installed and registered (see below).

## Configure the native messaging bridge on Windows

Chrome communicates with desktop applications through a _native messaging host_. You must register your existing downloader app so Chrome can hand off the captured URLs.

### 1. Create a host manifest

Save the JSON below as `C:\Program Files\M3U8Downloader\m3u8_host.json` (adjust the path as needed). Update the `path` field to point to your downloader executable.

```json
{
  "name": "com.example.m3u8downloader",
  "description": "Receives M3U8 URLs from the M3U8 Catcher extension",
  "path": "C:\\Program Files\\M3U8Downloader\\M3U8Downloader.exe",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://REPLACE_WITH_EXTENSION_ID/"]
}
```

You can find the extension ID on the `chrome://extensions/` page after loading the unpacked extension.

### 2. Register the manifest in the Windows registry

Create a `.reg` file (for example `install_host.reg`) with the contents below. Double-click it to add the keys. Be sure to update the manifest path to where you saved the JSON file.

```reg
Windows Registry Editor Version 5.00

[HKEY_CURRENT_USER\Software\Google\Chrome\NativeMessagingHosts\com.example.m3u8downloader]
@="C:\\Program Files\\M3U8Downloader\\m3u8_host.json"
```

If you need the host available for every user, create the key under `HKEY_LOCAL_MACHINE` instead.

### 3. Handle incoming messages in your C# app

The native host receives JSON messages on `stdin` and must respond on `stdout`. A message from the extension looks like:

```json
{
  "url": "https://cdn.example.com/video/master.m3u8",
  "tabTitle": "Live stream",
  "pageUrl": "https://site.example.com/watch",
  "detectedAt": 1700000000000,
  "previewImage": "https://cdn.example.com/thumbs/live-stream.jpg"
}
```

Here is a minimal C# host loop you can integrate into your downloader (or bridge) application:

```csharp
using System;
using System.Buffers.Binary;
using System.IO;
using System.Text.Json;

class Program
{
    static void Main()
    {
        var stdin = Console.OpenStandardInput();
        var stdout = Console.OpenStandardOutput();

        while (true)
        {
            Span<byte> lengthBuffer = stackalloc byte[4];
            if (stdin.Read(lengthBuffer) != 4)
            {
                break; // Chrome closed the pipe
            }

            int messageLength = BinaryPrimitives.ReadInt32LittleEndian(lengthBuffer);
            byte[] messageBuffer = new byte[messageLength];
            int read = 0;
            while (read < messageLength)
            {
                int chunk = stdin.Read(messageBuffer, read, messageLength - read);
                if (chunk <= 0)
                {
                    return;
                }
                read += chunk;
            }

            var payload = JsonSerializer.Deserialize<M3u8Payload>(messageBuffer);
            if (payload != null)
            {
                // TODO: Pass the URL to your existing download/convert routine.
                Console.Error.WriteLine($"Received {payload.Url} from {payload.PageUrl}");
            }

            // Respond with a success acknowledgement (optional)
            var response = JsonSerializer.SerializeToUtf8Bytes(new { ok = true });
            Span<byte> responseLength = stackalloc byte[4];
            BinaryPrimitives.WriteInt32LittleEndian(responseLength, response.Length);
            stdout.Write(responseLength);
            stdout.Write(response);
            stdout.Flush();
        }
    }
}

public record M3u8Payload(string Url, string? TabTitle, string? PageUrl, long DetectedAt);
```

Tie the `payload.Url` into whatever logic you already use to download the stream and convert it to MP4.

## Extension settings

The extension uses the native host name `com.example.m3u8downloader` by default. Make sure this matches the name in your Windows registry manifest. Captured links are stored up to a maximum of 100 entries.

## Development notes

- Icons are generated placeholders; feel free to replace the PNGs in `assets/` with your branding.
- The background service worker stores up to the latest 100 links in `chrome.storage.local` so they survive browser restarts.
- Captured links automatically expire after the configured retention window (24 hours by default).
- When the same URL is detected again, it simply bumps to the top of the list so the most recent capture is always front and center (even if the query parameters arrive in a different order).
- A lightweight content script attaches to `<video>` tags to surface `.m3u8` sources when playback begins, complementing the network listener.

## Testing tips

1. Load the extension in Chrome and open the popup—it should say _No links detected yet_.
2. Browse to a page with an HLS stream and start playback (skip ads if needed). The extension captures the `.m3u8` source when the request fires or when the player begins streaming and, if enabled, shows a notification.
3. Verify that your Windows downloader receives the JSON payload and starts the conversion.

Happy downloading! 🎬
