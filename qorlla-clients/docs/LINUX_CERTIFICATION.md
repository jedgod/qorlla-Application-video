# Physical Linux certification: Ubuntu 24.04 and Ubuntu 22.04 (Debian package)

**Status: NOT STARTED on physical hardware.** This document is the procedure and the evidence rules. Release stays BLOCKED; a passing evidence file certifies that one machine passed these tests, nothing more.

## What is already established, and what is not
| Established (CI, not hardware) | Not established |
|---|---|
| Reference: CI run 9, commit `424795318815f4ad565c6fe6fb98674428f8b7c0` (the **validated CI reference**; do not rewrite it). On a GitHub-hosted Ubuntu 24.04 runner the deb installs, its AppArmor profile is loaded and attached to the running process, the app starts as a normal user with a window, the renderer runs under seccomp with no-new-privs, a loopback WebRTC call with generated media works, the app refuses to start without the profile (fail closed), and upgrade, remove and purge are clean. | Real hardware; a real camera, microphone, speakers and screen sharing; a meeting through the Qorlla service; cross-network TURN; reconnect behaviour; Ubuntu 22.04 on its real kernel; other distributions; any user's desktop environment (Wayland and X11 differences, GPU drivers). |

The AppArmor profile only permits user namespaces for `/opt/Qorlla/qorlla`; it does **not** confine files or the network. The **AppImage is NOT DISTRIBUTABLE** (secure launch not established) and is out of scope here; it must not be tested on these machines as a substitute.

## Prerequisites
1. **One physical machine per Ubuntu version** (24.04 and 22.04), x86_64, with a real webcam, microphone and speakers. A virtual machine, container or WSL is refused by the validator.
2. **A second device on a different network** (for example a phone on cellular) for the TURN relay test.
3. **Staging services** for tests T07 to T10: HTTPS/WSS origins for the application and Meet, and a TURN relay reachable from both networks (`qorlla-clients/deployment/staging/`). **These are not provisioned yet, so T07 to T10 cannot be run; the evidence stays INCOMPLETE until they are.** T01 to T06, T11 to T14 can be run now against a locally reachable setup only if the tester records exactly what was used.
4. **The package under test: a private, recorded build, not the CI one.** The repository is public, so CI publishes no installers, and a privately rebuilt package is **not** byte-identical to the CI package. So the CI hash must never be used to check a tester's file. Instead the release engineer builds **one** package from **one exact commit** with `node qorlla-clients/tools/build-test-package.cjs <commit> --out <private directory outside the repository> --record qorlla-clients/docs/linux-certification/test-package-record.json`. The tool builds from `git archive` of that commit (never a working tree) in a container pinned by image digest, runs the desktop tests, the sandbox regression check and the release-safety check against the package it built, and refuses to record a package that fails any of them. The **record** states the source commit, the toolchain (image digest, Node, npm, Electron, electron-builder, lockfile hash), the package's own SHA-256 and size, and the verification results (chrome-sandbox 0755 and not setuid, AppArmor profile 0644, desktop entry without any sandbox-disabling switch). It starts as **"NOT yet approved"**: a named person sets `approvedBy` after reviewing it, and testers use the package only after that. The one file is then handed to every tester through a controlled channel (never committed or uploaded). The validator compares each tester's installed package with the **record's** hash (`--package-record`).

## Procedure
Run these as the **normal user** (not root), on a fresh desktop session.

| Test | What to do | Pass when |
|---|---|---|
| T01 | `sudo apt install ./qorlla-<version>-amd64.deb`; compute `sha256sum` | the hash equals the recorded one; install succeeds; on 24.04 it prints `AppArmor profile loaded` |
| T02 | start Qorlla from the application menu, then from a terminal (`qorlla`) | a window appears and stays up; no `--no-sandbox` appears in the command line of any Qorlla process (check with `ps aux`) |
| T03 | join a meeting with the real webcam | the camera is listed, self-view is live, another participant sees the video |
| T04 | speak | another participant hears; the level indicator moves |
| T05 | listen; change volume and the output device | the person hears the other participant; device switching works |
| T06 | start and stop screen sharing | Qorlla asks the person to confirm; another participant sees the correct screen; stopping works |
| T07 | against staging: create a meeting, join as a second participant, exchange audio and video, leave, end | every step works; no error dialogs |
| T08 | interrupt the network for about 10 s and restore | media recovers; record the recovery time in the note |
| T09 | normal connection | record the selected candidate pair type and that audio and video flow both ways |
| T10 | this machine and a second device on a different network, **relay-only** policy | the selected pair is `relay` on both sides and audio and video flow both ways; a direct connection does not count |
| T11 | `sudo dpkg -i` the same package over the running installation, then restart | the profile stays loaded (24.04) and Qorlla starts again |
| T12 | `sudo apt remove qorlla`, then reinstall and `sudo apt purge qorlla` | the application, the launcher entry and `/etc/apparmor.d/qorlla` are gone; the profile is no longer loaded |
| T13 | open `qorlla://join?meeting=<11 digits>` from a browser and from a terminal | the pre-join page opens in Qorlla; a link with extra parameters or a path is ignored |
| T14 | run the collector (below) while Qorlla is running | the process security state is recorded and valid |

