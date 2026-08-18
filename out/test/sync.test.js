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
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
const path = __importStar(require("path"));
const sync_1 = require("../sync");
class FakeClient {
    constructor() {
        this.mkdirs = [];
        this.uploads = [];
        this.downloads = [];
        this.deletes = [];
        this.lists = new Map();
        this.closed = false;
    }
    async test() { return; }
    async list(remoteDir) {
        return this.lists.get(remoteDir) || [];
    }
    async stat(_remotePath) {
        return undefined;
    }
    async put(localPath, remotePath) {
        this.uploads.push({ local: localPath, remote: remotePath });
    }
    async get(remotePath, localPath) {
        this.downloads.push({ remote: remotePath, local: localPath });
    }
    async mkdir(remotePath) {
        this.mkdirs.push(remotePath);
    }
    async delete(remotePath) {
        this.deletes.push(remotePath);
    }
    async close() {
        this.closed = true;
    }
}
function buildConfig(localRoot, remoteRoot = '/remote') {
    return {
        mode: 'sftp',
        sftpHost: 'h',
        sftpUser: 'u',
        localPath: localRoot,
        remotePath: remoteRoot,
        concurrency: 4,
        ignore: [],
    };
}
describe('SyncEngine', () => {
    let localRoot;
    beforeEach(() => {
        localRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sftp-test-'));
    });
    afterEach(() => {
        fs.rmSync(localRoot, { recursive: true, force: true });
    });
    it('uploads new files and creates directories', async () => {
        fs.writeFileSync(path.join(localRoot, 'a.txt'), 'a');
        fs.mkdirSync(path.join(localRoot, 'dir'));
        fs.writeFileSync(path.join(localRoot, 'dir', 'b.txt'), 'b');
        const client = new FakeClient();
        const config = buildConfig(localRoot);
        const result = await new sync_1.SyncEngine(config).sync(client, {});
        (0, chai_1.expect)(result).to.include('SYNC COMPLETE');
        (0, chai_1.expect)(client.mkdirs).to.include('/remote');
        (0, chai_1.expect)(client.mkdirs).to.include('/remote/dir');
        (0, chai_1.expect)(client.uploads).to.have.length(2);
        const uploaded = client.uploads.map((u) => u.remote);
        (0, chai_1.expect)(uploaded).to.include('/remote/a.txt');
        (0, chai_1.expect)(uploaded).to.include('/remote/dir/b.txt');
    });
    it('deletes remote files missing locally', async () => {
        const client = new FakeClient();
        client.lists.set('/remote', [{ name: 'old.txt', size: 1, modifyTime: 0, isDirectory: false }]);
        const config = buildConfig(localRoot);
        const result = await new sync_1.SyncEngine(config).sync(client, {});
        (0, chai_1.expect)(result).to.include('SYNC COMPLETE');
        (0, chai_1.expect)(client.deletes).to.include('/remote/old.txt');
        (0, chai_1.expect)(client.uploads).to.have.length(0);
    });
    it('skips unchanged files', async () => {
        const filePath = path.join(localRoot, 'same.txt');
        fs.writeFileSync(filePath, 'same');
        const localStat = fs.statSync(filePath);
        const client = new FakeClient();
        client.lists.set('/remote', [{
                name: 'same.txt',
                size: localStat.size,
                modifyTime: localStat.mtimeMs,
                isDirectory: false,
            }]);
        const config = buildConfig(localRoot);
        await new sync_1.SyncEngine(config).sync(client, {});
        (0, chai_1.expect)(client.uploads).to.have.length(0);
        (0, chai_1.expect)(client.deletes).to.have.length(0);
    });
    it('dry run does not execute transfers', async () => {
        fs.writeFileSync(path.join(localRoot, 'a.txt'), 'a');
        const client = new FakeClient();
        const config = buildConfig(localRoot);
        const result = await new sync_1.SyncEngine(config).sync(client, { dryRun: true });
        (0, chai_1.expect)(result).to.include('DRY RUN');
        (0, chai_1.expect)(client.uploads).to.have.length(0);
        (0, chai_1.expect)(client.deletes).to.have.length(0);
    });
    it('emits onProgress for each executed action', async () => {
        fs.writeFileSync(path.join(localRoot, 'a.txt'), 'a');
        fs.mkdirSync(path.join(localRoot, 'dir'));
        fs.writeFileSync(path.join(localRoot, 'dir', 'b.txt'), 'b');
        const client = new FakeClient();
        const config = buildConfig(localRoot);
        const events = [];
        const result = await new sync_1.SyncEngine(config).sync(client, {
            onProgress: (current, total, file, action) => events.push({ current, total, file, action }),
        });
        (0, chai_1.expect)(result).to.include('SYNC COMPLETE');
        (0, chai_1.expect)(events).to.have.length(3);
        (0, chai_1.expect)(events.some((e) => e.current === 3 && e.total === 3)).to.be.true;
    });
});
