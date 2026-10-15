const base = require('./jest.config');

/**
 * Єдиний конфіг, що СКАСОВУЄ testPathIgnorePatterns базового: там
 * provider-верифікація виключена зі спільного `npm test` навмисно (див.
 * коментар у jest.config.js), а тут вона — єдине, що треба запустити.
 */
/** @type {import('jest').Config} */
module.exports = {
  ...base,
  testMatch: undefined,
  testPathIgnorePatterns: ['/node_modules/'],
  testRegex: 'test/contract/.*provider.*[.-]spec\\.ts$',
};
