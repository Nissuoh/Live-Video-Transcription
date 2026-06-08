# Chrome Web Store Assets

Upload-ready files:

- `icons/icon-128.png`: 128 x 128 PNG extension icon.
- `screenshots/de/01-youtube-translation-workflow-1280x800.jpg`: German localized screenshot, 1280 x 800 JPEG, no alpha.
- `screenshots/en/01-youtube-translation-workflow-1280x800.jpg`: English localized screenshot, 1280 x 800 JPEG, no alpha.
- `upload-ready/screenshot-de-1280x800-24bit.png`: German localized screenshot, 1280 x 800, 24-bit PNG, no alpha.
- `upload-ready/screenshot-en-1280x800-24bit.png`: English localized screenshot, 1280 x 800, 24-bit PNG, no alpha.
- `upload-ready/screenshot-de-640x400-24bit.png`: German localized screenshot, 640 x 400, 24-bit PNG, no alpha.
- `upload-ready/screenshot-en-640x400-24bit.png`: English localized screenshot, 640 x 400, 24-bit PNG, no alpha.

The screenshot limit is five per localized listing. This directory currently provides one screenshot per supported listing locale.

If Chrome Web Store reports "image size is wrong", upload one of the `upload-ready/*-24bit.png` screenshot files first. Do not upload the icon file into a screenshot field.

The preview source is in `preview/store-screenshot.html`. It is only used to regenerate store screenshots and is not included in the extension package.
