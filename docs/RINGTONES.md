# Ringtones

## What ships

Eight ringtones for incoming calls: Classic, Soft, Chime, Marimba, Pulse, Rise, Bell, Lullaby. Each is a short pattern of notes (frequency and length) with a waveform and a loudness, written for Qorlla and
synthesized in the browser with the Web Audio API. **The eight originals use no audio files and no third-party material.** (The separate imported library is described below.)

* The catalogue is `RINGTONES` in `qorlla.html`. The Phone settings preview and the real incoming-call ring both play from it, so what you preview is what rings.
* A person chooses their tone in Phone -> Phone settings -> Audio & Devices -> Ringtone. The choice is stored with their phone settings (`ringtone`, validated against the same list in `workplace.js`,
  `PHONE_ENUMS.ringtone`) and is loaded when the page starts, so the first call after a reload already uses it.
* The caller's ringback (the soft 440 Hz tone while waiting) is unchanged.
* To add a tone: add it to `RINGTONES` **and** to `PHONE_ENUMS.ringtone`, and add its notes to `tests/ringtone.spec.js`.

## Imported library (third-party, rights NOT verified)

At the owner's request, a local folder (`ringtoneslibrary`, copies of `pattlebass/Music-DJ` and `w3teal/awesome-ringtone`) is imported by `scripts/import-ringtone-library.mjs --from "<folder>"` into
`assets/ringtones/library/`. It is shown in the picker as separate groups ("Library melodies", "Library tones") below "Qorlla originals"; the originals are untouched.

* **Library melodies (84)**: the lead line of Music-DJ's MIDI samples, converted to note patterns and played by the same synthesizer as the originals (no audio file). 44 samples without a usable melody were skipped.
* **Library tones (19)**: MP3 files from awesome-ringtone that are 450 KB or less. The other 73 (169 MB in total, mostly Samsung and LG songs) were left out so the repository and the app image stay small.
* `assets/ringtones/library/manifest.json` records the project, original path and SHA-256 of every item and marks it `"rights": "unverified"`. The server accepts a library ringtone only if its id is in that manifest.
* **Rights.** Music-DJ's code is MIT but it recreates a Sony Ericsson app and its README says it uses that app's original samples; awesome-ringtone's CC0 notice covers the repository, while its README says the
  copyright of the tones is held by the brand or creator. Nothing here proves Qorlla may redistribute this audio. **The owner accepted that risk** when asking for the import. Before a public release, either obtain
  permission, or delete `assets/ringtones/library/` (the picker then shows only the originals and nothing else breaks).

## Sources reviewed earlier

| Source | Finding |
|---|---|
| `pattlebass/Music-DJ` (MIT) | The online repository holds no audio of its own; the local copy has MIDI samples and a soundfont. Only the 128 small MIDI samples are used; the 33 MB soundfont is not. |
| `w3teal/awesome-ringtone` (CC0 for the repository) | 92 phone-maker tones; copyright stated as held by the brand or creator (see above). |

If more third-party tones are ever added, they should come with a licence that allows redistribution in a product, and the licence text and attribution belong in this file.
