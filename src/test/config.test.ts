import { expect } from 'chai';
import { buildRsyncCommand, validateConfig } from '../sync';
import { SftpConfig } from '../config';

const base: SftpConfig = {
    teleportHost: 'tp.example.com',
    teleportUser: 'dev',
    teleportCluster: 'main',
    sftpHost: 'sftp.example.com',
    sftpUser: 'u',
    remotePath: '/home/u/project',
    localPath: '/local/project',
    debounceMs: 300,
    useTeleport: true,
};

describe('buildRsyncCommand', () => {
    it('produces base flags and trailing slashes', () => {
        const cmd = buildRsyncCommand(base);
        expect(cmd.command).to.equal('rsync');
        expect(cmd.args).to.include('-avz');
        expect(cmd.args).to.include('--delete');
        expect(cmd.args).to.include('/local/project/');
        expect(cmd.args).to.include('u@sftp.example.com:/home/u/project/');
    });

    it('adds dry-run flag when requested', () => {
        const cmd = buildRsyncCommand(base, { dryRun: true });
        expect(cmd.args).to.include('-n');
    });

    it('uses tsh ssh with cluster for teleport', () => {
        const cmd = buildRsyncCommand(base);
        expect(cmd.env.RSYNC_RSH).to.include('tsh ssh');
        expect(cmd.env.RSYNC_RSH).to.include('--cluster=main');
    });

    it('uses plain ssh with identity when teleport is disabled', () => {
        const cmd = buildRsyncCommand({ ...base, useTeleport: false, identity: '/keys/id' });
        expect(cmd.env.RSYNC_RSH).to.include('ssh');
        expect(cmd.env.RSYNC_RSH).to.include('/keys/id');
    });

    it('appends extra rsync flags', () => {
        const cmd = buildRsyncCommand({ ...base, rsyncFlags: '--exclude .git --checksum' });
        expect(cmd.args).to.include('--exclude');
        expect(cmd.args).to.include('.git');
        expect(cmd.args).to.include('--checksum');
    });
});

describe('validateConfig', () => {
    it('passes with complete config', () => {
        expect(() => validateConfig(base)).to.not.throw();
    });

    it('throws for missing required fields', () => {
        const incomplete = { ...base, sftpHost: undefined } as unknown as SftpConfig;
        expect(() => validateConfig(incomplete)).to.throw(/sftpHost/);
    });
});
