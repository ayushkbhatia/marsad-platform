/**
 * PD.3 — a Node resolve hook that lets these `.ts` modules be imported without a build step.
 *
 * The schemas are authored in TypeScript because Zod is the source of truth, but two consumers
 * need to *run* them outside Next's bundler: the migration generator
 * (`scripts/design/generate-block-schemas.mjs`) and the test file. Node strips types natively, so
 * no compiler is needed — but its ESM resolver requires a file extension, while `tsc` under
 * `moduleResolution: bundler` rejects a literal `.ts` extension unless
 * `allowImportingTsExtensions` is on. Extensionless imports satisfy `tsc` and Next; this hook
 * satisfies Node. One 20-line shim beats a build step, a new dev dependency, or a tsconfig change.
 *
 * `module.registerHooks` is synchronous and in-thread, so importing this module is enough — but it
 * only affects imports resolved *after* it has been evaluated, which means consumers must reach
 * the schemas through a **dynamic** `import()`. A static import would be resolved during linking,
 * before this file's body runs.
 *
 *   import "./ts-resolve.mjs";                       // or "../../src/lib/blocks/schemas/ts-resolve.mjs"
 *   const schemas = await import("./index" + ".ts"); // now resolvable
 *
 * @see src/lib/data/adapters/__tests__/analysts.test.ts for the same non-literal-specifier trick.
 */
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";

registerHooks({
  resolve(specifier, context, nextResolve) {
    const isRelative = specifier.startsWith("./") || specifier.startsWith("../");
    const hasExtension = /\.[cm]?[jt]sx?$/.test(specifier);
    if (isRelative && !hasExtension && context.parentURL) {
      for (const candidate of [`${specifier}.ts`, `${specifier}/index.ts`]) {
        const url = new URL(candidate, context.parentURL);
        if (existsSync(fileURLToPath(url))) return { url: url.href, shortCircuit: true };
      }
    }
    return nextResolve(specifier, context);
  },
});
