import { expect } from 'chai';
import { createStatusBar, updateSftpStatus, startLoading, stopLoading } from '../status';

describe('status', () => {
    afterEach(() => {
        stopLoading();
    });

    it('createStatusBar initializes the status bar item', () => {
        const context: any = { subscriptions: [] };
        createStatusBar(context);

        const items = (require('vscode') as any)._statusBarItems;
        const item = items[items.length - 1];

        expect(item.text).to.equal('SFTP');
        expect(item.tooltip).to.equal('SFTP Plugin - click to open configuration');
        expect(item.command).to.equal('sftpPluggin.openConfig');
        expect(item.shown).to.be.true;
        expect(context.subscriptions).to.include(item);
    });

    it('updateSftpStatus sets text and strips icon for tooltip', () => {
        const context: any = { subscriptions: [] };
        createStatusBar(context);
        updateSftpStatus('$(sync) uploading file.txt');

        const items = (require('vscode') as any)._statusBarItems;
        const item = items[items.length - 1];

        expect(item.text).to.equal('$(sync) uploading file.txt');
        expect(item.tooltip).to.equal('uploading file.txt');
    });

    it('startLoading animates progress and stopLoading resets it', async () => {
        const context: any = { subscriptions: [] };
        createStatusBar(context);

        startLoading();

        const items = (require('vscode') as any)._statusBarItems;
        const item = items[items.length - 1];

        expect(item.text).to.equal('$(sync) ░░░░░░░░░░ 0%');

        await new Promise((resolve) => setTimeout(resolve, 120));
        expect(item.text).to.equal('$(sync) ░░░░░░░░░░ 1%');

        stopLoading();
        expect(item.text).to.equal('$(check) SFTP: ready');
    });
});
