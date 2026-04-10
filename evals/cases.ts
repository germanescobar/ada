import type { EvalCase } from "./types.js";

export const evalCases: EvalCase[] = [
  {
    name: "hello-world",
    prompt: "Create a file called hello.js that prints 'Hello, World!' to the console.",
    verify: "node hello.js | grep -q 'Hello, World!'",
  },
  {
    name: "reverse-string",
    prompt:
      "Create a file called reverse.js that exports a function called reverseString as a named export (module.exports = { reverseString }). It should take a string and return it reversed.",
    verify: `node -e "const { reverseString } = require('./reverse.js'); const r = reverseString('abcde'); if (r !== 'edcba') { console.error('Expected edcba, got', r); process.exit(1); }"`,
  },
  {
    name: "fix-bug",
    prompt: "The file math.js has a bug. Fix it so that the add function correctly adds two numbers.",
    setupFiles: {
      "math.js": `function add(a, b) {\n  return a - b;\n}\nmodule.exports = { add };\n`,
    },
    verify: `node -e "const { add } = require('./math.js'); if (add(2, 3) !== 5) { process.exit(1); }"`,
  },
  {
    name: "fizzbuzz",
    prompt:
      "Create a file called fizzbuzz.js that exports a function fizzbuzz(n) as a named export (module.exports = { fizzbuzz }) which returns an array of strings from 1 to n following FizzBuzz rules (divisible by 3: 'Fizz', by 5: 'Buzz', both: 'FizzBuzz', otherwise the number as a string).",
    verify: `node -e "
      const { fizzbuzz } = require('./fizzbuzz.js');
      const r = fizzbuzz(15);
      if (r[0] !== '1') process.exit(1);
      if (r[2] !== 'Fizz') process.exit(1);
      if (r[4] !== 'Buzz') process.exit(1);
      if (r[14] !== 'FizzBuzz') process.exit(1);
      if (r.length !== 15) process.exit(1);
    "`,
  },
  {
    name: "json-parser",
    prompt:
      "Create a file called parse-config.js that exports a function parseConfig(filePath) as a named export (module.exports = { parseConfig }). It should read a JSON file and return the parsed object. It should throw an error with the message 'File not found' if the file doesn't exist.",
    setupFiles: {
      "test-config.json": JSON.stringify({ host: "localhost", port: 3000 }),
    },
    verify: `node -e "
      const { parseConfig } = require('./parse-config.js');
      const cfg = parseConfig('./test-config.json');
      if (cfg.host !== 'localhost' || cfg.port !== 3000) process.exit(1);
      try { parseConfig('./nope.json'); process.exit(1); } catch (e) {
        if (!e.message.includes('File not found')) process.exit(1);
      }
    "`,
  },
];
