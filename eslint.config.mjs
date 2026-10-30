import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import next from "@next/eslint-plugin-next";
import reactHooks from "eslint-plugin-react-hooks";
import { fileURLToPath } from "node:url";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/coverage/**",
      ".tmp/**",
      "apps/web/.next/**",
      "apps/web/next-env.d.ts",
      "**/playwright-report/**",
      "**/test-results/**",
      "**/.data/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    plugins: { "@next/next": next },
    settings: {
      next: { rootDir: fileURLToPath(new URL("./apps/web/", import.meta.url)) },
    },
  },
  {
    files: ["**/*.{js,mjs,cjs,ts,tsx}"],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
  },
  {
    files: ["apps/web/**/*.{ts,tsx,js,jsx}"],
    plugins: {
      "react-hooks": reactHooks,
    },
    rules: {
      ...next.configs.recommended.rules,
      ...next.configs["core-web-vitals"].rules,
      ...reactHooks.configs.recommended.rules,
    },
  },
);
