module.exports = {
  env: {
    browser: true,
    node: true,
    jest: true,
    es2024: true,
  },
  extends: ["eslint:recommended", "plugin:import/recommended"],
  parserOptions: {
    ecmaVersion: "latest",
    sourceType: "module",
  },
  rules: {
    "no-console": "off",
    "no-empty": "off",
    "no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
    "import/no-unresolved": "off",
  },
};
