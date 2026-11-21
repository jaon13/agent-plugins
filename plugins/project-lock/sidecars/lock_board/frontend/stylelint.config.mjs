export default {
  extends: ['stylelint-config-standard', 'stylelint-config-html/svelte'],
  plugins: ['stylelint-declaration-strict-value', 'stylelint-high-performance-animation'],
  ignoreFiles: ['dist/**', 'node_modules/**'],
  rules: {
    'declaration-no-important': true,
    'selector-max-id': 0,
    'selector-max-specificity': '0,3,0',
    'import-notation': null,
    'selector-pseudo-class-no-unknown': [
      true,
      {
        ignorePseudoClasses: ['global'],
      },
    ],
    'selector-class-pattern': [
      '^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$',
      {
        message: 'Expected class selector to be kebab-case',
      },
    ],
    'plugin/no-low-performance-animation-properties': [
      true,
      {
        ignore: 'paint-properties',
      },
    ],
    'scale-unlimited/declaration-strict-value': [
      ['/color$/', 'background-color', 'border-color', 'font-size', 'border-radius', 'z-index'],
      {
        ignoreValues: [
          'transparent',
          'inherit',
          'currentColor',
          'currentcolor',
          'initial',
          'unset',
          'none',
          '0',
          'auto',
        ],
        ignoreFunctions: true,
        disableFix: true,
      },
    ],
  },
  overrides: [
    {
      files: ['src/styles/tokens.css'],
      rules: {
        'scale-unlimited/declaration-strict-value': null,
      },
    },
  ],
};
