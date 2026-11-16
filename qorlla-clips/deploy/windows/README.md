# Windows dev helpers (copies of the scripts kept in C:\Users\cj_wo\Qorlla-Desktop)

- `Start-Clips.ps1`: starts the Clips API (:5400) and web app (:3410, built with `CLIPS_BASE_PATH=/clips`) detached from any terminal. Only starts what is not listening. The proxy's optional `clips.conf` forwards `/clips` to :3410; without these two processes `/clips` answers 502.
- `Launch-Qorlla.ps1`: opens the desktop app and calls `Start-Clips.ps1`.

Paths are specific to the development machine; adjust `$root` / `$app` before reuse.
