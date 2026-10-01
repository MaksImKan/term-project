const base = require('./jest.config');

/** @type {import('jest').Config} */
module.exports = {
  ...base,
  testMatch: undefined,
  testRegex: 'test/contract/.*provider.*[.-]spec\\.ts$',
};
