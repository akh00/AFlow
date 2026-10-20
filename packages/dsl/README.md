# @aflow/dsl

The typed TypeScript DSL for AFlow workflows (spec §15).

## Editor support in Neovim

The `@aflow/ts-plugin` package is a tsserver plugin. It gives the editor behaviours of spec §15.9:

- AFlow diagnostics as you type. These are the same diagnostics that `aflow build` reports.
- Completion of task names in route targets, and of item names in `item`, `split.item_type` and `items.*.parent`.
- Hover documentation on DSL fields.
- New schema typings when a schema file changes. You do not run `aflow types` while you edit.

### 1. Build the plugin

tsserver loads the plugin from `dist/index.cjs`. Build it before you start the editor:

```sh
npm run build -w @aflow/ts-plugin
```

Build it again after you change the plugin or `@aflow/dsl`.

### 2. Enable the plugin in `tsconfig.json`

Add the plugin to the workflow project's `tsconfig.json`.
Make sure that `include` covers `.aflow/types`, because the schema typings are in that directory:

```jsonc
{
  "compilerOptions": {
    "plugins": [{ "name": "@aflow/ts-plugin" }]
  },
  "include": ["*.ts", ".aflow/types/*.d.ts"]
}
```

The plugin writes `.aflow/types/<client_id>.<name>.d.ts` next to the header file.
It writes the file again when a schema file or the inline `types` change.
tsserver then reads the new file.

### 3. Configure the language server

tsserver loads plugins from `tsconfig.json` only when it can find the plugin package.

With `vtsls`, use the TypeScript of the workspace.
That TypeScript is in the same `node_modules` as `@aflow/ts-plugin`:

```lua
vim.lsp.config("vtsls", {
  settings = {
    vtsls = { autoUseWorkspaceTsdk = true },
  },
})
```

With `ts_ls`, give the plugin location.
Replace `<repo>` with the absolute path of this repository:

```lua
vim.lsp.config("ts_ls", {
  init_options = {
    plugins = {
      { name = "@aflow/ts-plugin", location = "<repo>/node_modules/@aflow/ts-plugin" },
    },
  },
})
```

### 4. Find problems

If the AFlow diagnostics do not show, examine the tsserver log.
The log has the line `Plugin validation succeeded` when tsserver loads the plugin.
Plugin messages start with `[aflow]`.
If a plugin step fails, the plugin writes the error to the log and gives the usual TypeScript result.