**Ubuntu 22.04 is tested for what it really does.** Do not copy results from 24.04. Record `kernel.apparmor_restrict_unprivileged_userns` and whether a normal user can create a user namespace (the collector does). If a normal user cannot, the sandbox cannot work there without extra configuration, and that is a finding to report, not something to work around by disabling the sandbox or changing host-wide settings.

## Collecting and validating the evidence
While Qorlla is running (started by the normal user):
```
sudo python3 qorlla-clients/tools/linux-collect-evidence.py --label ubuntu-24.04-a \
     --deb ./qorlla-<version>-amd64.deb --expect-sha256 <the package.sha256 from the approved package record> --out evidence-ubuntu-24.04-a.json
```
The label must look like `ubuntu-24.04-a` (the OS version and one short letter or number: never a name or a place).
(`sudo` lets it read which AppArmor profiles the kernel has loaded; without it that field is `unknown` and the evidence stays INCOMPLETE on a 24.04-style host.) Then edit the file: for each test set `status` to `pass`, `fail` or `not_applicable` and write a `note` saying what was done and what was observed (at least 15 characters). Re-running the collector keeps your results and refreshes the measurements. Validate:
```
node qorlla-clients/e2e/linux-evidence-check.cjs evidence-ubuntu-24.04-a.json \
     --package-record qorlla-clients/docs/linux-certification/test-package-record.json
```
Exit 0 = PASS, 3 = INCOMPLETE, 1 = FAIL or invalid. With `--package-record` the validator also checks the record itself (full source commit, fully recorded toolchain, verification results, sandbox policy) and reports INCOMPLETE until its `approvedBy` is set. It refuses evidence that is not from a physical machine, not Ubuntu 22.04 or 24.04 on x86_64, not for the exact package recorded, shows a setuid `chrome-sandbox`, a sandbox-disabling switch, Qorlla running as root, no seccomp-filtered process, no profile on a host that restricts user namespaces, a host whose protection was weakened, or any identifying data.

## Evidence rules
- Record: machine specification (CPU model, memory, GPU model), OS and kernel, package SHA-256, the process security state, test outcomes, and sanitized diagnostics.
- **Never record:** host names, user names, IP or MAC addresses, serial numbers, the machine id, home-directory paths, meeting or participant ids, tokens, passwords, TURN credentials, or screenshots, recordings or camera images of people. The collector does not read them and the validator rejects them.
- **What the collector writes was checked against its real output, not only its field list.** Run in a container with a deliberately identifying setup (a host name, a user name, a machine id and a fake Qorlla process whose command line held a home path, a token and a meeting id), the output contained none of them. Process records hold only booleans and kernel security states (seccomp, no-new-privs, the AppArmor label, "runs as root", "same user as the main process", "has a sandbox-disabling switch"): never a command line, argument, path, pid or uid number. The validator also rejects serial numbers, long hexadecimal identifiers and long opaque strings.
- **Free-text notes are the remaining risk.** No pattern can catch a name or a place written into a note ("tested on Dana's laptop"). Testers write notes about what was done and observed, not who or where, and a **second person reviews every evidence file before it is stored**.
- Do not change `kernel.apparmor_restrict_unprivileged_userns`, disable AppArmor, run with `--no-sandbox` or make `chrome-sandbox` setuid to get a test to pass; such evidence is invalid by design.
- Keep the evidence files with the package SHA-256, the commit SHA and the date. Do not publish installers.

## Roll-up
Linux deb certification needs a PASS evidence file for **each** of Ubuntu 24.04 and Ubuntu 22.04 on physical hardware, with T07 to T10 run against the staging services. Until then the Linux deb is "CI-validated for the sandbox integration on a hosted Ubuntu 24.04 runner" and nothing more. All 15 production release gates remain BLOCKED.
