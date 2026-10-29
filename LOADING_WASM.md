### ⚙️ TL;DR — Serving the `.wasm` File

The core issue isn’t the library — it’s that the **`.wasm` file lives in `node_modules` and isn’t automatically served** by Next.js, Webpack, or Turbopack.
With the default loader, you just need to make sure it’s fetchable at runtime.

#### ✅ Easiest Fix

Copy the `.wasm` file once and serve it from `/public`:

```bash
cp node_modules/libpg-query/wasm/libpg-query.wasm public/
```

#### ⚠️ Why

Bundlers don’t emit `.wasm` files by default — they stay inside `node_modules`, so the runtime can’t fetch them.

#### 🧩 Workarounds

* **Next.js + Webpack:** Add a `.wasm` asset rule or use the copy method.
* **Turbopack:** Only the copy method works for now.
* **Dev mode:** Optionally use a watcher script to auto-copy on rebuilds.

#### Serving it from another URL

PostgreSQL 18 builds only (`libpg-query@pg18`, the default): `loadModule()` takes no options on 13 to 17.

Pass `locateFile` to `loadModule()` before any other call:

```ts
import { loadModule } from 'libpg-query';

await loadModule({ locateFile: (path) => `/static/${path}` });
```

#### When the host cannot fetch at all

PostgreSQL 18 builds only, as above.

Some hosts have no `fetch` for the page's own files, for example an Electron custom protocol registered without the `supportFetchAPI` privilege. Bundle the bytes of `libpg-query.wasm` with your code and instantiate the module yourself:

```ts
import { loadModule, parseSync } from 'libpg-query';

// wasmBytes: the contents of libpg-query.wasm, bundled with your code
await loadModule({
  instantiateWasm: async (imports) =>
    (await WebAssembly.instantiate(wasmBytes, imports)).instance,
});

parseSync('SELECT 1');
```

`instantiateWasm` must resolve with the `WebAssembly.Instance` (not the `{ instance, module }` pair). `locateFile` is not used when `instantiateWasm` is given. Options are only accepted by the first `loadModule()` call, before any `parse()`/`scan()`/... call. The hook runs again whenever a fresh module is needed (a failed load being retried, or a WASM call that threw), and must create a new instance from the imports it receives each time. Keep the bytes (or a compiled `WebAssembly.Module`) in memory, never the instance: an instance returned twice is rejected.
