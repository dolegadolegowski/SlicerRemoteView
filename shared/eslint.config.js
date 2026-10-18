// ESLint flat config for @slicerremoteview/shared (ESLint 9+/10, typescript-eslint, Prettier last).
import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**", "coverage/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts"],
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
  {
    files: ["**/*.{js,mjs}"],
    languageOptions: { globals: { console: "readonly", process: "readonly", URL: "readonly" } },
  },
  prettier,
);
