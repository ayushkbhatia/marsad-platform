import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Standalone packages with their own toolchains (VPS worker + ingestion),
    // DB migrations, docs and captured fixtures are not part of the Next app's
    // lint surface — they are typechecked/tested in their own packages/CI jobs.
    "worker/**",
    "ingestion/**",
    "supabase/**",
    "docs/**",
    "**/fixtures/**",
  ]),
]);

export default eslintConfig;
