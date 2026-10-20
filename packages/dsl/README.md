# @aflow/dsl

The typed TypeScript DSL for AFlow workflows (spec §15).

## The `aflow` command

Build the command before you use it:

```sh
npm run build -w @aflow/dsl
```

The command has two subcommands:

- `aflow types [--project <tsconfig>]` writes the schema typings of each workflow header in the project (§15.7).
  The default project is `tsconfig.json` in the current directory.
  The typings go to `.aflow/types/<client_id>.<name>.d.ts` next to the header file.
- `aflow build <entry> [-o <file>]` writes the §13 JSON of the workflow that `<entry>` assembles (§15.8).
  The JSON goes to stdout, or to `<file>` with `-o`.
  The command uses the nearest `tsconfig.json` of `<entry>`. If there is no `tsconfig.json`, it uses strict default options.
  It makes the schema typings from the schemas at each build, so you do not run `aflow types` first.

The exit code is `0` when there is no error diagnostic.
The exit code is `1` when there is an error diagnostic, a usage error or an unexpected failure.
Warnings do not change the exit code.
When `aflow build` fails, it writes no JSON.

Each diagnostic is one line on stderr, with two spaces between the fields:

```text
file:line:column  severity  rule  message
```

- `file` is relative to the current directory when the file is in that directory. Otherwise, it is absolute.
- `line` and `column` start at 1.
- `severity` is `error` or `warning`.
- `rule` is the analyzer rule, for example `unknown-task`, `outside-reference` or `type-error` (§15.4, §15.9).

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
