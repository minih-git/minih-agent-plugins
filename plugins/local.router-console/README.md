# Router Console

A sidebar panel beside the Terminal. It asks your Minih Router who the saved
credential belongs to and opens the page that identity is allowed on:
the admin console for an admin token, the key usage page for an AccessKey.

## What it shows

- The identity behind the configured credential: administrator or access key,
  the key's name, its `prefix…suffix`, status, rate limit, and expiry.
- One primary action: open the matching page in your browser.
- Refresh, which asks the Router again instead of reusing the last answer.

## Settings

Settings → Plugins → Router Console.

| Key | Meaning |
| --- | --- |
| Control-plane address | Root of the Router, for example `https://router.example.com`. A bare host is assumed to be https; a local instance can stay on `http://127.0.0.1:3000`. |
| Credential | An AccessKey, or an admin token if you have one. |
| Open the console as soon as the panel opens | Hands the page to the browser when the panel loads. Off by default. |

## What it deliberately does not do

- **It does not embed the console in the panel.** The Router answers every page
  with `X-Frame-Options: DENY` and `frame-ancestors 'none'`, and the app's own
  Browser view only lets its own `pi.browser` plugin navigate it. A plugin panel
  that claims to embed the console would be lying; this one opens your browser.
- **It never writes to the Router.** The only control route it calls is
  `GET /api/auth/session`.
- **It does not read the AccessKey you configured elsewhere in the app.** The
  credential in these settings is the one it uses.

## Privacy

The address and credential are stored in this plugin's own settings file in
plain text on this machine, and are sent only to that address, only on the
`/api/auth/session` request. The panel never receives the credential.

## Development

```
node --test tests/*.test.mjs
```

Load it from Settings → Plugins → (development) folder: pick
`plugins/local.router-console`.
