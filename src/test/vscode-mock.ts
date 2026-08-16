const updates: { key: string; value: any; global: boolean }[] = [];

const vscodeMock = {
    _updates: updates,
    _reset: () => { updates.length = 0; },
    workspace: {
        getConfiguration: (_section: string) => ({
            get: (key: string, defaultValue?: any) => defaultValue,
            update: (key: string, value: any, global: boolean) => {
                updates.push({ key, value, global });
                return Promise.resolve();
            },
            inspect: () => undefined
        })
    },
    window: {},
    env: {}
};

export = vscodeMock;
