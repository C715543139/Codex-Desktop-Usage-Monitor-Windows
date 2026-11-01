# Notices

## Private local side-chat variant

This local variant adds side-chat saving adapted from BigPizzaV3/CodexPlusPlus
v2.1.4 (save-side-chat implementation by toby1123yjh):

- https://github.com/BigPizzaV3/CodexPlusPlus/pull/2660
- `assets/inject/renderer-inject/85-side-chat-save.js`
- `crates/codex-plus-core/src/side_chat.rs`

The adapted `assets/side-chat-save.js` and `scripts/side-chat-store.mjs` are
licensed under GNU AGPL v3; its complete text is in `LICENSES/AGPL-3.0.txt`.
The repository's existing MIT license continues to describe the original monitor
code; it does not relicense these adapted files. This combined local variant is
intended for private use and must not be advertised or redistributed as wholly
MIT-licensed software. No CodexPlusPlus executable or runtime is required.

## Original monitor

Codex Usage Monitor for Windows is derivative software based on runtime-injection ideas from:

- Fei-Away/Codex-Dream-Skin: https://github.com/Fei-Away/Codex-Dream-Skin
- tree0519/Codex-Dream-Skin-Forge: https://github.com/tree0519/Codex-Dream-Skin-Forge

The distributed package contains no bundled themes, character artwork, Codex binaries, Node.js runtime, credentials, or user configuration.

Reset probability data is retrieved at runtime from the public API of the MIT-licensed open-source project Codex Reset Observatory:

- gussuri/codex-reset-observatory: https://github.com/gussuri/codex-reset-observatory

No Codex Reset Observatory source code or prediction dataset is bundled in this package.

Codex and OpenAI are trademarks of their respective owners. This project is unofficial and is not affiliated with, sponsored by, or endorsed by OpenAI.
