"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
Object.defineProperty(exports, "__esModule", { value: true });
const chai_1 = require("chai");
const path = __importStar(require("path"));
const os = __importStar(require("os"));
const teleport_installer_1 = require("../teleport-installer");
describe('teleport-installer', () => {
    describe('getPlatformConfig', () => {
        it('returns correct config based on actual platform', () => {
            const config = (0, teleport_installer_1.getPlatformConfig)();
            (0, chai_1.expect)(config.os).to.be.oneOf(['windows', 'darwin', 'linux']);
            (0, chai_1.expect)(config.arch).to.be.oneOf(['amd64', 'arm64', 'arm']);
            (0, chai_1.expect)(config.ext).to.be.oneOf(['.exe', '']);
            if (os.platform() === 'win32') {
                (0, chai_1.expect)(config.os).to.equal('windows');
                (0, chai_1.expect)(config.ext).to.equal('.exe');
            }
            else if (os.platform() === 'darwin') {
                (0, chai_1.expect)(config.os).to.equal('darwin');
                (0, chai_1.expect)(config.ext).to.equal('');
            }
            else {
                (0, chai_1.expect)(config.os).to.equal('linux');
                (0, chai_1.expect)(config.ext).to.equal('');
            }
        });
    });
    describe('getTeleportInstallDir', () => {
        it('returns path containing teleport directory name', () => {
            const installDir = (0, teleport_installer_1.getTeleportInstallDir)();
            (0, chai_1.expect)(installDir).to.include('teleport');
            if (os.platform() === 'win32') {
                (0, chai_1.expect)(installDir).to.include('AppData');
                (0, chai_1.expect)(installDir).to.include('Local');
            }
            else {
                (0, chai_1.expect)(installDir).to.include('.local');
                (0, chai_1.expect)(installDir).to.include('share');
            }
        });
    });
    describe('getTshPath', () => {
        it('returns path with .exe extension on Windows', () => {
            const tshPath = (0, teleport_installer_1.getTshPath)();
            if (os.platform() === 'win32') {
                (0, chai_1.expect)(tshPath.endsWith('tsh.exe')).to.be.true;
            }
            else {
                (0, chai_1.expect)(tshPath.endsWith('tsh')).to.be.true;
            }
        });
        it('uses custom install directory when provided', () => {
            const customDir = '/custom/teleport';
            const tshPath = (0, teleport_installer_1.getTshPath)(customDir);
            (0, chai_1.expect)(tshPath).to.equal(path.join(customDir, 'tsh'));
        });
    });
    describe('getTeleportDownloadUrl', () => {
        it('returns URL for default version', () => {
            const url = (0, teleport_installer_1.getTeleportDownloadUrl)();
            const config = (0, teleport_installer_1.getPlatformConfig)();
            (0, chai_1.expect)(url).to.equal(`https://cdn.teleport.dev/teleport-v18.10.0-${config.os}-${config.arch}-bin.tar.gz`);
        });
        it('returns URL for specific version', () => {
            const url = (0, teleport_installer_1.getTeleportDownloadUrl)('15.0.0');
            const config = (0, teleport_installer_1.getPlatformConfig)();
            (0, chai_1.expect)(url).to.equal(`https://cdn.teleport.dev/teleport-v15.0.0-${config.os}-${config.arch}-bin.tar.gz`);
        });
    });
});
