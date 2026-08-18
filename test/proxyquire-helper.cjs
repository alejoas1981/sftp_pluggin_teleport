const path = require('path');
const proxyquire = require('proxyquire').noPreserveCache();

require('ts-node/register');

const projectRoot = path.resolve(__dirname, '..');

function load(modulePath, stubs) {
    return proxyquire(path.join(projectRoot, modulePath), stubs);
}

exports.loadSync = (stubs) => load('src/sync.ts', stubs);
exports.loadTeleportInstaller = (stubs) => load('src/teleport-installer.ts', stubs);
exports.loadExtension = (stubs) => load('src/extension.ts', stubs);
