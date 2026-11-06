import { expect } from 'chai';
import { EventEmitter } from 'events';
// @ts-ignore
import { loadSync } from '../../test/proxyquire-helper.cjs';

describe('Teleport certificate confirmation', () => {
    const config = { mode: 'teleport', teleportHost: 'proxy.test:3080', teleportUser: 'alice' };
    /** Creates a tsh process that waits for a certificate trust response. */
    function loginHarness() {
        const child: any = new EventEmitter(), responses: string[] = [], calls: string[][] = [];
        child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.exitCode = null;
        child.kill = () => { child.exitCode = 1; setImmediate(() => child.emit('close', 1)); };
        child.stdin = { write: (response: string) => {
            responses.push(response); child.exitCode = 0; setImmediate(() => child.emit('close', 0));
        } };
        const sync = loadSync({ child_process: { spawn: (_command: string, args: string[]) => {
            calls.push(args);
            setImmediate(() => {
                child.stderr.emit('data', Buffer.from('Unknown certificate fingerprint ABC. Are you sure [y/'));
                child.stderr.emit('data', Buffer.from('N]: '));
            });
            return child;
        } }, './teleport-installer': { ensureTsh: async () => 'tsh' } });
        return { sync, responses, calls };
    }
    it('answers only after explicit approval and handles split prompts', async () => {
        const harness = loginHarness();
        let confirmations = 0;
        await harness.sync.loginToTeleport(config, { onConfirmTrust: async (prompt: string) => {
            confirmations++; expect(prompt).to.include('fingerprint ABC'); expect(harness.responses).to.have.length(0);
            return true;
        } });
        expect(confirmations).to.equal(1); expect(harness.responses).to.deep.equal(['yes\n']);
        expect(harness.calls[0]).not.to.include('--insecure');
    });
    it('stops when trust is declined or no confirmation handler exists', async () => {
        for (const options of [{}, { onConfirmTrust: async () => false }]) {
            const harness = loginHarness(), failure = await harness.sync.loginToTeleport(config, options).catch((error: Error) => error);
            expect(failure.message).to.include('confirmation'); expect(harness.responses).to.have.length(0);
        }
    });
});
