import type { EvalCase } from './types';

export const coreCases: EvalCase[] = [
  {
    id: 'bugs-py-offbyone-en',
    mode: 'bugs',
    locale: 'en',
    category: 'core',
    code: [
      'def last_index(xs):',
      '    # returns index of last element',
      '    return len(xs)',
    ].join('\n'),
    expect: {
      plantedLines: [
        // Discriminative phrases a correct diagnosis uses — not 'len'/'index'/'-1', which the model
        // just echoes from `return len(xs)` and the `last_index` name without finding the defect.
        { line: 3, mustMentionAny: ['off-by-one', 'out of range', 'index past end', 'len(xs) - 1'] },
      ],
      minIssues: 1,
    },
  },
  {
    id: 'style-js-clean-ja',
    mode: 'style',
    locale: 'ja',
    category: 'negative',
    code: ['export const add = (a, b) => a + b;'].join('\n'),
    expect: {
      maxIssues: 1,
    },
  },
  {
    id: 'bugs-js-nullderef-ja',
    mode: 'bugs',
    locale: 'ja',
    category: 'core',
    code: [
      'function getUserName(user) {',
      '  // user might be null',
      '  return user.name.trim();',
      '}',
    ].join('\n'),
    expect: {
      // `user.name.trim()` throws when user is null/undefined. Bare 'null' echoes the `// user might
      // be null` comment, so require a phrase that names the dereference: null参照 (null reference),
      // null参照外し (null deref), nullチェック (null check), or the classic ぬるぽ.
      plantedLines: [{ line: 3, mustMentionAny: ['null参照', 'null参照外し', 'nullチェック', 'null pointer', 'ぬるぽ'] }],
      minIssues: 1,
    },
  },
  {
    id: 'security-py-sqlinjection-en',
    mode: 'security',
    locale: 'en',
    category: 'core',
    code: [
      'import sqlite3',
      '',
      'def get_user(username):',
      '    conn = sqlite3.connect("users.db")',
      '    query = f"SELECT * FROM users WHERE name = \'{username}\'"',
      '    return conn.execute(query).fetchone()',
    ].join('\n'),
    expect: {
      // The f-string interpolates `username` straight into the query. 'SQL' alone is incidental
      // (the snippet is all about SQL); require the actual diagnosis: the attack class or the fix.
      plantedLines: [{ line: 5, mustMentionAny: ['sql injection', 'parameterize', 'parameterized', 'string interpolation', 'f-string'] }],
      minIssues: 1,
    },
  },
  {
    id: 'security-js-evalinput-ja',
    mode: 'security',
    locale: 'ja',
    category: 'core',
    code: [
      'function processInput(userInput) {',
      '  // calculate expression from user',
      '  const result = eval(userInput);',
      '  return result;',
      '}',
    ].join('\n'),
    expect: {
      // `eval(userInput)` runs attacker-controlled code. Bare 'eval' just echoes the call, and
      // 'セキュリティ'/'危険' are too generic; require the named risk (arbitrary/code injection) or
      // the eval-specific warning.
      plantedLines: [{ line: 3, mustMentionAny: ['コードインジェクション', '任意のコード', 'evalは危険', 'code injection', 'arbitrary code'] }],
      minIssues: 1,
    },
  },
  {
    id: 'style-js-naming-en',
    mode: 'style',
    locale: 'en',
    category: 'core',
    code: [
      'function c(a, b, c) {',
      '  var x = a * b;',
      '  var y = x / c;',
      '  return y;',
      '}',
    ].join('\n'),
    expect: { minIssues: 1 },
  },
  {
    id: 'explain-py-basic-en',
    mode: 'explain',
    locale: 'en',
    category: 'core',
    code: [
      'def fibonacci(n):',
      '    if n <= 1:',
      '        return n',
      '    return fibonacci(n - 1) + fibonacci(n - 2)',
    ].join('\n'),
    expect: { maxIssues: 2 },
  },
  {
    id: 'explain-js-basic-ja',
    mode: 'explain',
    locale: 'ja',
    category: 'core',
    code: [
      'function binarySearch(arr, target) {',
      '  let left = 0, right = arr.length - 1;',
      '  while (left <= right) {',
      '    const mid = Math.floor((left + right) / 2);',
      '    if (arr[mid] === target) return mid;',
      '    if (arr[mid] < target) left = mid + 1;',
      '    else right = mid - 1;',
      '  }',
      '  return -1;',
      '}',
    ].join('\n'),
    expect: { maxIssues: 2 },
  },
];
