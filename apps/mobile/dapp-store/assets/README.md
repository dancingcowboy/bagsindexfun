# Store assets

Drop your images here before publishing. None of these are committed
on purpose — replace with real PNGs locally, then publish.

Required:
  - `icon.png` — 512×512, PNG, no transparency
  - `banner.png` — 1920×1080, PNG (feature graphic)
  - `screenshots/01-home.png` … `05-deposit.png` — 1080×1920 portrait
    (or 1920×1080 landscape). At least 4, recommended 5–8.

Capture screenshots from the running app (emulator or real device):

```bash
adb shell screencap -p /sdcard/shot.png && \
  adb pull /sdcard/shot.png apps/mobile/dapp-store/assets/screenshots/01-home.png
```

Or from the BagsIndex_Play emulator we already have running.
