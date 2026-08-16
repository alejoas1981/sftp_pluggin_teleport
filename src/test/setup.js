const Module = require('module');
const path = require('path');

const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
    if (request === 'vscode') {
        return path.join(__dirname, 'vscode-mock.ts');
    }
    return originalResolve.call(this, request, ...args);
};
