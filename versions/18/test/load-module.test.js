const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const wrapperPath = require.resolve('../wasm/index.cjs');
const gluePath = require.resolve('../wasm/libpg-query.js');
const wasmPath = path.join(path.dirname(gluePath), 'libpg-query.wasm');
const realFactory = require(gluePath);

// Initialization state is module-level, so each case loads its own copy of the
// wrapper, wired to a spy that counts calls to the Emscripten factory.
function freshLibrary() {
  const calls = [];
  require.cache[gluePath].exports = (moduleArg) => {
    calls.push(moduleArg);
    return realFactory(moduleArg);
  };
  delete require.cache[wrapperPath];
  return { lib: require(wrapperPath), calls };
}

async function instantiateFromDisk(imports) {
  const { instance } = await WebAssembly.instantiate(fs.readFileSync(wasmPath), imports);
  return instance;
}

const alreadyStarted = /initialization already started/;

describe('loadModule', { timeout: 30000 }, () => {
  it('does not initialize on import', async () => {
    const { lib, calls } = freshLibrary();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls.length, 0);
    assert.throws(() => lib.parseSync('SELECT 1'), /not initialized/);
  });

  it('initializes once for concurrent calls', async () => {
    const { lib, calls } = freshLibrary();
    await Promise.all([lib.loadModule(), lib.loadModule(), lib.parse('SELECT 1')]);
    assert.equal(calls.length, 1);
    assert.equal(lib.parseSync('SELECT 1').stmts.length, 1);
  });

  it('keeps parse() working without loadModule()', async () => {
    const { lib, calls } = freshLibrary();
    assert.equal((await lib.parse('SELECT 1')).stmts.length, 1);
    assert.equal(lib.parseSync('SELECT 2').stmts.length, 1);
    assert.equal(calls.length, 1);
  });

  it('loads from bytes through instantiateWasm', async () => {
    const { lib, calls } = freshLibrary();
    let hookCalls = 0;
    await lib.loadModule({
      instantiateWasm: (imports) => {
        hookCalls++;
        return instantiateFromDisk(imports);
      },
    });
    assert.equal(hookCalls, 1);
    assert.equal(calls.length, 1);
    assert.equal(lib.parseSync('SELECT 1').stmts.length, 1);
    assert.ok(lib.scanSync('SELECT 1').tokens.length > 0);
  });

  it('forwards locateFile to Emscripten', async () => {
    const { lib } = freshLibrary();
    const requested = [];
    await lib.loadModule({
      locateFile: (file, scriptDirectory) => {
        requested.push(file);
        return path.join(scriptDirectory, file);
      },
    });
    assert.deepEqual(requested, ['libpg-query.wasm']);
    assert.equal(lib.parseSync('SELECT 1').stmts.length, 1);
  });

  it('rejects options once an async call started initialization', async () => {
    const { lib, calls } = freshLibrary();
    const parsing = lib.parse('SELECT 1');
    await assert.rejects(lib.loadModule({ instantiateWasm: instantiateFromDisk }), alreadyStarted);
    await lib.loadModule();
    await parsing;
    assert.equal(calls.length, 1);
  });

  it('rejects options once loadModule() started initialization, even after it finished', async () => {
    const { lib, calls } = freshLibrary();
    const loading = lib.loadModule();
    await assert.rejects(lib.loadModule({ instantiateWasm: instantiateFromDisk }), alreadyStarted);
    await loading;
    await assert.rejects(lib.loadModule({ instantiateWasm: instantiateFromDisk }), alreadyStarted);
    assert.equal(calls.length, 1);
  });

  it('rejects loadModule() when instantiateWasm rejects, then retries the same hook on the next call', async () => {
    const { lib, calls } = freshLibrary();
    const failure = new Error('no bytes');
    let attempts = 0;
    const hook = async (imports) => {
      if (++attempts === 1) throw failure;
      return instantiateFromDisk(imports);
    };
    await assert.rejects(lib.loadModule({ instantiateWasm: hook }), (error) => error === failure);
    assert.throws(() => lib.parseSync('SELECT 1'), /not initialized/);
    await assert.rejects(lib.loadModule({ instantiateWasm: instantiateFromDisk }), alreadyStarted);
    await lib.loadModule();
    assert.equal(attempts, 2);
    assert.equal(calls.length, 2);
    assert.equal(lib.parseSync('SELECT 1').stmts.length, 1);
  });

  it('reuses the options when a WASM exception forces a fresh instance', async () => {
    const { lib, calls } = freshLibrary();
    let hookCalls = 0;
    await lib.loadModule({
      instantiateWasm: (imports) => {
        hookCalls++;
        return instantiateFromDisk(imports);
      },
    });
    await assert.rejects(lib.parse('SELECT 1' + '+1'.repeat(100000)));
    assert.equal((await lib.parse('SELECT 1')).stmts.length, 1);
    assert.equal(hookCalls, 2);
    assert.equal(calls.length, 2);
    assert.ok(calls.every((moduleArg) => typeof moduleArg.instantiateWasm === 'function'));
  });

  it('refuses a hook that returns the instance a WASM exception corrupted', async () => {
    const { lib, calls } = freshLibrary();
    let instance;
    await lib.loadModule({
      instantiateWasm: async (imports) => (instance ??= await instantiateFromDisk(imports)),
    });
    assert.throws(() => lib.parseSync('SELECT 1' + '+1'.repeat(100000)));
    await assert.rejects(lib.loadModule(), /new instance on each call/);
    await assert.rejects(lib.fingerprint('SELECT 1'), /new instance on each call/);
    assert.equal(calls.length, 3);
  });

  it('rejects loadModule() when instantiateWasm throws or resolves with a non-instance', async () => {
    const throwing = freshLibrary().lib;
    await assert.rejects(throwing.loadModule({ instantiateWasm: () => { throw new Error('sync'); } }), /sync/);

    const wrongShape = freshLibrary().lib;
    await assert.rejects(
      wrongShape.loadModule({
        instantiateWasm: (imports) => WebAssembly.instantiate(fs.readFileSync(wasmPath), imports),
      }),
      /must resolve with a WebAssembly.Instance/
    );
  });

  it('joins the pending initialization from re-entrant hooks', async () => {
    const joined = [];
    // Emscripten calls locateFile synchronously from the factory, instantiateWasm through our adapter.
    const viaLocateFile = freshLibrary();
    await viaLocateFile.lib.loadModule({
      locateFile: (file, scriptDirectory) => {
        joined.push(viaLocateFile.lib.loadModule());
        return path.join(scriptDirectory, file);
      },
    });
    const viaInstantiateWasm = freshLibrary();
    await viaInstantiateWasm.lib.loadModule({
      instantiateWasm: (imports) => {
        joined.push(viaInstantiateWasm.lib.loadModule());
        return instantiateFromDisk(imports);
      },
    });
    assert.equal(joined.length, 2);
    await Promise.all(joined);
    assert.equal(viaLocateFile.calls.length, 1);
    assert.equal(viaInstantiateWasm.calls.length, 1);
  });

  it('uses the options as passed, not as mutated after the call', async () => {
    const { lib } = freshLibrary();
    let passedHookCalls = 0;
    const options = {
      instantiateWasm: (imports) => {
        passedHookCalls++;
        return instantiateFromDisk(imports);
      },
    };
    const loading = lib.loadModule(options);
    options.instantiateWasm = async () => { throw new Error('mutated'); };
    await loading;
    assert.equal(passedHookCalls, 1);
  });

  it('rejects unknown keys or non-function hooks without starting initialization', async () => {
    const { lib, calls } = freshLibrary();
    await assert.rejects(
      lib.loadModule({ instantiateWasm: instantiateFromDisk, wasmBinary: new Uint8Array(0) }),
      TypeError
    );
    await assert.rejects(lib.loadModule({ instantiateWasm: 'not a function' }), TypeError);
    assert.equal(calls.length, 0);
    await lib.loadModule();
    assert.equal(calls.length, 1);
  });

  it('treats an argument that sets no hook as no options', async () => {
    const { lib, calls } = freshLibrary();
    assert.equal(lib.loadModule.length, 0);
    assert.match(String(lib.loadModule), /^[^(]*\(\)/);
    await lib.loadModule('ready');
    await Promise.all([lib.loadModule(null), lib.loadModule({}), lib.loadModule({ unrelated: true })]);
    assert.equal(calls.length, 1);
  });

  describe('passed by reference to test hooks', () => {
    const { lib, calls } = freshLibrary();
    for (const name of ['first suite', 'second suite']) {
      describe(name, () => {
        before(lib.loadModule);
        it('can parse synchronously', () => {
          assert.equal(lib.parseSync('SELECT 1').stmts.length, 1);
          assert.equal(calls.length, 1);
        });
      });
    }
  });

  it('joins from a getter that calls loadModule() while the options are read', async () => {
    const { lib, calls } = freshLibrary();
    let joined;
    const loading = lib.loadModule({
      get instantiateWasm() {
        joined = lib.loadModule();
        return instantiateFromDisk;
      },
    });
    await assert.rejects(loading, alreadyStarted);
    await joined;
    assert.equal(calls.length, 1);
  });

  it('reads hooks defined on a prototype', async () => {
    const { lib } = freshLibrary();
    let hookCalls = 0;
    class Options {
      instantiateWasm(imports) {
        hookCalls++;
        return instantiateFromDisk(imports);
      }
    }
    await lib.loadModule(new Options());
    assert.equal(hookCalls, 1);
  });
});
