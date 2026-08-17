import { expect } from 'chai';
import * as vscode from 'vscode';
import { validateConfig } from '../sync';
import { saveConfiguration, deleteConfiguration, SftpConfig } from '../config';

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
    it('writes all GUI fields to workspace settings.json', async () => {
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
        expect(updates.every(u => u.global === false)).to.be.true;
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

describe('deleteConfiguration', () => {
    it('removes only the selected mode settings', async () => {
        const context: any = { secrets: { delete: async () => undefined } };
        (vscode as any)._reset();
        await deleteConfiguration(context, 'sftp');
        const updates = (vscode as any)._updates as { key: string; value: any; global: boolean }[];
        expect(updates.every(u => u.global === false && u.value === undefined)).to.be.true;
        const keys = new Set(updates.map(u => u.key));
        expect(keys.has('sftpHost')).to.be.true;
        expect(keys.has('useRsync')).to.be.true;
        expect(keys.has('ftpHost')).to.be.false;
    });
});
