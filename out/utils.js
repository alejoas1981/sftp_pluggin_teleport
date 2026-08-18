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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizeRemotePath = normalizeRemotePath;
exports.joinRemote = joinRemote;
exports.joinLocal = joinLocal;
exports.isIgnored = isIgnored;
exports.ensureLocalDir = ensureLocalDir;
exports.resolveKeyValue = resolveKeyValue;
exports.resolvePrivateKey = resolvePrivateKey;
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
const path = __importStar(require("path"));
const ignore_1 = __importDefault(require("ignore"));
function normalizeRemotePath(p) {
    const normalized = path.posix.normalize(p || '.');
    if (normalized === '/' || normalized === '.') {
        return normalized;
    }
    return normalized.replace(/\/+$/, '');
}
function joinRemote(...segments) {
    return normalizeRemotePath(path.posix.join(...segments));
}
function joinLocal(...segments) {
    return path.normalize(path.join(...segments));
}
function isIgnored(rel, patterns) {
    return (0, ignore_1.default)().add(patterns).ignores(rel);
}
function ensureLocalDir(localPath) {
    fs.mkdirSync(path.dirname(localPath), { recursive: true });
}
function resolveKeyValue(value) {
    if (!value) {
        return undefined;
    }
    if (value.startsWith('~')) {
        return path.join(os.homedir(), value.slice(1).replace(/^\//, ''));
    }
    return value;
}
function resolvePrivateKey(value) {
    const resolved = resolveKeyValue(value);
    if (!resolved) {
        return undefined;
    }
    if (resolved.includes('-----BEGIN')) {
        return resolved;
    }
    if (fs.existsSync(resolved)) {
        return fs.readFileSync(resolved);
    }
    return resolved;
}
