import { FlatCompat } from '@eslint/eslintrc';

const compat = new FlatCompat();

export default [
    ...compat.extends('plugin:prettier/recommended'),
    {
        languageOptions: {
            ecmaVersion: 'latest',
            sourceType: 'module',
        },
        rules: {
            'prettier/prettier': ['error'],
            'no-console': 'off',
            'import/no-extraneous-dependencies': 'off',
            'no-underscore-dangle': 'off',
            'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
            'consistent-return': 'off',
        },
        ignores: ['node_modules/', '*.json', '*.md', '*.log'],
    },
];
