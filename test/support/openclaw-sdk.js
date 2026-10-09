// Resolve `openclaw/plugin-sdk/<subpath>` to the shims in ./openclaw-sdk/, so the real
// plugin entry (index.js) loads without the host package. The SDK is provided by the host at
// install time (openclaw@8.2 package.json:654,1343 `exports`); only the subpaths this
// plugin imports are shimmed — any other subpath fails loudly.
import module from "node:module";

const SHIMS = new Set(["plugin-entry", "channel-core", "channel-inbound", "agent-harness-runtime", "state-paths", "health", "agent-runtime", "security-runtime"]);
let installed = false;

export function installOpenClawSdk() {
  if (installed) return;
  installed = true;
  module.registerHooks({
    resolve(specifier, context, nextResolve) {
      const prefix = "openclaw/plugin-sdk/";
      if (!specifier.startsWith(prefix)) return nextResolve(specifier, context);
      const subpath = specifier.slice(prefix.length);
      if (!SHIMS.has(subpath)) throw new Error(`fake openclaw: no shim for ${specifier}`);
      return { url: new URL(`./openclaw-sdk/${subpath}.js`, import.meta.url).href, shortCircuit: true };
    },
  });
}

/** Import the plugin entry (repo index.js) through the shims; returns its default export. */
export async function loadPluginEntry() {
  installOpenClawSdk();
  const entry = await import(new URL("../../index.js", import.meta.url).href);
  return entry.default;
}
