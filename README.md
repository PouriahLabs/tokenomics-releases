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
## Builds

The workflows in .github/workflows build the releases (and run the test suite) from the private source repo; they run only when started by hand, and their logs print no source output.


## Live-status plugin for Claude Code

Shows each Claude Code session as needs you / working / idle in the app, and lets you approve permission prompts from it. It only posts to `127.0.0.1:53821` and stays silent when the app isn't running; its hooks need `node` on PATH.

```
claude plugin install tokenomics-live --marketplace PouriahLabs/tokenomics-releases
```

(or `/plugin install tokenomics-live --marketplace PouriahLabs/tokenomics-releases` inside Claude Code). The plugin in `plugins/` is copied from the source repo by each release.
