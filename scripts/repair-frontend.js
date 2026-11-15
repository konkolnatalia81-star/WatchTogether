'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const frontendPath = path.join(root, 'public', 'app.js');
const serverPath = path.join(root, 'server.js');
let frontend = fs.readFileSync(frontendPath, 'utf8');

// A dangling `async` before this declaration makes the entire browser bundle fail
// to parse, so none of the room UI handlers are registered. Repair that exact
// accidental line break and keep this step idempotent for subsequent starts.
const brokenArchiveDeclaration = /\basync[ \t]*\r?\n[ \t]*let[ \t]+archivePage[ \t]*=/;
if (brokenArchiveDeclaration.test(frontend)) {
  frontend = frontend.replace(brokenArchiveDeclaration, 'let archivePage=');
  fs.writeFileSync(frontendPath, frontend);
  console.log('Repaired malformed archive declaration in public/app.js');
}

// Fail fast during both local development and deployment if either entry point
// contains a JavaScript syntax error. Parsing does not execute browser code.
for (const file of [serverPath, frontendPath]) {
  try {
    new vm.Script(fs.readFileSync(file, 'utf8'), { filename: path.relative(root, file) });
  } catch (error) {
    console.error(`Syntax check failed for ${path.relative(root, file)}: ${error.message}`);
    process.exitCode = 1;
    break;
  }
}
if (!process.exitCode) console.log('JavaScript syntax checks passed.');
