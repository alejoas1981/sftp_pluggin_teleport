import { expect } from 'chai';
import * as vscode from 'vscode';
import { buildRsyncCommand, buildFtpCommand, buildSyncCommand, validateConfig } from '../sync';
import { saveConfiguration, SftpConfig } from '../config';

const base: SftpConfig = {
    mode: 'teleport',
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

const sftpBase: SftpConfig = {
    ...base,
    mode: 'sftp',
    useTeleport: false,
};

const ftpBase: SftpConfig = {
    ...base,
    mode: 'ftp',
    ftpHost: 'ftp.example.com',
    ftpUser: 'u',
    password: 'p',
    useTeleport: false,
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

    it('uses plain ssh with identity when mode is sftp', () => {
        const cmd = buildRsyncCommand({ ...sftpBase, identity: '/keys/id' });
        expect(cmd.env.RSYNC_RSH).to.include('ssh');
        expect(cmd.env.RSYNC_RSH).to.include('/keys/id');
    });

    it('appends extra ssh flags for sftp', () => {
        const cmd = buildRsyncCommand({ ...sftpBase, identity: '/keys/id', sshFlags: '-p 2222' });
        expect(cmd.env.RSYNC_RSH).to.include('-p 2222');
    });

    it('appends extra rsync flags', () => {
        const cmd = buildRsyncCommand({ ...base, rsyncFlags: '--exclude .git --checksum' });
        expect(cmd.args).to.include('--exclude');
        expect(cmd.args).to.include('.git');
        expect(cmd.args).to.include('--checksum');
    });
});

describe('buildFtpCommand', () => {
    it('produces lftp mirror command', () => {
        const cmd = buildFtpCommand(ftpBase);
        expect(cmd.command).to.equal('lftp');
        expect(cmd.args[0]).to.equal('-c');
        expect(cmd.args[1]).to.include('mirror -R');
        expect(cmd.args[1]).to.include(ftpBase.ftpHost);
    });
});

describe('buildSyncCommand', () => {
    it('dispatches to rsync for sftp', () => {
        const cmd = buildSyncCommand(sftpBase);
        expect(cmd.command).to.equal('rsync');
    });
    it('dispatches to lftp for ftp', () => {
        const cmd = buildSyncCommand(ftpBase);
        expect(cmd.command).to.equal('lftp');
    });
});

describe('validateConfig', () => {
    it('passes with complete config', () => {
        expect(() => validateConfig(base)).to.not.throw();
        expect(() => validateConfig(sftpBase)).to.not.throw();
        expect(() => validateConfig(ftpBase)).to.not.throw();
    });

    it('throws for missing required fields', () => {
        const incomplete = { ...sftpBase, sftpHost: undefined } as unknown as SftpConfig;
        expect(() => validateConfig(incomplete)).to.throw(/sftpHost/);
    });
});

describe('saveConfiguration', () => {
    it('writes all GUI fields to global settings.json', async () => {
        const context: any = { secrets: { store: async () => undefined } };
        const config: SftpConfig = {
            mode: 'sftp',
            sftpHost: 'sftp.example.com',
            sftpUser: 'u',
            remotePath: '/home/u/project',
            localPath: '/local/project',
            identity: '~/.ssh/id',
            debounceMs: 300,
            sshFlags: '-p 2222',
            rsyncFlags: '--exclude .git',
            useTeleport: false
        };
        (vscode as any)._reset();
        await saveConfiguration(context, config);
        const updates = (vscode as any)._updates as { key: string; value: any; global: boolean }[];
        expect(updates.every(u => u.global === true)).to.be.true;
        const byKey = new Map(updates.map(u => [u.key, u.value]));
        expect(byKey.get('mode')).to.equal('sftp');
        expect(byKey.get('sftpHost')).to.equal('sftp.example.com');
        expect(byKey.get('sftpUser')).to.equal('u');
        expect(byKey.get('remotePath')).to.equal('/home/u/project');
        expect(byKey.get('localPath')).to.equal('/local/project');
        expect(byKey.get('identity')).to.equal('~/.ssh/id');
        expect(byKey.get('sshFlags')).to.equal('-p 2222');
        expect(byKey.get('rsyncFlags')).to.equal('--exclude .git');
        expect(byKey.get('debounceMs')).to.equal(300);
        expect(byKey.get('useTeleport')).to.equal(false);
    });
});
