import { expect } from 'chai';
import * as vscode from 'vscode';
import { validateConfig } from '../sync';
import { saveConfiguration, initializeConfiguration, deleteConfiguration, getConfiguration, getPassword, resolveMode, SftpConfig } from '../config';

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

function privateContext() {
    const values = new Map<string, any>(), context: any = {
        workspaceState: { get: (key: string) => values.get(key),
            update: async (key: string, value: any) => { values.set(key, JSON.parse(JSON.stringify(value))); } },
        secrets: { store: async () => undefined }
    };
    return context;
}

describe('saveConfiguration', () => {
    it('stores GUI fields privately without writing workspace settings', async () => {
        const context = privateContext();
        initializeConfiguration(context);
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
        expect((vscode as any)._updates).to.have.length(0);
        expect(getConfiguration()).to.include(config);
        expect(getConfiguration()).not.to.have.property('password');

    });
});

describe('deleteConfiguration', () => {
    it('removes private mode fields without changing user-managed settings', async () => {
        const context = privateContext();
        initializeConfiguration(context);
        (vscode as any)._reset();
        await saveConfiguration(context, { ...sftpBase, ftpHost: 'keep' });
        await deleteConfiguration(context, 'sftp');
        expect((vscode as any)._updates).to.have.length(0);
        expect(getConfiguration().sftpHost).to.equal(undefined);
        expect(getConfiguration().ftpHost).to.equal('keep');
        expect(getConfiguration().mode).to.equal('ftp');
    });
});

describe('resolveMode', () => {
    it('returns explicit mode', () => {
        expect(resolveMode({ mode: 'ftp' })).to.equal('ftp');
        expect(resolveMode({ mode: 'sftp' })).to.equal('sftp');
        expect(resolveMode({ mode: 'teleport' })).to.equal('teleport');
    });

    it('defaults to teleport when not disabled', () => {
        expect(resolveMode({})).to.equal('teleport');
        expect(resolveMode({ useTeleport: true })).to.equal('teleport');
        expect(resolveMode({ useTeleport: undefined })).to.equal('teleport');
    });

    it('falls back to sftp when teleport disabled', () => {
        expect(resolveMode({ useTeleport: false })).to.equal('sftp');
    });
});

describe('getConfiguration', () => {
    it('loads resolved config from workspace settings', () => {
        initializeConfiguration(privateContext());
        const values = (vscode as any)._values;
        values['mode'] = 'ftp';
        values['ftpHost'] = 'ftp.example.com';
        values['ftpUser'] = 'u';
        values['ftpPort'] = 21;

        const config = getConfiguration();

        expect(config.mode).to.equal('ftp');
        expect(config.ftpHost).to.equal('ftp.example.com');
        expect(config.sftpPort).to.equal(22);
        expect(config.concurrency).to.equal(4);
    });
});

describe('getPassword', () => {
    it('returns stored password', async () => {
        const context: any = { secrets: { get: async (key: string) => key === 'sftpPluggin.password' ? 'secret' : undefined } };
        const password = await getPassword(context);
        expect(password).to.equal('secret');
    });

    it('returns undefined when no password stored', async () => {
        const context: any = { secrets: { get: async () => undefined } };
        const password = await getPassword(context);
        expect(password).to.be.undefined;
    });
});
