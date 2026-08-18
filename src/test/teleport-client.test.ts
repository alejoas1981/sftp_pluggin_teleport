import { expect } from 'chai';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SftpConfig } from '../config';
import { TeleportClient } from '../teleport-client';

function buildConfig(): SftpConfig {
    return {
        mode: 'teleport',
        teleportHost: 'proxy.example.com:3080',
        teleportUser: 'dev',
        teleportCluster: 'main',
        sftpHost: 'node.example.com',
        sftpUser: 'ec2-user',
        sftpPort: 22,
        remotePath: '/home/ec2-user/project',
        localPath: '/local/project',
    };
}

describe('TeleportClient', () => {
    it('test runs echo ok via tsh ssh', async () => {
        const calls: string[][] = [];
        const fakeTsh = async (args: string[]): Promise<string> => {
            calls.push(args);
            return '';
        };
        const client = new TeleportClient(buildConfig(), '/tsh/tsh.exe', fakeTsh);

        await client.test();

        expect(calls).to.have.length(1);
        expect(calls[0]).to.include('ssh');
        expect(calls[0]).to.include('echo ok');
    });

    it('mkdir issues mkdir -p command', async () => {
        const calls: string[][] = [];
        const fakeTsh = async (args: string[]): Promise<string> => {
            calls.push(args);
            return '';
        };
        const client = new TeleportClient(buildConfig(), '/tsh/tsh.exe', fakeTsh);

        await client.mkdir('/home/ec2-user/project/sub');

        expect(calls[0]).to.include('ssh');
        expect(calls[0]).to.include("mkdir -p '/home/ec2-user/project/sub'");
    });

    it('delete issues rm -f command', async () => {
        const calls: string[][] = [];
        const fakeTsh = async (args: string[]): Promise<string> => {
            calls.push(args);
            return '';
        };
        const client = new TeleportClient(buildConfig(), '/tsh/tsh.exe', fakeTsh);

        await client.delete('/home/ec2-user/project/file.txt');

        expect(calls[0]).to.include('ssh');
        expect(calls[0]).to.include("rm -f '/home/ec2-user/project/file.txt'");
    });

    it('put uses tsh scp with the remote spec', async () => {
        const calls: string[][] = [];
        const fakeTsh = async (args: string[]): Promise<string> => {
            calls.push(args);
            return '';
        };
        const client = new TeleportClient(buildConfig(), '/tsh/tsh.exe', fakeTsh);

        await client.put('/local/a.txt', '/home/ec2-user/project/a.txt');

        expect(calls[0]).to.include('scp');
        expect(calls[0]).to.include('/local/a.txt');
        expect(calls[0]).to.include('ec2-user@node.example.com:/home/ec2-user/project/a.txt');
    });

    it('get uses tsh scp with the remote spec', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsh-get-'));
        const dest = path.join(dir, 'nested', 'a.txt');
        const calls: string[][] = [];
        const fakeTsh = async (args: string[]): Promise<string> => {
            calls.push(args);
            return '';
        };
        const client = new TeleportClient(buildConfig(), '/tsh/tsh.exe', fakeTsh);

        await client.get('/home/ec2-user/project/a.txt', dest);

        expect(fs.existsSync(path.dirname(dest))).to.be.true;
        expect(calls[0]).to.include('scp');
        expect(calls[0]).to.include('ec2-user@node.example.com:/home/ec2-user/project/a.txt');
        expect(calls[0]).to.include(dest);
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('list parses tab-separated find output', async () => {
        const fakeTsh = async (): Promise<string> => {
            return [
                "a.txt\t12\t1690000000.0000000000\tf",
                "sub\t0\t1690000000.0\td",
                "",
            ].join('\n');
        };
        const client = new TeleportClient(buildConfig(), '/tsh/tsh.exe', fakeTsh);

        const items = await client.list('/home/ec2-user/project');

        expect(items).to.have.length(2);
        expect(items[0].name).to.equal('a.txt');
        expect(items[0].size).to.equal(12);
        expect(items[0].isDirectory).to.be.false;
        expect(items[1].name).to.equal('sub');
        expect(items[1].isDirectory).to.be.true;
    });

    it('stat parses stat -c output for a file', async () => {
        const fakeTsh = async (): Promise<string> => '12 1690000000 regular file\n';
        const client = new TeleportClient(buildConfig(), '/tsh/tsh.exe', fakeTsh);

        const item = await client.stat('/home/ec2-user/project/a.txt');

        expect(item).to.exist;
        expect(item!.size).to.equal(12);
        expect(item!.modifyTime).to.equal(1690000000000);
        expect(item!.isDirectory).to.be.false;
    });

    it('stat returns undefined when tsh command fails', async () => {
        const fakeTsh = async (): Promise<string> => { throw new Error('No such file'); };
        const client = new TeleportClient(buildConfig(), '/tsh/tsh.exe', fakeTsh);

        const item = await client.stat('/home/ec2-user/project/missing.txt');

        expect(item).to.be.undefined;
    });
});
