'use strict';

// selfcheck.js -- C-1 load self-证 for the node-gyp built addon (T01).
//
// "It compiled" proves nothing. A hand-rolled `cl /LD /MD` addon also compiles and then
// makes Electron die *silently* on require(): no error, no stack, the process just
// vanishes and not even a later process.exit runs. The only evidence that the chain is
// healthy is loading the module and actually calling it, then checking the process is
// still alive afterwards.
//
// So the verdict is LOADED_AND_CALLED, never merely LOADED, and the calls are verified
// against values computed independently on the JS side:
//   * hostVersion()   must name the Electron version we are really running under
//   * probeSelf()     must carry a real D3D11 device query result and a real adapter LUID
//   * selftestCalc(n) must equal a mixer recomputed here for several seeds, so a stub
//                     returning a hardcoded number cannot pass
//
// Run (NOTE the env scrub -- see R101 section 0 N1: the ambient shell carries
// ELECTRON_RUN_AS_NODE=1, which degrades electron.exe into plain node and makes `app`
// undefined. That false red is otherwise indistinguishable from a real crash):
//
//   env -u ELECTRON_RUN_AS_NODE -u NODE_OPTIONS \
//     ./node_modules/electron/dist/electron.exe native/spike-glass/addon/selfcheck.js
//
// Last line on success:
//   VERDICT_ADDON=LOADED_AND_CALLED hostVersion=<...> probeSelf=<...> selftestCalc=<...>

const path = require('path');
const { app } = require('electron');

const ADDON_PATH = path.join(__dirname, 'build', 'Release', 'harbor_spike.node');

// Seeds are deliberately not round numbers, and there is more than one: a stubbed
// implementation would have to hardcode a whole lookup table to survive this.
const SEEDS = [1, 7, 12345, 4294967295];

function fail(reason) {
  console.log('VERDICT_ADDON=FAIL');
  console.log('FAIL_REASON=' + reason);
  try {
    app.exit(1);
  } catch (_err) {
    process.exitCode = 1;
  }
}

// Independent reimplementation of the native mixer. Kept in the JS harness on purpose:
// if it lived in the addon, the addon would be grading its own homework.
function expectedMix(seed, salt) {
  const s = seed >>> 0;
  // 2654435761 is Knuth's multiplicative constant; both sides use the same 32-bit wrap.
  const mixed = (Math.imul(s, 2654435761) + salt) >>> 0;
  const shifted = s >>> 3;
  return (mixed ^ shifted) >>> 0;
}

// Touching app.whenReady() first is deliberate: under ELECTRON_RUN_AS_NODE it throws
// "Cannot read properties of undefined (reading 'whenReady')", which is the documented
// fingerprint of N1 rather than a masked failure.
app
  .whenReady()
  .then(() => {
    console.log('ELECTRON=' + process.versions.electron);
    console.log('NODE=' + process.versions.node);
    console.log('ADDON_PATH=' + ADDON_PATH);

    let addon = null;
    try {
      addon = require(ADDON_PATH);
    } catch (err) {
      fail('require threw: ' + (err && err.message ? err.message : String(err)));
      return;
    }

    // Still alive after require()? A missing win_delay_load_hook would have killed the
    // process by now, so reaching this line is itself part of the evidence.
    console.log('SURVIVED_REQUIRE=1');
    console.log('ADDON_EXPORT=' + Object.keys(addon || {}).sort().join(','));

    for (const name of ['hostVersion', 'probeSelf', 'selftestCalc', 'selftestSalt']) {
      if (typeof addon[name] !== 'function') {
        fail(name + ' is not an exported function');
        return;
      }
    }

    // --- hostVersion: must be non-empty and must name the running Electron version ---
    const hostVersion = addon.hostVersion();
    if (typeof hostVersion !== 'string' || hostVersion.length === 0) {
      fail('hostVersion returned an empty or non-string value');
      return;
    }
    if (!hostVersion.includes(process.versions.electron)) {
      fail(
        'hostVersion does not mention the running Electron version (' +
          process.versions.electron +
          '): ' +
          hostVersion
      );
      return;
    }

    // --- probeSelf: real adapter data, not a constant string ---
    const probeSelf = addon.probeSelf();
    if (!probeSelf || typeof probeSelf !== 'object') {
      fail('probeSelf did not return an object');
      return;
    }
    if (typeof probeSelf.adapterLuid !== 'string' || probeSelf.adapterLuid.length === 0) {
      fail('probeSelf.adapterLuid is empty');
      return;
    }
    if (probeSelf.d3dHr !== 0) {
      fail('probeSelf.d3dHr is ' + probeSelf.d3dHr + ', expected 0 (device creation failed)');
      return;
    }
    if (typeof probeSelf.featureLevel !== 'number' || probeSelf.featureLevel === 0) {
      fail('probeSelf.featureLevel is not a positive number - no real D3D11 query happened');
      return;
    }

    // --- selftestCalc: recomputed here, so a hardcoded return cannot pass ---
    const salt = addon.selftestSalt();
    if (typeof salt !== 'number') {
      fail('selftestSalt did not return a number');
      return;
    }
    const mixes = [];
    for (const seed of SEEDS) {
      const got = addon.selftestCalc(seed) >>> 0;
      const want = expectedMix(seed, salt) >>> 0;
      if (got !== want) {
        fail('selftestCalc(' + seed + ') = ' + got + ', expected ' + want);
        return;
      }
      mixes.push(seed + ':' + got);
    }

    console.log('HOST_VERSION=' + hostVersion);
    console.log('PROBE_SELF=' + JSON.stringify(probeSelf));
    console.log('SELFTEST_SALT=' + salt);
    console.log('SELFTEST_MIX=' + mixes.join(','));

    console.log(
      'VERDICT_ADDON=LOADED_AND_CALLED hostVersion=' +
        hostVersion +
        ' probeSelf=' +
        JSON.stringify(probeSelf) +
        ' selftestCalc=' +
        mixes.join(';')
    );
    app.exit(0);
  })
  .catch((err) => {
    // This is the N1 path (ELECTRON_RUN_AS_NODE=1): report it verbatim, do not paper over.
    fail('whenReady rejected: ' + (err && err.message ? err.message : String(err)));
  });