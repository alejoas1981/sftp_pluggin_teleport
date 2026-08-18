import { expect } from 'chai';
import * as path from 'path';
import * as os from 'os';
import {
    getPlatformConfig,
    getTeleportInstallDir,
    getTshPath,
    getTeleportDownloadUrl,
} from '../teleport-installer';

describe('teleport-installer', () => {
    describe('getPlatformConfig', () => {
        it('returns correct config based on actual platform', () => {
            const config = getPlatformConfig();
            
            expect(config.os).to.be.oneOf(['windows', 'darwin', 'linux']);
            expect(config.arch).to.be.oneOf(['amd64', 'arm64', 'arm']);
            expect(config.ext).to.be.oneOf(['.exe', '']);
            
            if (os.platform() === 'win32') {
                expect(config.os).to.equal('windows');
                expect(config.ext).to.equal('.exe');
            } else if (os.platform() === 'darwin') {
                expect(config.os).to.equal('darwin');
                expect(config.ext).to.equal('');
            } else {
                expect(config.os).to.equal('linux');
                expect(config.ext).to.equal('');
            }
        });
    });

    describe('getTeleportInstallDir', () => {
        it('returns path containing teleport directory name', () => {
            const installDir = getTeleportInstallDir();
            
            expect(installDir).to.include('teleport');
            
            if (os.platform() === 'win32') {
                expect(installDir).to.include('AppData');
                expect(installDir).to.include('Local');
            } else {
                expect(installDir).to.include('.local');
                expect(installDir).to.include('share');
            }
        });
    });

    describe('getTshPath', () => {
        it('returns path with .exe extension on Windows', () => {
            const tshPath = getTshPath();
            
            if (os.platform() === 'win32') {
                expect(tshPath.endsWith('tsh.exe')).to.be.true;
            } else {
                expect(tshPath.endsWith('tsh')).to.be.true;
            }
        });

        it('uses custom install directory when provided', () => {
            const customDir = '/custom/teleport';
            const tshPath = getTshPath(customDir);
            
            expect(tshPath).to.equal(path.join(customDir, 'tsh'));
        });
    });

    describe('getTeleportDownloadUrl', () => {
        it('returns URL for default version', () => {
            const url = getTeleportDownloadUrl();
            const config = getPlatformConfig();

            expect(url).to.equal(`https://cdn.teleport.dev/teleport-v18.10.0-${config.os}-${config.arch}-bin.tar.gz`);
        });

        it('returns URL for specific version', () => {
            const url = getTeleportDownloadUrl('15.0.0');
            const config = getPlatformConfig();

            expect(url).to.equal(`https://cdn.teleport.dev/teleport-v15.0.0-${config.os}-${config.arch}-bin.tar.gz`);
        });
    });
});
