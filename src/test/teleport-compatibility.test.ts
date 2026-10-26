import { expect } from 'chai';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as childProcess from 'child_process';
import { configureStorage } from '../private-storage';
// @ts-ignore
import { loadSync } from '../../test/proxyquire-helper.cjs';

describe('Teleport compatibility with private cache and concurrent scanning', () => {
    let local: string, storage: string, teleport: any, loggedIn: boolean, failTransfer: boolean,
        activeListings: number, peakListings: number;
    const remote = new Map<string, string>(), directories = new Set<string>(), calls: Array<{ command: string; args: string[] }> = [],
        config = () => ({ mode: 'teleport', teleportHost: 'proxy.example.test', teleportUser: 'login-user',
            teleportCluster: 'cluster-one', sftpHost: 'node', sftpUser: 'deploy', remotePath: '/remote', localPath: local,
            concurrency: 2, scanConcurrency: 3, rsyncFlags: '--bwlimit=1000' });

    beforeEach(() => {
        local = fs.mkdtempSync(path.join(os.tmpdir(), 'teleport-project-'));
        storage = fs.mkdtempSync(path.join(os.tmpdir(), 'teleport-state-'));
        configureStorage(storage);
        remote.clear(); directories.clear(); directories.add('/remote'); calls.length = 0;
        loggedIn = true; failTransfer = false; activeListings = 0; peakListings = 0;
        const spawn = (command: string, args: string[]) => {
            const child: any = new EventEmitter();
            child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
            calls.push({ command, args });
            const operation = args[args.length - 1], listing = command === 'tsh' && operation.startsWith('find ');
            if (listing) { activeListings++; peakListings = Math.max(peakListings, activeListings); }
            setTimeout(() => {
                let output = '', failure = '';
                if (command === 'tsh') {
                    if (args[0] === 'status') { output = loggedIn ? 'Logged in' : 'not logged in'; }
                    else if (args[0] === 'login') { loggedIn = true; output = 'https://proxy.example.test/login'; }
                    else if (listing) {
                        const directory = operation.match(/^find '([^']+)'/)![1];
                        for (const file of [...directories, ...remote.keys()]) {
                            if (file !== directory && path.posix.dirname(file) === directory) {
                                output += [path.posix.basename(file), Buffer.byteLength(remote.get(file) ?? ''), '1700000000', directories.has(file) ? 'd' : 'f'].join('\0') + '\0';
                            }
                        }
                    } else if (operation.includes("stat -c")) {
                        const file = operation.match(/ -- '([^']+)'/)![1];
                        if (remote.has(file)) { output = `${Buffer.byteLength(remote.get(file)!)} 1700000000 regular file`; }
                        else if (directories.has(file)) { output = '0 1700000000 directory'; }
                        else { failure = `cannot stat '${file}': No such file or directory`; }
                    } else if (operation.startsWith('mkdir -p ')) {
                        directories.add(operation.match(/^mkdir -p '([^']+)'/)![1]);
                    } else if (operation.startsWith('rm -f ')) {
                        remote.delete(operation.match(/^rm -f '([^']+)'/)![1]);
                    } else { output = 'ok'; }
                } else if (command === 'rsync') {
                    const [source, destination] = args.slice(-2);
                    if (failTransfer) { failure = 'rsync connection lost'; }
                    else if (source.startsWith('deploy@node:')) {
                        fs.writeFileSync(destination, remote.get(source.match(/:'([^']+)'$/)![1])!);
                    } else {
                        remote.set(destination.match(/:'([^']+)'$/)![1], fs.readFileSync(source, 'utf8'));
                    }
                }
                if (listing) { activeListings--; }
                if (output) { child.stdout.emit('data', Buffer.from(output)); }
                if (failure) { child.stderr.emit('data', Buffer.from(failure)); }
                child.emit('close', failure ? 1 : 0);
            }, listing ? 15 : 1);
            return child;
        };
        teleport = loadSync({ './teleport-installer': { ensureTsh: async () => 'tsh' },
            'child_process': { ...childProcess, spawn } });
    });
    afterEach(() => {
        fs.rmSync(local, { recursive: true, force: true });
        fs.rmSync(storage, { recursive: true, force: true });
    });

    it('uploads and downloads through rsync with the selected cluster and bandwidth limit', async () => {
        fs.writeFileSync(path.join(local, 'upload.txt'), 'local');
        remote.set('/remote/download.txt', 'server');
        await teleport.runSync(config());
        expect(remote.get('/remote/upload.txt')).to.equal('local');
        expect(fs.readFileSync(path.join(local, 'download.txt'), 'utf8')).to.equal('server');
        const transfers = calls.filter((call) => call.command === 'rsync');
        expect(transfers).to.have.length(2);
        for (const call of transfers) {
            expect(call.args).to.include('--bwlimit=1000');
            expect(call.args[call.args.indexOf('-e') + 1]).to.include("--cluster='cluster-one'");
            expect(call.args).not.to.include('--delete');
        }
        for (const call of calls.filter((call) => call.command === 'tsh' && call.args[0] === 'ssh')) {
            expect(call.args).to.include.members(['--cluster', 'cluster-one', 'deploy@node']);
        }
        expect(fs.existsSync(path.join(local, '.sftp-sync'))).to.equal(false);
    });

    it('reuses a plan and scans directories concurrently on subsequent previews', async () => {
        for (let i = 0; i < 6; i++) { directories.add(`/remote/dir${i}`); remote.set(`/remote/dir${i}/file`, 'remote'); }
        await teleport.runSync(config(), { dryRun: true });
        expect(peakListings).to.equal(3);
        const listings = calls.filter((call) => call.args[call.args.length - 1]?.startsWith('find ')).length;
        await teleport.runSync(config());
        expect(calls.filter((call) => call.args[call.args.length - 1]?.startsWith('find '))).to.have.length(listings);
        expect(fs.readdirSync(local)).to.have.length(6);
        const logs: string[] = [];
        await teleport.runSync(config(), { dryRun: true, onLog: (line: string) => logs.push(line) });
        expect(logs.join('')).to.include('6 cached, 0 hashed');
    });

    it('renews a missing session using the configured proxy, user and cluster', async () => {
        loggedIn = false;
        await teleport.runSync(config(), { dryRun: true });
        const login = calls.find((call) => call.args[0] === 'login')!;
        expect(login.args).to.include.members(['--proxy=proxy.example.test', '--user=login-user', 'cluster-one']);
    });

    it('keeps browser login links and explicit remote deletion available', async () => {
        const links: string[] = [];
        await teleport.loginToTeleport(config(), { onLink: (url: string) => links.push(url) });
        expect(links).to.deep.equal(['https://proxy.example.test/login']);
        remote.set('/remote/deleted.txt', 'remote');
        await teleport.deleteRemoteFile(config(), path.join(local, 'deleted.txt'));
        expect(remote.has('/remote/deleted.txt')).to.equal(false);
    });

    it('propagates rsync failure without replacing an existing local file', async () => {
        const file = path.join(local, 'download.txt');
        fs.writeFileSync(file, 'old');
        fs.utimesSync(file, new Date(1600000000000), new Date(1600000000000));
        remote.set('/remote/download.txt', 'new server version');
        failTransfer = true;
        let error: any;
        try { await teleport.runSync(config()); } catch (caught) { error = caught; }
        expect(error.message).to.include('rsync connection lost');
        expect(fs.readFileSync(file, 'utf8')).to.equal('old');
    });
    it('uploads the selected edit with legacy exclusions and no full remote listing', async () => {
        fs.writeFileSync(path.join(local, 'edited.txt'), 'edit');
        fs.writeFileSync(path.join(local, '.DS_Store'), 'ignored');
        fs.writeFileSync(path.join(local, '.env'), 'ignored');
        fs.writeFileSync(path.join(local, 'unrelated.txt'), 'unrelated');
        await teleport.uploadChangedFiles({ ...config(), rsyncFlags: "--exclude .git --exclude .vscode --exclude .windsurfrules --exclude node_modules --exclude .DS_Store --exclude '*.log' --exclude .env --exclude vendor --exclude debugbar --exclude cache" },
            { files: ['edited.txt', '.DS_Store', '.env'] });
        expect([...remote.keys()]).to.deep.equal(['/remote/edited.txt']);
        expect(calls.filter((call) => call.command === 'rsync')).to.have.length(1);
        expect(calls.some((call) => call.args[call.args.length - 1]?.startsWith('find '))).to.equal(false);
    });

    it('rejects unsupported rsync options before connecting or transferring', async () => {
        let failure: any;
        try { await teleport.uploadChangedFiles({ ...config(), rsyncFlags: '--delete' }, { files: ['edited.txt'] }); }
        catch (error) { failure = error; }
        expect(failure.message).to.include('Unsupported Extra Rsync Flags');
        expect(calls).to.have.length(0);
    });

});
