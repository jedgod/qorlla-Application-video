# Ringtones

## What ships

Eight ringtones for incoming calls: Classic, Soft, Chime, Marimba, Pulse, Rise, Bell, Lullaby. Each is a short pattern of notes (frequency and length) with a waveform and a loudness, written for Qorlla and
synthesized in the browser with the Web Audio API. **There are no audio files and no third-party sound material in the product**, so there is nothing to license, attribute or update.

* The catalogue is `RINGTONES` in `qorlla.html`. The Phone settings preview and the real incoming-call ring both play from it, so what you preview is what rings.
* A person chooses their tone in Phone -> Phone settings -> Audio & Devices -> Ringtone. The choice is stored with their phone settings (`ringtone`, validated against the same list in `workplace.js`,
  `PHONE_ENUMS.ringtone`) and is loaded when the page starts, so the first call after a reload already uses it.
* The caller's ringback (the soft 440 Hz tone while waiting) is unchanged.
* To add a tone: add it to `RINGTONES` **and** to `PHONE_ENUMS.ringtone`, and add its notes to `tests/ringtone.spec.js`.

## Sources that were reviewed and NOT used

| Source | Finding | Decision |
|---|---|---|
| `pattlebass/Music-DJ` (MIT) | A Godot music-making app. It contains no audio files (images, fonts and a few demo videos only), so there is no ringtone to take. | Not used. |
| `w3teal/awesome-ringtone` (CC0 for the repository) | 92 audio files: the phone makers' own tones (Samsung 46, LG 15, Xiaomi 7, Oppo 6, Vivo 6, Sony 5, Google Pixel 4, Apple 3). Its README states that copyright "is held by the brand or creator"; a CC0 notice on the repository cannot grant rights the repository does not hold. | Not shipped. Using those tones in Qorlla would need permission from each brand. |

If tones from a third party are ever added, they must come with a licence that allows redistribution in a product, and the licence text and attribution belong in this file.
