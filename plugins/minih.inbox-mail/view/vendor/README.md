# Vendored: DOMPurify 3.2.7

`purify.es.mjs` is the single-file ESM build of
[DOMPurify](https://github.com/cure53/DOMPurify) 3.2.7, unmodified, taken from
`https://cdn.jsdelivr.net/npm/dompurify@3.2.7/dist/purify.es.mjs`.

- SHA-256 of `purify.es.mjs`:
  `9db4ca7e34d2b2b0fd25fa0d155ec3b14f0af980d068fee4060cbe97a21775ff`
- SHA-256 of `DOMPurify-LICENSE.txt`:
  `1b02e03c3fb4f87d476c128f0eb9def1f5a1709d28b180465228bd41574623b7`
- License: Apache-2.0 OR MPL-2.0 (`DOMPurify-LICENSE.txt`, shipped unmodified).

Why vendored: the plugin ships no `node_modules`, and a message body must be
sanitized inside the panel's own renderer process, so the library travels with
the plugin and is imported as a module from this folder. Updating it means
replacing both files, re-recording both hashes here, and re-running the browser
check that asserts a hostile message is defused.

Why this file is a build artefact and not a source file: the plugin has no build
step, and the panel needs the library at runtime.
