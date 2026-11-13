# Tokenomics releases

Signed installers and the update feed for the **Tokenomics** desktop app: a tray / menu bar app that shows live Claude Code sessions (needs you / working / idle), context use, cost and rate limits, and lets you approve permission prompts, follow up, resume and manage background sessions.

The source is private; this repo only holds releases.

## Install

Download the latest release:

- **Windows:** `Tokenomics_<version>_x64-setup.exe` (per-user install, no admin). The installer is not code-signed, so SmartScreen may warn.
- **macOS (Apple Silicon):** `Tokenomics_<version>_aarch64.dmg`
- **macOS (Intel):** `Tokenomics_<version>_x64.dmg`

macOS builds are ad-hoc signed: on first launch, right-click the app and choose **Open**.

Installed apps update themselves from `releases/latest/download/latest.json` (signed with the app's updater key).