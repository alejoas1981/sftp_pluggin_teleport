import { expect } from 'chai';
import * as vscode from 'vscode';
import { initializeConfiguration, saveConfiguration, updateTransferButtonVisibility } from '../config';

describe('transfer button visibility', () => {
    for (const mode of ['ftp', 'sftp', 'teleport'] as const) {
        it(`uses saved ${mode} preferences immediately and after initialization`, async () => {
            const contexts = new Map<string, unknown>(),
                state = new Map<string, unknown>(),
                registration = vscode.commands.registerCommand('setContext', (key, value) => contexts.set(key, value)),
                context = {
                    workspaceState: {
                        get: (key: string) => state.get(key),
                        update: async (key: string, value: unknown) => { state.set(key, value); }
                    }
                } as unknown as vscode.ExtensionContext;
            try {
                await saveConfiguration(context, { mode, showUploadButton: true, showDownloadButton: false });
                expect(contexts.get('sftpPluggin.showUploadButton')).to.equal(true);
                expect(contexts.get('sftpPluggin.showDownloadButton')).to.equal(false);
                contexts.clear();
                initializeConfiguration(context);
                expect(contexts.get('sftpPluggin.showUploadButton')).to.equal(true);
                await saveConfiguration(context, { mode, showUploadButton: false, showDownloadButton: true });
                expect(contexts.get('sftpPluggin.showUploadButton')).to.equal(false);
                expect(contexts.get('sftpPluggin.showDownloadButton')).to.equal(true);
            } finally {
                registration.dispose();
            }
        });
    }

    it('uses legacy settings when no private configuration exists', () => {
        const contexts = new Map<string, unknown>(),
            registration = vscode.commands.registerCommand('setContext', (key, value) => contexts.set(key, value));
        try {
            initializeConfiguration({ workspaceState: { get: () => undefined } } as unknown as vscode.ExtensionContext);
            (vscode as any)._values.showUploadButton = true;
            (vscode as any)._values.showDownloadButton = true;
            updateTransferButtonVisibility();
            expect(contexts.get('sftpPluggin.showUploadButton')).to.equal(true);
            expect(contexts.get('sftpPluggin.showDownloadButton')).to.equal(true);
        } finally {
            registration.dispose();
            (vscode as any)._reset();
        }
    });
});
