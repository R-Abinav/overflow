#!/usr/bin/env node

// Thin CLI wrapper — reuses src/index.ts's daemon (role parsing, defaults
// to 'provider', already implemented there) via tsx. No logic duplicated.

const { spawn } = require('child_process');
const path = require('path');

const daemonEntry = path.join(__dirname, '..', 'src', 'index.ts');
const tsxCli = require.resolve('tsx/cli');

const child = spawn(process.execPath, [tsxCli, daemonEntry, ...process.argv.slice(2)], {
    stdio: 'inherit',
    cwd: path.join(__dirname, '..'),
});

child.on('exit', (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 0);
});
