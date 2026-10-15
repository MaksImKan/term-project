const base = require('./jest.config');

/** @type {import('jest').Config} */
module.exports = {
  ...base,
  testMatch: undefined,
  testRegex: 'test/e2e/.*[.-]spec\\.ts$',
};
