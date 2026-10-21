# Vendored third-party code

MV3 extensions can't load remote scripts, so these are pinned local copies. Update only by
re-running `npm pack <pkg>@<version>` and copying the same file.

| File | Package | Version | Source file | Page global |
|---|---|---|---|---|
| fuse.min.js | fuse.js | 7.0.0 | dist/fuse.min.js (UMD) | `Fuse` |
| sql-formatter.min.js | sql-formatter | 15.8.2 | dist/sql-formatter.min.js (UMD) | `sqlFormatter` |
| js-yaml.min.js | js-yaml | 4.1.0 | dist/js-yaml.min.js (UMD) | `jsyaml` |
