# Changelog

## 0.1.1

- The composer control works in the real app. The host builds its API, puts it on `globalThis.pi`, and calls `onLoad()` **with no argument** (`plugin-host-process.mjs` `handleInit`; the SDK types it as `onLoad?: () => …`). 0.1.0 read that hook's parameter, so `host` stayed null in every real load: the control showed only "unavailable", no timer was ever armed, and no state file was written — while the host had recorded a successful load. The plugin now reads `globalThis.pi`, and a load without it fails loudly instead of being recorded as success.
- Unloading removes the `session:turnEnded` listener it registered. `pi.events.on` returns nothing, so 0.1.0 stored `undefined`, its `onUnload` threw (and swallowed it), and the listener outlived the load.
- An unavailable plugin now says so: the control keeps polling, puts the error code and message in its tooltip, and recovers by itself as soon as the plugin answers again. The tooltip follows the app language instead of hard-coded English.
- Tests load the plugin the way the host does — `globalThis.pi` set, `onLoad()` called with no argument — and assert the switch reaches `sessions.json`, so this cannot silently regress.
