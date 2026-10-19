import typescriptEslint from "typescript-eslint";

export default [{
    files: ["**/*.ts"],
}, {
    plugins: {
        "@typescript-eslint": typescriptEslint.plugin,
    },

    languageOptions: {
        parser: typescriptEslint.parser,
        ecmaVersion: 2022,
        sourceType: "module",
    },

    rules: {
        "@typescript-eslint/naming-convention": ["warn", {
            selector: "import",
            format: ["camelCase", "PascalCase"],
        }],

        curly: "warn",
        eqeqeq: "warn",
        "no-throw-literal": "warn",
        semi: "warn",
        "no-var": "error",
    },
}, {
    files: ["media/**/*.js"],
    languageOptions: {
        ecmaVersion: 2022,
        sourceType: "script",
        globals: {
            acquireVsCodeApi: "readonly",
            ResizeObserver: "readonly",
            document: "readonly",
            window: "readonly",
            requestAnimationFrame: "readonly",
            setTimeout: "readonly",
            clearTimeout: "readonly",
        },
    },
    rules: {
        "no-undef": "error",
        "no-unused-vars": "error",
        "no-var": "error",
        curly: "error",
        eqeqeq: "error",
        semi: "error",
    },
}, {
    files: ["scripts/**/*.cjs"],
    languageOptions: {
        ecmaVersion: 2022,
        sourceType: "commonjs",
        globals: {
            require: "readonly",
            __dirname: "readonly",
        },
    },
    rules: {
        "no-undef": "error",
        "no-unused-vars": "error",
        "no-var": "error",
        curly: "error",
        eqeqeq: "error",
        semi: "error",
    },
}];
