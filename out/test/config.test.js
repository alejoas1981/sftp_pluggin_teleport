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
const vscode = __importStar(require("vscode"));
const sync_1 = require("../sync");
const config_1 = require("../config");
const base = {
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
const sftpBase = {
    ...base,
    mode: 'sftp',
    useTeleport: false,
};
const ftpBase = {
    ...base,
    mode: 'ftp',
    ftpHost: 'ftp.example.com',
    ftpUser: 'u',
    password: 'p',
    useTeleport: false,
};
describe('validateConfig', () => {
    it('passes with complete config', () => {
        (0, chai_1.expect)(() => (0, sync_1.validateConfig)(base)).to.not.throw();
        (0, chai_1.expect)(() => (0, sync_1.validateConfig)(sftpBase)).to.not.throw();
        (0, chai_1.expect)(() => (0, sync_1.validateConfig)(ftpBase)).to.not.throw();
    });
    it('throws for missing required fields', () => {
        const incomplete = { ...sftpBase, sftpHost: undefined };
        (0, chai_1.expect)(() => (0, sync_1.validateConfig)(incomplete)).to.throw(/sftpHost/);
    });
});
describe('saveConfiguration', () => {
    it('writes all GUI fields to workspace settings.json', async () => {
        const context = { secrets: { store: async () => undefined } };
        const config = {
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
        vscode._reset();
        await (0, config_1.saveConfiguration)(context, config);
        const updates = vscode._updates;
        (0, chai_1.expect)(updates.every(u => u.global === false)).to.be.true;
        const byKey = new Map(updates.map(u => [u.key, u.value]));
        (0, chai_1.expect)(byKey.get('mode')).to.equal('sftp');
        (0, chai_1.expect)(byKey.get('sftpHost')).to.equal('sftp.example.com');
        (0, chai_1.expect)(byKey.get('sftpUser')).to.equal('u');
        (0, chai_1.expect)(byKey.get('remotePath')).to.equal('/home/u/project');
        (0, chai_1.expect)(byKey.get('localPath')).to.equal('/local/project');
        (0, chai_1.expect)(byKey.get('identity')).to.equal('~/.ssh/id');
        (0, chai_1.expect)(byKey.get('sshFlags')).to.equal('-p 2222');
        (0, chai_1.expect)(byKey.get('rsyncFlags')).to.equal('--exclude .git');
        (0, chai_1.expect)(byKey.get('debounceMs')).to.equal(300);
        (0, chai_1.expect)(byKey.get('useTeleport')).to.equal(false);
    });
});
describe('deleteConfiguration', () => {
    it('removes only the selected mode settings', async () => {
        const context = { secrets: { delete: async () => undefined } };
        vscode._reset();
        await (0, config_1.deleteConfiguration)(context, 'sftp');
        const updates = vscode._updates;
        (0, chai_1.expect)(updates.every(u => u.global === false && u.value === undefined)).to.be.true;
        const keys = new Set(updates.map(u => u.key));
        (0, chai_1.expect)(keys.has('sftpHost')).to.be.true;
        (0, chai_1.expect)(keys.has('useRsync')).to.be.true;
        (0, chai_1.expect)(keys.has('ftpHost')).to.be.false;
    });
});
describe('resolveMode', () => {
    it('returns explicit mode', () => {
        (0, chai_1.expect)((0, config_1.resolveMode)({ mode: 'ftp' })).to.equal('ftp');
        (0, chai_1.expect)((0, config_1.resolveMode)({ mode: 'sftp' })).to.equal('sftp');
        (0, chai_1.expect)((0, config_1.resolveMode)({ mode: 'teleport' })).to.equal('teleport');
    });
    it('defaults to teleport when not disabled', () => {
        (0, chai_1.expect)((0, config_1.resolveMode)({})).to.equal('teleport');
        (0, chai_1.expect)((0, config_1.resolveMode)({ useTeleport: true })).to.equal('teleport');
        (0, chai_1.expect)((0, config_1.resolveMode)({ useTeleport: undefined })).to.equal('teleport');
    });
    it('falls back to sftp when teleport disabled', () => {
        (0, chai_1.expect)((0, config_1.resolveMode)({ useTeleport: false })).to.equal('sftp');
    });
});
describe('getConfiguration', () => {
    it('loads resolved config from workspace settings', () => {
        const values = vscode._values;
        values['mode'] = 'ftp';
        values['ftpHost'] = 'ftp.example.com';
        values['ftpUser'] = 'u';
        values['ftpPort'] = 21;
        const config = (0, config_1.getConfiguration)();
        (0, chai_1.expect)(config.mode).to.equal('ftp');
        (0, chai_1.expect)(config.ftpHost).to.equal('ftp.example.com');
        (0, chai_1.expect)(config.sftpPort).to.equal(22);
        (0, chai_1.expect)(config.concurrency).to.equal(4);
    });
});
describe('getPassword', () => {
    it('returns stored password', async () => {
        const context = { secrets: { get: async (key) => key === 'sftpPluggin.password' ? 'secret' : undefined } };
        const password = await (0, config_1.getPassword)(context);
        (0, chai_1.expect)(password).to.equal('secret');
    });
    it('returns undefined when no password stored', async () => {
        const context = { secrets: { get: async () => undefined } };
        const password = await (0, config_1.getPassword)(context);
        (0, chai_1.expect)(password).to.be.undefined;
    });
});
