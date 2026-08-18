"use strict";
const updates = [];
const vscodeMock = {
    _updates: updates,
    _reset: () => { updates.length = 0; },
    workspace: {
        getConfiguration: (_section) => ({
            get: (key, defaultValue) => defaultValue,
            update: (key, value, global) => {
                updates.push({ key, value, global });
                return Promise.resolve();
            },
            inspect: () => undefined
        })
    },
    window: {},
    env: {}
};
module.exports = vscodeMock;
